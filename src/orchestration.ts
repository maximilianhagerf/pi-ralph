import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readConfig } from "./config";
import { execOk, execRaw } from "./exec";
import { assertCleanTree, cleanIntegrationTree, dirtyStatusIgnoringWorktrees, ensureGhAuth, ensureIntegrationWorktree, ensureWorkerWorktree, getDiffSnapshot, getRepoInfo, gitStatus, integrationCwd, revParse } from "./git";
import { blockedIssueSummary, blockedSummary, fetchPrdAndChildren, refreshIssueStates, runnableIssues } from "./issues";
import { assertBranchFresh, cleanupRalphWorktrees, closeCompletedIssues, commitIntegrationChanges, commitWorkerChanges, enqueueMerge, markIssueMerged, mergeWorkerIntoIntegration, pushCurrentBranch, unmergedPaths } from "./merge";
import { applyDefaultSubagentParams, buildConflictResolverTask, buildFixerTask, buildPrdVerifierTask, buildSpawnPrompt, buildWorkerTask, ensureSubagentTool, sendSpawnPrompt, verifierTools } from "./spawn";
import { activeRunningEntries, assertV2State, getRunningIssue, loadStateForRepo, normalizeRunning, processedResultKeys, remainingIssues, removeRunningIssue, renderState, runningEntries, saveState, setRunningIssue } from "./state";
import {
	COMPACT_TOKENS,
	DEFAULT_MAX_CONFLICT_RESOLVER_ATTEMPTS,
	DEFAULT_MAX_PROVIDER_RETRIES,
	DEFAULT_MAX_VERIFIER_FIX_ATTEMPTS,
	HARD_STOP_TOKENS,
	VERSION,
	WARN_TOKENS,
	type CheckResult,
	type RalphState,
	type RalphSubagentSpec,
} from "./types";
import { cap, emit, messageText, notify, nowIso } from "./utils";
import { formatCheckResult, runFullCheck } from "./checks";
import { changedFiles, createRunId, defaultWorktreeBase, integrationBranch, validateExistingWorktree } from "./git";
import type { WorktreeState } from "./types";

let mergeDrainInFlight = false;

export function parseWorkerStatus(summary: string): "success" | "blocked" | "failed" | "unknown" {
	const match = summary.match(/^\s*Status\s*:\s*(success|succeeded|complete|completed|done|pass|passed|blocked|failed|failure)\b/im);
	if (!match) return "unknown";
	const raw = match[1].toLowerCase();
	if (["success", "succeeded", "complete", "completed", "done", "pass", "passed"].includes(raw)) return "success";
	if (raw === "blocked") return "blocked";
	return "failed";
}

export function stripSubagentWrapper(content: string) {
	return content
		.replace(/^Sub-agent "Ralph[^"]*" completed \([^)]*\)\.\n\n/, "")
		.replace(/^Sub-agent "Ralph[^"]*" failed \(exit code \d+\)\.\n\n/, "")
		.replace(/\n\nSession: .+\nResume: .+$/s, "")
		.trim();
}

export async function assertSameRunContext(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState): Promise<import("./types").RepoInfo> {
	const repo = await getRepoInfo(pi, ctx);
	if (repo.repoRoot !== state.repoRoot) throw new Error(`Ralph ledger is for ${state.repoRoot}, current repo is ${repo.repoRoot}`);
	if (repo.branch !== state.branch) throw new Error(`Ralph ledger is for branch ${state.branch}, current branch is ${repo.branch}`);
	return repo;
}

export async function ensureContextBudget(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, config: import("./types").RalphConfig) {
	const usage = ctx.getContextUsage();
	const tokens = usage?.tokens;
	if (!tokens) return true;

	const warn = config.contextWarnTokens ?? WARN_TOKENS;
	const compact = config.contextCompactTokens ?? COMPACT_TOKENS;
	const hard = config.contextHardStopTokens ?? HARD_STOP_TOKENS;

	if (tokens >= hard) {
		state.active = false;
		state.stopReason = `Context ${tokens} tokens >= hard stop ${hard}. Run /compact, then /ralph-resume.`;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}`);
		return false;
	}

	if (tokens >= compact) {
		state.stopReason = `Context ${tokens} tokens >= compact threshold ${compact}. Compacting before next spawn.`;
		await saveState(pi, state);
		emit(pi, state.stopReason);
		ctx.compact({
			customInstructions:
				"Preserve Ralph run state only as compact facts. Full Ralph ledger lives in .git/ralph/state.json. Keep latest worker result summary and next issue if present.",
			onComplete: () => {
				pi.sendUserMessage(`/ralph-resume ${state.mode}`);
			},
			onError: async (error) => {
				state.active = false;
				state.stopReason = `Compaction failed: ${error.message}. Run /compact manually, then /ralph-resume.`;
				await saveState(pi, state);
				emit(pi, `Ralph stopped. ${state.stopReason}`);
			},
		});
		return false;
	}

	if (tokens >= warn) notify(ctx, `Ralph context warning: ${tokens} tokens`, "warning");
	return true;
}

export async function loadCurrentState(pi: ExtensionAPI, ctx: ExtensionContext) {
	const repo = await getRepoInfo(pi, ctx);
	const state = await loadStateForRepo(repo);
	return { repo, state };
}

export async function launchNext(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, options: { retrySpawning?: boolean; defer?: boolean } = {}) {
	assertV2State(state);
	const config = await readConfig();
	await assertSameRunContext(pi, ctx, state);
	ensureSubagentTool(pi);
	await ensureGhAuth(pi, ctx);
	await ensureIntegrationWorktree(pi, ctx, state);

	if (!(await ensureContextBudget(pi, ctx, state, config))) return;
	if (!state.active) return;
	if (state.conflict || state.fixer || (state.verifier && ["spawning", "running"].includes(state.verifier.status))) return;
	if ((state.mergeQueue ?? []).length > 0) {
		await drainMergeQueue(pi, ctx);
		return;
	}

	const currentSnapshot = await getDiffSnapshot(pi, ctx, state.integration.path);
	await refreshIssueStates(pi, ctx, state);
	normalizeRunning(state);
	const running = activeRunningEntries(state);
	const completedCount = Object.keys(state.completed).length;
	const remaining = remainingIssues(state);
	if (remaining.length === 0 && running.length === 0) {
		await beginFinalVerification(pi, ctx, state);
		return;
	}
	if (completedCount >= state.maxIterations && running.length === 0) {
		await stopV2WithCheck(pi, ctx, state, `Reached max iterations (${state.maxIterations}).`);
		return;
	}
	const maxConcurrent = config.maxConcurrent ?? 3;
	const newCapacity = Math.min(
		Math.max(0, state.maxIterations - completedCount - running.length),
		Math.max(0, maxConcurrent - running.length),
	);

	const retryIssues = options.retrySpawning
		? running.filter((issue) => issue.status === "spawning" && !issue.sessionFile)
		: [];
	const newIssues = newCapacity > 0 ? runnableIssues(state).slice(0, newCapacity) : [];
	const spawnIssues = [...retryIssues, ...newIssues];

	if (spawnIssues.length === 0) {
		if (running.length > 0) {
			state.active = true;
			state.stopReason = undefined;
			await saveState(pi, state);
			return;
		}
		const remaining = remainingIssues(state);
		if (remaining.length > 0) {
			state.active = false;
			state.stopReason = `No runnable PRD-linked issues. ${blockedIssueSummary(state) || "Check Blocked by sections."}`;
			await saveState(pi, state);
			emit(pi, `Ralph stopped. ${state.stopReason}`);
			return;
		}
		await beginFinalVerification(pi, ctx, state);
		return;
	}

	state.active = true;
	state.stopReason = undefined;
	state.readyToFinish = false;
	const paramsList: Record<string, unknown>[] = [];
	for (const issue of spawnIssues) {
		const issueInfo = "body" in issue ? issue : state.issues[String(issue.number)];
		if (!issueInfo) continue;
		const runningIssue = await ensureWorkerWorktree(pi, ctx, state, issueInfo, currentSnapshot);
		runningIssue.status = "spawning";
		setRunningIssue(state, runningIssue);
		const task = await buildWorkerTask(pi, ctx, state, issueInfo, runningIssue, config);
		runningIssue.task = task;
		setRunningIssue(state, runningIssue);
		const params: Record<string, unknown> = {
			name: `Ralph #${issueInfo.number}`,
			agent: config.workerAgent ?? "ralph-worker",
			cwd: runningIssue.cwd ?? runningIssue.worktreePath,
			interactive: false,
			task,
		};
		applyDefaultSubagentParams(params, config.workerModel, config.workerTools, config.workerSkills);
		paramsList.push(params);
	}
	await saveState(pi, state);

	const labels = paramsList.map((params) => String(params.name).replace("Ralph ", "")).join(", ");
	emit(pi, paramsList.length === 1 ? `Ralph launching ${labels}.` : `Ralph launching ${labels} in parallel.`);
	const prompt = buildSpawnPrompt(paramsList.length === 1 ? paramsList[0] : paramsList);
	sendSpawnPrompt(pi, ctx, prompt, options.defer);
}

export async function stopV2WithCheck(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, reason: string) {
	assertV2State(state);
	const config = await readConfig();
	const check = await runFullCheck(pi, ctx, state.integration.path, config);
	state.finalCheck = check;
	state.active = false;
	state.finishedAt = nowIso();
	state.stopReason = check.ok ? reason : `${reason} Final check failed.`;
	await saveState(pi, state);
	emit(pi, `${state.stopReason}\n\n${formatCheckResult(check)}${blockedSummary(state)}`);
}

export async function startRun(pi: ExtensionAPI, ctx: ExtensionContext, prdNumber: number, maxIterations: number, mode: import("./types").RalphMode, autoFinish?: boolean) {
	const repo = await getRepoInfo(pi, ctx);
	await ensureGhAuth(pi, ctx);
	ensureSubagentTool(pi);

	const existing = await loadStateForRepo(repo);
	if (existing) {
		if (existing.version !== VERSION) {
			throw new Error("Legacy Ralph v1 ledger detected. No automatic migration. Use /ralph-status, /ralph-finish, or /ralph-clear first.");
		}
		if (existing.prd.number !== prdNumber) {
			throw new Error(`Ralph ledger is for PRD #${existing.prd.number}, not #${prdNumber}. Use /ralph-clear first.`);
		}
		const config = await readConfig();
		const resolvedAutoFinish = autoFinish ?? config.autoFinish ?? true;
		if (existing.readyToFinish && existing.verifier?.status === "passed") {
			existing.autoFinish = resolvedAutoFinish;
			await saveState(pi, existing);
			if (resolvedAutoFinish) {
				emit(pi, `Ralph PRD #${existing.prd.number} already verified. Auto-finishing.`);
				await handleFinish(pi, ctx);
			} else {
				emit(pi, `Ralph PRD #${existing.prd.number} already ready to finish. Run /ralph-finish.`);
			}
			return;
		}
		const hasStartedWork = Object.keys(existing.completed).length > 0 || runningEntries(existing).length > 0 || existing.active;
		if (hasStartedWork) {
			existing.mode = mode;
			existing.maxIterations = maxIterations;
			existing.autoFinish = resolvedAutoFinish;
			existing.active = true;
			existing.stopReason = undefined;
			await saveState(pi, existing);
			emit(pi, `Ralph continuing PRD #${existing.prd.number}.`);
			await launchNext(pi, ctx, existing, { retrySpawning: true });
			return;
		}
	}

	await assertCleanTree(pi, ctx, repo.repoRoot, "Coordinator checkout");
	const { prd, issueOrder, issues } = await fetchPrdAndChildren(pi, ctx, repo.repo, prdNumber);
	issues[String(prd.number)] = prd;
	const config = await readConfig();
	const resolvedAutoFinish = autoFinish ?? config.autoFinish ?? true;
	const runId = createRunId(prdNumber, repo.head);
	const worktreeBase = defaultWorktreeBase(repo, runId, config);
	const integration: WorktreeState = {
		path: join(worktreeBase, "integration"),
		branch: integrationBranch(runId),
		createdAt: nowIso(),
	};
	const snapshot = await getDiffSnapshot(pi, ctx, repo.repoRoot);
	const state: RalphState = {
		version: VERSION,
		active: true,
		mode,
		maxIterations,
		autoFinish: resolvedAutoFinish,
		startedAt: nowIso(),
		updatedAt: nowIso(),
		cwd: ctx.cwd,
		repoRoot: repo.repoRoot,
		gitDir: repo.gitDir,
		commonGitDir: repo.commonGitDir,
		repo: repo.repo,
		branch: repo.branch,
		originalHead: repo.head,
		runId,
		worktreeBase,
		integration,
		prd: { number: prd.number, title: prd.title, url: prd.url },
		issueOrder,
		issues,
		completed: {},
		mergeQueue: [],
		pendingResults: {},
		baselineSnapshot: snapshot,
		lastSnapshot: snapshot,
	};
	await ensureIntegrationWorktree(pi, ctx, state);
	state.baselineSnapshot = await getDiffSnapshot(pi, ctx, state.integration!.path);
	state.lastSnapshot = state.baselineSnapshot;
	await saveState(pi, state);

	const openChildren = issueOrder.filter((n) => issues[String(n)]?.state !== "CLOSED");
	emit(
		pi,
		[
			`Ralph v2 started: PRD #${prd.number} ${prd.title}`,
			`Run: ${runId}`,
			`Mode: ${mode}, max: ${maxIterations}`,
			`Integration: ${integration.branch} @ ${integration.path}`,
			`Child issue order: ${issueOrder.map((n) => `#${n}`).join(", ")}`,
			`Open children: ${openChildren.length ? openChildren.map((n) => `#${n}`).join(", ") : "none"}`,
		].join("\n"),
	);

	if (openChildren.length === 0) {
		state.active = false;
		state.stopReason = "No open PRD-linked child issues.";
		await saveState(pi, state);
		emit(pi, state.stopReason);
		return;
	}

	await launchNext(pi, ctx, state);
}

export async function processWorkerResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any, issueNumber: number) {
	const details = message.details ?? {};
	const { state } = await loadCurrentState(pi, ctx);
	if (!state) return;
	if (state.version !== VERSION) {
		state.active = false;
		state.stopReason = "Legacy v1 worker result arrived after Ralph v2 upgrade. No automatic migration; use /ralph-status, /ralph-finish, or /ralph-clear.";
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}\n\n${cap(messageText(message))}`);
		return;
	}
	assertV2State(state);
	const running = getRunningIssue(state, issueNumber);
	if (!running || (running.status !== "running" && running.status !== "failed")) return;
	// Retries get a new session from the platform; skip session-file guard when the previous attempt failed.
	if (running.status === "running" && running.sessionFile && running.sessionFile !== details.sessionFile) return;

	const key = `${details.sessionFile ?? "no-session"}:${issueNumber}:${details.elapsed ?? ""}`;
	if (processedResultKeys.has(key)) return;
	processedResultKeys.add(key);

	const content = stripSubagentWrapper(messageText(message));
	const summary = cap(content);
	state.lastResultSummary = summary;
	running.sessionFile = details.sessionFile;
	setRunningIssue(state, running);

	const exitCode = Number(details.exitCode ?? 0);
	const providerError = typeof details.errorMessage === "string" && details.errorMessage.trim();
	const workerStatus = parseWorkerStatus(content);

	if (providerError) {
		await retryProviderError(pi, ctx, state, { kind: "worker", issueNumber }, `Worker #${issueNumber} provider error: ${details.errorMessage}`);
		return;
	}
	state.providerRetries = 0;

	if (exitCode !== 0 || workerStatus !== "success") {
		// "blocked" = the worker genuinely can't proceed (needs a human). In AFK we never halt the
		// whole run on a blocker (the PRD decides HITL up front): record it, skip the issue, keep
		// going; the final report lists every blocker. A real crash (failed/nonzero/unknown) gets a
		// bounded re-spawn, and only becomes "blocked" once retries are exhausted.
		const recordBlocked = async (reason: string) => {
			state.blocked ??= {};
			state.blocked[String(issueNumber)] = reason;
			removeRunningIssue(state, issueNumber);
			if (!state.active) state.active = true;
			state.stopReason = undefined;
			await saveState(pi, state);
			emit(pi, `Worker #${issueNumber} blocked — skipping and continuing. ${reason}`);
			await maybeContinueAfterSettled(pi, ctx, state);
		};

		if (workerStatus === "blocked") {
			const reason = summary.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" ").slice(0, 400) || "(no reason given)";
			await recordBlocked(reason);
			return;
		}

		const why = exitCode !== 0 ? `exited ${exitCode}` : workerStatus === "unknown" ? "missing required Status: success" : `reported ${workerStatus}`;
		const tries = state.workerRetries?.[String(issueNumber)] ?? 0;
		if (state.active && tries < state.maxIterations && running.worktreePath) {
			state.workerRetries ??= {};
			state.workerRetries[String(issueNumber)] = tries + 1;
			await cleanIntegrationTree(pi, ctx, running.worktreePath);
			running.status = "spawning";
			running.sessionFile = undefined;
			setRunningIssue(state, running);
			state.stopReason = undefined;
			await saveState(pi, state);
			emit(pi, `Worker #${issueNumber} ${why}; re-spawning (attempt ${tries + 1}/${state.maxIterations}).`);
			await launchNext(pi, ctx, state, { retrySpawning: true });
			return;
		}
		await recordBlocked(`Worker ${why}; crash retries exhausted (${tries}/${state.maxIterations}).`);
		return;
	}

	// Retry arrived as success: reactivate if the prior failure stopped Ralph.
	if (!state.active) {
		state.active = true;
		state.stopReason = undefined;
	}

	if (!running.worktreePath || !running.branch) {
		state.active = false;
		state.stopReason = `Worker #${issueNumber} missing worktree metadata.`;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}`);
		return;
	}

	state.pendingResults ??= {};
	state.pendingResults[String(issueNumber)] = {
		number: issueNumber,
		title: running.title,
		receivedAt: nowIso(),
		sessionFile: details.sessionFile,
		elapsed: details.elapsed,
		summary,
		workerBranch: running.branch,
		workerWorktreePath: running.worktreePath,
		baseHead: running.baseHead,
		changedFiles: [],
		diffStat: "",
	};
	running.status = "pending-merge";
	setRunningIssue(state, running);
	enqueueMerge(state, issueNumber);
	await saveState(pi, state);
	emit(pi, `Ralph queued #${issueNumber} for integration merge.`);
	await drainMergeQueue(pi, ctx);
}

export async function drainMergeQueue(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (mergeDrainInFlight) return;
	mergeDrainInFlight = true;
	let currentState: RalphState | undefined;
	try {
		const { state } = await loadCurrentState(pi, ctx);
		currentState = state ?? undefined;
		if (!state || state.version !== VERSION) return;
		assertV2State(state);
		if (state.conflict || state.fixer || (state.verifier && ["spawning", "running"].includes(state.verifier.status))) return;
		await ensureIntegrationWorktree(pi, ctx, state);

		while ((state.mergeQueue ?? []).length > 0) {
			const issueNumber = state.mergeQueue![0];
			const pending = state.pendingResults?.[String(issueNumber)];
			if (!pending) {
				state.mergeQueue!.shift();
				await saveState(pi, state);
				continue;
			}
			const running = getRunningIssue(state, issueNumber);
			if (running) {
				running.status = "merging";
				setRunningIssue(state, running);
			}
			await saveState(pi, state);

			const commit = await commitWorkerChanges(pi, ctx, state, pending);
			pending.changedFiles = commit.changedFiles;
			pending.diffStat = commit.diffStat;
			pending.workerCommit = commit.commit;
			state.pendingResults![String(issueNumber)] = pending;

			const merge = await mergeWorkerIntoIntegration(pi, ctx, state, pending);
			if (merge.conflict) {
				const conflicts = await unmergedPaths(pi, ctx, state.integration.path);
				state.conflict = {
					issueNumber,
					branch: pending.workerBranch,
					worktreePath: state.integration.path,
					attempt: 0,
					status: "spawning",
					startedAt: nowIso(),
					preMergeHead: merge.preMergeHead,
					workerCommit: pending.workerCommit,
					conflictPaths: conflicts,
				};
				if (running) {
					running.status = "conflict";
					setRunningIssue(state, running);
				}
				await saveState(pi, state);
				if (!state.active) {
					emit(pi, `Ralph stopped with pending merge conflict on #${issueNumber}. Run /ralph-resume to launch resolver.\n\nConflicts:\n${conflicts.map((path) => `- ${path}`).join("\n")}`);
					return;
				}
				emit(pi, `Ralph merge conflict on #${issueNumber}. Launching resolver.\n\nConflicts:\n${conflicts.map((path) => `- ${path}`).join("\n")}`);
				await launchConflictResolver(pi, ctx, state, conflicts, merge.output);
				return;
			}

			await markIssueMerged(pi, ctx, state, issueNumber, pending, merge.mergeCommit);
			state.integration.head = merge.mergeCommit;
			await saveState(pi, state);
			emit(
				pi,
				[
					`Ralph merged #${issueNumber} into integration.`,
					pending.changedFiles.length ? `Changed files:\n${pending.changedFiles.map((f) => `- ${f}`).join("\n")}` : "Changed files: none",
					pending.diffStat ? `Diffstat:\n${pending.diffStat}` : undefined,
				].filter(Boolean).join("\n\n"),
			);
		}

		await saveState(pi, state);
		await maybeContinueAfterSettled(pi, ctx, state);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (currentState) {
			currentState.active = false;
			currentState.stopReason = `Merge queue error: ${message}`;
			const issueNumber = currentState.mergeQueue?.[0];
			if (issueNumber) {
				const running = getRunningIssue(currentState, issueNumber);
				if (running) {
					running.status = "failed";
					setRunningIssue(currentState, running);
				}
			}
			await saveState(pi, currentState);
		}
		emit(pi, `Ralph merge queue error: ${message}`);
	} finally {
		mergeDrainInFlight = false;
	}
}

export async function prepareConflictRetry(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	assertV2State(state);
	if (!state.conflict?.preMergeHead || !state.conflict.workerCommit) throw new Error("Conflict retry missing pre-merge head or worker commit.");
	const mergeHead = await execRaw(pi, ctx, "git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], 20_000, state.integration.path);
	if (mergeHead.code === 0) await execRaw(pi, ctx, "git", ["merge", "--abort"], 60_000, state.integration.path).catch(() => undefined);
	await execOk(pi, ctx, "git", ["reset", "--hard", state.conflict.preMergeHead], 60_000, state.integration.path);
	const replay = await execRaw(pi, ctx, "git", ["merge", "--no-ff", "--no-edit", state.conflict.workerCommit], 120_000, state.integration.path);
	const conflicts = await unmergedPaths(pi, ctx, state.integration.path);
	if (replay.code === 0 || conflicts.length === 0) throw new Error(`Conflict replay for #${state.conflict.issueNumber} did not recreate conflicts; manual recovery needed.`);
	state.conflict.conflictPaths = conflicts;
	await saveState(pi, state);
	return conflicts;
}

export async function launchConflictResolver(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, conflicts?: string[], output?: string) {
	assertV2State(state);
	const config = await readConfig();
	const maxAttempts = config.maxConflictResolverAttempts ?? DEFAULT_MAX_CONFLICT_RESOLVER_ATTEMPTS;
	if (!state.conflict) return;
	if (state.conflict.attempt >= maxAttempts) {
		state.active = false;
		state.conflict.status = "failed";
		state.stopReason = `Conflict resolver attempts exhausted for #${state.conflict.issueNumber}.`;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}`);
		return;
	}
	state.conflict.attempt += 1;
	state.conflict.status = "spawning";
	state.conflict.startedAt = nowIso();
	const actualConflicts = conflicts ?? await unmergedPaths(pi, ctx, state.integration.path);
	const task = buildConflictResolverTask(state, state.conflict.issueNumber, actualConflicts, output);
	state.conflict.task = task;
	await saveState(pi, state);
	const params: Record<string, unknown> = {
		name: `Ralph conflict #${state.conflict.issueNumber}`,
		agent: config.conflictResolverAgent ?? "ralph-conflict-resolver",
		cwd: integrationCwd(state),
		interactive: false,
		task,
	};
	applyDefaultSubagentParams(
		params,
		config.conflictResolverModel,
		config.conflictResolverTools ?? "read,bash,edit,write,grep,find,ls",
		config.conflictResolverSkills,
	);
	emit(pi, `Ralph launching conflict resolver for #${state.conflict.issueNumber} (attempt ${state.conflict.attempt}/${maxAttempts}).`);
	sendSpawnPrompt(pi, ctx, buildSpawnPrompt(params), true);
}

export async function retryOrStopConflict(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, reason: string) {
	const config = await readConfig();
	const maxAttempts = config.maxConflictResolverAttempts ?? DEFAULT_MAX_CONFLICT_RESOLVER_ATTEMPTS;
	if (state.active && state.conflict && state.conflict.attempt < maxAttempts) {
		emit(pi, `${reason}\nRetrying conflict resolver.`);
		try {
			const conflicts = await prepareConflictRetry(pi, ctx, state);
			await launchConflictResolver(pi, ctx, state, conflicts);
			return;
		} catch (error) {
			reason = `Conflict retry preparation failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	state.active = false;
	state.stopReason = reason;
	if (state.conflict) state.conflict.status = "failed";
	await saveState(pi, state);
	emit(pi, `Ralph stopped. ${reason}`);
}

export async function processConflictResolverResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any, issueNumber: number) {
	const details = message.details ?? {};
	const { state } = await loadCurrentState(pi, ctx);
	if (!state || state.version !== VERSION || !state.conflict || state.conflict.issueNumber !== issueNumber) return;
	assertV2State(state);
	if (state.conflict.status !== "running") return;
	if (state.conflict.sessionFile && state.conflict.sessionFile !== details.sessionFile) return;
	const key = `${details.sessionFile ?? "no-session"}:conflict:${issueNumber}:${details.elapsed ?? ""}`;
	if (processedResultKeys.has(key)) return;
	processedResultKeys.add(key);
	const content = stripSubagentWrapper(messageText(message));
	const summary = cap(content);
	state.conflict.lastSummary = summary;
	state.conflict.sessionFile = details.sessionFile;
	const exitCode = Number(details.exitCode ?? 0);
	const providerError = typeof details.errorMessage === "string" && details.errorMessage.trim();
	const status = parseWorkerStatus(content);
	if (providerError) {
		await retryProviderError(pi, ctx, state, { kind: "conflict", issueNumber }, `Conflict resolver provider error: ${details.errorMessage}`);
		return;
	}
	state.providerRetries = 0;
	if (exitCode !== 0 || status !== "success") {
		await retryOrStopConflict(pi, ctx, state, `Conflict resolver failed for #${issueNumber}.\n\n${summary}`);
		return;
	}
	const pending = state.pendingResults?.[String(issueNumber)];
	if (!pending) throw new Error(`Missing pending worker result for conflict #${issueNumber}.`);
	const mergeHead = await execRaw(pi, ctx, "git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], 20_000, state.integration.path);
	if (mergeHead.code !== 0) {
		await retryOrStopConflict(pi, ctx, state, `Conflict resolver ended with no active merge for #${issueNumber}.`);
		return;
	}
	if (state.conflict.workerCommit && mergeHead.stdout.trim() !== state.conflict.workerCommit) {
		await retryOrStopConflict(pi, ctx, state, `Conflict MERGE_HEAD ${mergeHead.stdout.trim()} != worker commit ${state.conflict.workerCommit}.`);
		return;
	}
	await execOk(pi, ctx, "git", ["add", "-A"], 120_000, state.integration.path);
	const unresolved = await unmergedPaths(pi, ctx, state.integration.path);
	if (unresolved.length > 0) {
		await retryOrStopConflict(pi, ctx, state, `Conflict resolver left unmerged paths for #${issueNumber}: ${unresolved.join(", ")}`);
		return;
	}
	const markerFiles = await execRaw(pi, ctx, "git", ["grep", "--cached", "-l", "^<<<<<<< "], 30_000, state.integration.path);
	if (markerFiles.code === 0 && markerFiles.stdout.trim()) {
		await retryOrStopConflict(pi, ctx, state, `Conflict resolver left conflict markers in: ${markerFiles.stdout.trim().split("\n").join(", ")}`);
		return;
	}
	const changed = await changedFiles(pi, ctx, state.integration.path);
	const allowed = new Set([...(pending.changedFiles ?? []), ...(state.conflict.conflictPaths ?? [])]);
	const extra = changed.filter((path) => !allowed.has(path));
	if (extra.length > 0) {
		await retryOrStopConflict(pi, ctx, state, `Conflict resolver changed paths outside worker/conflict scope: ${extra.join(", ")}`);
		return;
	}
	const stagedCheck = await execRaw(pi, ctx, "git", ["diff", "--cached", "--check"], 60_000, state.integration.path);
	if (stagedCheck.code !== 0) {
		await retryOrStopConflict(pi, ctx, state, `Conflict resolver staged diff check errors:\n${cap([stagedCheck.stderr, stagedCheck.stdout].join("\n"), 4_000)}`);
		return;
	}
	await execOk(pi, ctx, "git", ["commit", "--no-edit"], 120_000, state.integration.path);
	const mergeCommit = await revParse(pi, ctx, state.integration.path);
	await markIssueMerged(pi, ctx, state, issueNumber, pending, mergeCommit);
	state.integration.head = mergeCommit;
	delete state.conflict;
	await saveState(pi, state);
	emit(pi, `Ralph resolved and merged #${issueNumber}.\n\n${summary}`);
	await drainMergeQueue(pi, ctx);
}

export async function maybeContinueAfterSettled(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	assertV2State(state);
	if (state.conflict || state.fixer || (state.verifier && ["spawning", "running"].includes(state.verifier.status))) return;
	if ((state.mergeQueue ?? []).length > 0) {
		await drainMergeQueue(pi, ctx);
		return;
	}
	if (!state.active) return;
	if (activeRunningEntries(state).length > 0) return;

	if (state.mode === "once") {
		state.active = false;
		state.stopReason = "Completed one issue.";
		await saveState(pi, state);
		emit(pi, state.stopReason);
		return;
	}

	await refreshIssueStates(pi, ctx, state);
	const remaining = remainingIssues(state);
	if (Object.keys(state.completed).length >= state.maxIterations && remaining.length > 0) {
		await stopV2WithCheck(pi, ctx, state, `Reached max iterations (${state.maxIterations}).`);
		return;
	}
	if (remaining.length === 0) {
		await beginFinalVerification(pi, ctx, state);
		return;
	}

	if (state.mode === "hitl") {
		const candidates = runnableIssues(state);
		if (candidates.length > 0) {
			if (!ctx.hasUI) {
				state.active = false;
				state.stopReason = "HITL mode requires UI before next issue.";
				await saveState(pi, state);
				emit(pi, `Ralph stopped. ${state.stopReason}`);
				return;
			}
			const label = candidates.length === 1
				? `Next: #${candidates[0].number} ${candidates[0].title}`
				: `Next parallel batch: ${candidates.map((issue) => `#${issue.number}`).join(", ")}`;
			let choice: string | undefined;
			while (true) {
				choice = await ctx.ui.select(label, ["continue", "stop", "check", "status"]);
				if (choice === "status") {
					emit(pi, renderState(state));
					continue;
				}
				if (choice === "check") {
					const check = await runFullCheck(pi, ctx, state.integration.path, await readConfig());
					emit(pi, formatCheckResult(check));
					if (!check.ok) {
						state.active = false;
						state.stopReason = "Check failed in HITL prompt.";
						await saveState(pi, state);
						return;
					}
					continue;
				}
				break;
			}
			if (choice !== "continue") {
				state.active = false;
				state.stopReason = "Stopped by user.";
				await saveState(pi, state);
				emit(pi, state.stopReason);
				return;
			}
		}
	}

	await launchNext(pi, ctx, state, { defer: true });
}

export async function beginFinalVerification(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	assertV2State(state);
	await ensureIntegrationWorktree(pi, ctx, state);
	if (!state.active) return;
	if (activeRunningEntries(state).length > 0 || (state.mergeQueue ?? []).length > 0 || state.conflict || state.fixer) return;
	if ((await gitStatus(pi, ctx, state.integration.path)).trim()) {
		const stillDirty = await cleanIntegrationTree(pi, ctx, state.integration.path);
		if (stillDirty) {
			state.active = false;
			state.stopReason = `Integration worktree still has uncommitted changes after auto-clean. Resolve manually, then /ralph-resume.\n${stillDirty}`;
			await saveState(pi, state);
			emit(pi, `Ralph stopped. ${state.stopReason}`);
			return;
		}
	}
	const config = await readConfig();
	const check = await runFullCheck(pi, ctx, state.integration.path, config);
	state.finalCheck = check;
	state.readyToFinish = false;
	const stillDirty = await cleanIntegrationTree(pi, ctx, state.integration.path);
	if (stillDirty) {
		state.active = false;
		state.stopReason = `Full check dirtied integration worktree and auto-clean could not resolve it. Clean manually or adjust check command.\n${stillDirty}`;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}`);
		return;
	}
	await saveState(pi, state);
	if (!check.ok) {
		await launchFixerOrStop(pi, ctx, state, `Full check failed before PRD verification.\n\n${formatCheckResult(check)}`, check);
		return;
	}
	await launchPrdVerifier(pi, ctx, state, check);
}

export async function launchPrdVerifier(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, check: CheckResult) {
	assertV2State(state);
	const config = await readConfig();
	state.verifier = {
		status: "spawning",
		attempts: (state.verifier?.attempts ?? 0) + 1,
		startedAt: nowIso(),
		head: await revParse(pi, ctx, state.integration.path),
		check,
	};
	state.verifier.task = buildPrdVerifierTask(state, check);
	state.active = true;
	state.stopReason = undefined;
	await saveState(pi, state);
	const params: Record<string, unknown> = {
		name: "Ralph verifier",
		agent: config.prdVerifierAgent ?? "ralph-prd-verifier",
		cwd: integrationCwd(state),
		interactive: false,
		task: state.verifier.task,
	};
	applyDefaultSubagentParams(
		params,
		config.prdVerifierModel,
		verifierTools(config),
		config.prdVerifierSkills,
	);
	emit(pi, `Ralph launching PRD verifier (attempt ${state.verifier.attempts}).`);
	sendSpawnPrompt(pi, ctx, buildSpawnPrompt(params), true);
}

export async function processPrdVerifierResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any) {
	const details = message.details ?? {};
	const { state } = await loadCurrentState(pi, ctx);
	if (!state || state.version !== VERSION || !state.verifier) return;
	assertV2State(state);
	if (state.verifier.status !== "running") return;
	if (state.verifier.sessionFile && state.verifier.sessionFile !== details.sessionFile) return;
	const verifierHead = await revParse(pi, ctx, state.integration.path);
	if (state.verifier.head && verifierHead !== state.verifier.head) return;
	const key = `${details.sessionFile ?? "no-session"}:verifier:${details.elapsed ?? ""}`;
	if (processedResultKeys.has(key)) return;
	processedResultKeys.add(key);
	const content = stripSubagentWrapper(messageText(message));
	const summary = cap(content);
	state.verifier.sessionFile = details.sessionFile;
	state.verifier.summary = summary;
	state.verifier.completedAt = nowIso();
	const exitCode = Number(details.exitCode ?? 0);
	const providerError = typeof details.errorMessage === "string" && details.errorMessage.trim();
	const status = parseWorkerStatus(content);
	if (providerError) {
		await retryProviderError(pi, ctx, state, { kind: "verifier" }, `PRD verifier provider error: ${details.errorMessage}`);
		return;
	}
	state.providerRetries = 0;
	if ((await gitStatus(pi, ctx, state.integration.path)).trim()) {
		// Verifier is read-only, but a stray build artifact can still dirty the tree. Auto-clean
		// and keep going rather than stalling; only stop if cleaning genuinely fails.
		const stillDirty = await cleanIntegrationTree(pi, ctx, state.integration.path);
		if (stillDirty) {
			state.active = false;
			state.verifier.status = "failed";
			state.stopReason = `Verifier dirtied integration worktree and auto-clean could not resolve it.\n${stillDirty}`;
			await saveState(pi, state);
			emit(pi, `Ralph stopped. ${state.stopReason}`);
			return;
		}
	}
	if (exitCode === 0 && status === "success") {
		state.verifier.status = "passed";
		state.verifier.verifiedHead = verifierHead;
		state.verifiedHead = verifierHead;
		state.readyToFinish = true;
		state.active = false;
		if (state.autoFinish !== false) {
			state.stopReason = "PRD verifier passed. Auto-finishing.";
			await saveState(pi, state);
			emit(pi, `${state.stopReason}\n\n${summary}${blockedSummary(state)}`);
			await handleFinish(pi, ctx);
		} else {
			state.stopReason = "All issues merged and PRD verifier passed. Run /ralph-finish to export, push, and close issues.";
			await saveState(pi, state);
			emit(pi, `${state.stopReason}\n\n${summary}${blockedSummary(state)}`);
		}
		return;
	}
	state.verifier.status = "failed";
	if (exitCode !== 0 || status === "unknown") {
		// Verifier CRASHED (nonzero exit or malformed output) — not a real "found gaps" result.
		// Keep the loop alive: re-launch the verifier, bounded by maxIterations.
		const crashReason = exitCode !== 0
			? `PRD verifier exited ${exitCode}.`
			: `PRD verifier result missing required Status: passed|failed.`;
		if (state.active && (state.verifier.attempts ?? 0) < state.maxIterations) {
			await saveState(pi, state);
			emit(pi, `${crashReason} Re-launching verifier (attempt ${(state.verifier.attempts ?? 0) + 1}/${state.maxIterations}).`);
			await launchPrdVerifier(pi, ctx, state, state.verifier.check ?? state.finalCheck ?? { ok: true, noCommand: true });
			return;
		}
		state.active = false;
		state.stopReason = `${crashReason} Verifier crash retries exhausted (${state.verifier.attempts ?? 0}/${state.maxIterations}). Run /ralph-resume to continue.\n\n${summary}`;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}`);
		return;
	}
	await saveState(pi, state);
	await launchFixerOrStop(pi, ctx, state, `PRD verifier failed.\n\n${summary}`, state.finalCheck);
}

export async function launchFixerOrStop(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, reason: string, check?: CheckResult) {
	assertV2State(state);
	const config = await readConfig();
	// AFK intent: keep fixing until the PRD verifier passes. The bound is maxIterations
	// (the master autonomy budget) unless the user pins an explicit cap in config.
	const maxAttempts = config.maxVerifierFixAttempts ?? state.maxIterations ?? DEFAULT_MAX_VERIFIER_FIX_ATTEMPTS;
	const attempts = state.verifierFixAttempts ?? 0;
	if (!state.active) {
		state.stopReason = reason;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${reason}`);
		return;
	}
	if (attempts >= maxAttempts) {
		state.active = false;
		state.stopReason = `${reason}\nVerifier fixer attempts exhausted (${attempts}/${maxAttempts}).`;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}\n\nDo NOT spawn any verifier, fixer, or other subagent. Take no further action. Run /ralph-resume to reset the budget and continue.`);
		return;
	}
	state.verifierFixAttempts = attempts + 1;
	state.fixer = {
		status: "spawning",
		attempt: state.verifierFixAttempts,
		startedAt: nowIso(),
		baseHead: await revParse(pi, ctx, state.integration.path),
	};
	state.fixer.task = buildFixerTask(state, reason, check);
	state.active = true;
	await saveState(pi, state);
	const params: Record<string, unknown> = {
		name: "Ralph fixer",
		agent: config.fixerAgent ?? "ralph-fixer",
		cwd: integrationCwd(state),
		interactive: false,
		task: state.fixer.task,
	};
	applyDefaultSubagentParams(
		params,
		config.fixerModel,
		config.fixerTools ?? "read,bash,edit,write,grep,find,ls",
		config.fixerSkills,
	);
	emit(pi, `Ralph launching verifier fixer (attempt ${state.fixer.attempt}/${maxAttempts}).`);
	sendSpawnPrompt(pi, ctx, buildSpawnPrompt(params), true);
}

// Re-spawn the current fixer reusing its stored task/attempt, WITHOUT consuming the
// verifier-fix budget. Used for transient provider/transport-error retries.
export async function respawnFixer(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	assertV2State(state);
	if (!state.fixer) return;
	const config = await readConfig();
	state.fixer.status = "spawning";
	state.fixer.sessionFile = undefined;
	state.fixer.startedAt = nowIso();
	state.fixer.baseHead = await revParse(pi, ctx, state.integration.path);
	state.active = true;
	await saveState(pi, state);
	const params: Record<string, unknown> = {
		name: "Ralph fixer",
		agent: config.fixerAgent ?? "ralph-fixer",
		cwd: integrationCwd(state),
		interactive: false,
		task: state.fixer.task,
	};
	applyDefaultSubagentParams(params, config.fixerModel, config.fixerTools ?? "read,bash,edit,write,grep,find,ls", config.fixerSkills);
	sendSpawnPrompt(pi, ctx, buildSpawnPrompt(params), true);
}

// A transient provider/transport error (WebSocket drop, "did not produce a result")
// is not a logical failure. Re-spawn the same step, bounded by maxProviderRetries, so
// AFK runs survive flaky connections without consuming fix/conflict budgets. The
// counter resets to 0 after any non-provider-error result (see the processors).
export async function retryProviderError(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphState,
	spec: { kind: "worker" | "conflict" | "verifier" | "fixer"; issueNumber?: number },
	terminalReason: string,
): Promise<void> {
	assertV2State(state);
	const config = await readConfig();
	const max = config.maxProviderRetries ?? DEFAULT_MAX_PROVIDER_RETRIES;
	const n = state.providerRetries ?? 0;
	if (!state.active || n >= max) {
		state.active = false;
		state.stopReason = `${terminalReason}\nProvider-error retries exhausted (${n}/${max}). Run /ralph-resume to continue.`;
		if (spec.kind === "worker") {
			const running = spec.issueNumber !== undefined ? getRunningIssue(state, spec.issueNumber) : undefined;
			if (running) {
				running.status = "failed";
				setRunningIssue(state, running);
			}
		} else if (spec.kind === "conflict" && state.conflict) state.conflict.status = "failed";
		else if (spec.kind === "verifier" && state.verifier) state.verifier.status = "failed";
		else if (spec.kind === "fixer" && state.fixer) state.fixer.status = "failed";
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}`);
		return;
	}
	state.providerRetries = n + 1;
	state.active = true;
	state.stopReason = undefined;
	await saveState(pi, state);
	emit(pi, `Transient provider error; retrying ${spec.kind}${spec.issueNumber !== undefined ? ` #${spec.issueNumber}` : ""} (${state.providerRetries}/${max}).`);
	try {
		if (spec.kind === "verifier") {
			await launchPrdVerifier(pi, ctx, state, state.verifier?.check ?? state.finalCheck ?? { ok: true, noCommand: true });
		} else if (spec.kind === "fixer") {
			await respawnFixer(pi, ctx, state);
		} else if (spec.kind === "conflict") {
			const conflicts = await prepareConflictRetry(pi, ctx, state);
			await launchConflictResolver(pi, ctx, state, conflicts);
		} else {
			const running = spec.issueNumber !== undefined ? getRunningIssue(state, spec.issueNumber) : undefined;
			if (running) {
				running.status = "spawning";
				running.sessionFile = undefined;
				setRunningIssue(state, running);
				await saveState(pi, state);
			}
			await launchNext(pi, ctx, state, { retrySpawning: true });
		}
	} catch (error) {
		state.active = false;
		state.stopReason = `${terminalReason}\nProvider-error retry failed: ${error instanceof Error ? error.message : String(error)}`;
		await saveState(pi, state);
		emit(pi, `Ralph stopped. ${state.stopReason}`);
	}
}

export async function processFixerResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any) {
	const details = message.details ?? {};
	const { state } = await loadCurrentState(pi, ctx);
	if (!state || state.version !== VERSION || !state.fixer) return;
	assertV2State(state);
	if (state.fixer.status !== "running") return;
	if (state.fixer.sessionFile && state.fixer.sessionFile !== details.sessionFile) return;
	const key = `${details.sessionFile ?? "no-session"}:fixer:${details.elapsed ?? ""}`;
	if (processedResultKeys.has(key)) return;
	processedResultKeys.add(key);
	const content = stripSubagentWrapper(messageText(message));
	const summary = cap(content);
	state.fixer.sessionFile = details.sessionFile;
	state.fixer.summary = summary;
	const exitCode = Number(details.exitCode ?? 0);
	const providerError = typeof details.errorMessage === "string" && details.errorMessage.trim();
	const status = parseWorkerStatus(content);
	if (providerError) {
		await retryProviderError(pi, ctx, state, { kind: "fixer" }, `Fixer provider error: ${details.errorMessage}`);
		return;
	}
	state.providerRetries = 0;
	// Any fixer failure (crash, stale HEAD, unmerged paths, diff errors) is recoverable: discard
	// the fixer's partial edits and re-enter the bounded fix loop instead of stopping. The bound
	// is verifierFixAttempts <= maxIterations inside launchFixerOrStop, which stands down cleanly
	// when exhausted. state.active stays true so launchFixerOrStop re-spawns.
	const refix = async (why: string) => {
		await cleanIntegrationTree(pi, ctx, state.integration.path);
		if (state.fixer) state.fixer.status = "failed";
		await saveState(pi, state);
		await launchFixerOrStop(pi, ctx, state, `${why}\n\n${summary}`, state.finalCheck);
	};
	if (exitCode !== 0 || status !== "success") {
		await refix("Fixer failed.");
		return;
	}
	await validateExistingWorktree(pi, ctx, state, state.integration.path, state.integration.branch);
	const currentHead = await revParse(pi, ctx, state.integration.path);
	if (state.fixer.baseHead && currentHead !== state.fixer.baseHead) {
		await refix(`Fixer stale result: integration HEAD ${currentHead} != fixer base ${state.fixer.baseHead}.`);
		return;
	}
	const unmerged = await unmergedPaths(pi, ctx, state.integration.path);
	if (unmerged.length > 0) {
		await refix(`Fixer left unmerged paths: ${unmerged.join(", ")}`);
		return;
	}
	const diffCheck = await execRaw(pi, ctx, "git", ["diff", "--check"], 60_000, state.integration.path);
	if (diffCheck.code !== 0) {
		await refix(`Fixer diff check failed:\n${cap([diffCheck.stderr, diffCheck.stdout].join("\n"), 4_000)}`);
		return;
	}
	const commit = await commitIntegrationChanges(pi, ctx, state.integration.path, `Ralph verifier fix attempt ${state.fixer.attempt}`);
	if (commit) {
		state.fixer.commit = commit;
		state.fixerCommits = [...(state.fixerCommits ?? []), commit];
	}
	delete state.fixer;
	state.readyToFinish = false;
	state.verifiedHead = undefined;
	await saveState(pi, state);
	emit(pi, `Ralph fixer completed${commit ? ` and committed ${commit.slice(0, 12)}` : " with no changes"}.\n\n${summary}`);
	await beginFinalVerification(pi, ctx, state);
}

export async function processWorkerPing(pi: ExtensionAPI, ctx: ExtensionContext, message: any, spec: RalphSubagentSpec) {
	const { state } = await loadCurrentState(pi, ctx);
	if (!state) return;
	if (state.version === VERSION && state.mode !== "hitl" && spec.kind === "worker") {
		// AFK never halts on a worker asking for help — no human is watching. Treat it like a
		// blocker: record, skip the issue, keep going. The final report surfaces it.
		state.blocked ??= {};
		state.blocked[String(spec.issueNumber)] = `Requested help: ${cap(messageText(message), 300).replace(/\n+/g, " ").trim()}`;
		removeRunningIssue(state, spec.issueNumber);
		state.stopReason = undefined;
		await saveState(pi, state);
		emit(pi, `Worker #${spec.issueNumber} requested help; AFK skipping and continuing.`);
		await maybeContinueAfterSettled(pi, ctx, state);
		return;
	}
	state.active = false;
	if (spec.kind === "worker") {
		const running = getRunningIssue(state, spec.issueNumber);
		if (running) {
			running.sessionFile = message.details?.sessionFile;
			running.status = "failed";
			setRunningIssue(state, running);
		}
		state.stopReason = `Worker #${spec.issueNumber} requested help.`;
	} else if (spec.kind === "conflict") {
		if (state.conflict) {
			state.conflict.sessionFile = message.details?.sessionFile;
			state.conflict.status = "failed";
		}
		state.stopReason = `Conflict resolver for #${spec.issueNumber} requested help.`;
	} else if (spec.kind === "verifier") {
		if (state.verifier) {
			state.verifier.sessionFile = message.details?.sessionFile;
			state.verifier.status = "failed";
		}
		state.stopReason = "PRD verifier requested help.";
	} else {
		if (state.fixer) {
			state.fixer.sessionFile = message.details?.sessionFile;
			state.fixer.status = "failed";
		}
		state.stopReason = "Verifier fixer requested help.";
	}
	await saveState(pi, state);
	emit(pi, `Ralph stopped. ${state.stopReason}\n\n${cap(messageText(message))}`);
}

export async function handleResume(pi: ExtensionAPI, ctx: ExtensionContext, args: string) {
	const modeArg = args.trim().toLowerCase();
	const repo = await getRepoInfo(pi, ctx);
	const state = await loadStateForRepo(repo);
	if (!state) throw new Error("No Ralph ledger. Start with /ralph or /ralph-start.");
	if (state.version !== VERSION) throw new Error("Legacy Ralph v1 ledger cannot resume. Use /ralph-status, /ralph-finish, or /ralph-clear.");
	assertV2State(state);
	await assertSameRunContext(pi, ctx, state);
	if (modeArg === "hitl" || modeArg === "afk") state.mode = modeArg;
	if (state.readyToFinish && state.verifier?.status === "passed") {
		if (state.autoFinish !== false) {
			emit(pi, "Ralph already verified. Auto-finishing.");
			await handleFinish(pi, ctx);
		} else {
			emit(pi, "Ralph already ready to finish. Run /ralph-finish.");
		}
		return;
	}
	state.active = true;
	state.stopReason = undefined;
	// Explicit resume is the AFK safety-valve reset: clear attempt counters so the
	// verifier-fix, conflict-resolver, and provider-error retry loops get a fresh budget.
	state.verifierFixAttempts = 0;
	state.providerRetries = 0;
	// Resume is the safety-valve reset: clear blockers + crash-retry counts so skipped issues get
	// another attempt and the loop resumes with a fresh budget.
	state.blocked = {};
	state.workerRetries = {};
	if (state.conflict) state.conflict.attempt = 0;
	await saveState(pi, state);

	if (state.conflict) {
		if (state.conflict.status === "running") {
			emit(pi, `Ralph conflict resolver already running for #${state.conflict.issueNumber}.`);
			return;
		}
		await launchConflictResolver(pi, ctx, state);
		return;
	}
	if (state.fixer) {
		if (state.fixer.status === "running") {
			emit(pi, "Ralph fixer already running.");
			return;
		}
		delete state.fixer;
		await saveState(pi, state);
		await beginFinalVerification(pi, ctx, state);
		return;
	}
	if (state.verifier) {
		if (state.verifier.status === "running") {
			emit(pi, "Ralph verifier already running.");
			return;
		}
		if (state.verifier.status === "spawning") {
			delete state.verifier;
			await saveState(pi, state);
			await beginFinalVerification(pi, ctx, state);
			return;
		}
		if (state.verifier.status === "failed") {
			await launchFixerOrStop(pi, ctx, state, `PRD verifier failed.\n\n${state.verifier.summary ?? "(no summary)"}`, state.finalCheck);
			return;
		}
	}
	if ((state.mergeQueue ?? []).length > 0) {
		await drainMergeQueue(pi, ctx);
		return;
	}
	const running = activeRunningEntries(state);
	if (running.some((issue) => issue.status === "running")) {
		emit(pi, `Ralph already has running workers: ${running.map((issue) => `#${issue.number}`).join(", ")}`);
		return;
	}
	await launchNext(pi, ctx, state, { retrySpawning: true });
}

async function assertPushed(pi: ExtensionAPI, ctx: ExtensionContext) {
	let upstream: string;
	try {
		upstream = await execOk(pi, ctx, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 10_000);
	} catch {
		throw new Error("No upstream branch. Push/set upstream before /ralph-finish.");
	}
	const aheadRaw = await execOk(pi, ctx, "git", ["rev-list", "--count", `${upstream}..HEAD`], 20_000);
	const ahead = Number(aheadRaw.trim() || "0");
	if (ahead > 0) throw new Error(`Branch has ${ahead} unpushed commit(s). Push before /ralph-finish.`);
}

async function handleLegacyFinish(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	await assertSameRunContext(pi, ctx, state);
	await assertCleanTree(pi, ctx);
	await assertPushed(pi, ctx);
	const repo = await getRepoInfo(pi, ctx);
	const config = await readConfig();
	const check = await runFullCheck(pi, ctx, repo.repoRoot, config);
	state.finalCheck = check;
	if (check.noCommand && !ctx.hasUI) throw new Error("No check command configured; refusing non-interactive /ralph-finish.");
	if (check.noCommand && ctx.hasUI) {
		const ok = await ctx.ui.confirm("No check command configured", "Continue closing completed issues anyway?");
		if (!ok) return;
	}
	if (!check.ok) {
		state.stopReason = "ralph-finish check failed.";
		await saveState(pi, state);
		emit(pi, `Ralph finish refused.\n\n${formatCheckResult(check)}`);
		return;
	}
	const finalized = await closeCompletedIssues(pi, ctx, state);
	state.finalizedIssues = finalized;
	state.active = false;
	delete state.current;
	delete state.running;
	state.finishedAt = nowIso();
	state.stopReason = "Finished: completed issues closed.";
	await refreshIssueStates(pi, ctx, state);
	await saveState(pi, state);
	emit(pi, `Ralph legacy finish complete.\nClosed issues: ${finalized.length ? finalized.map((n) => `#${n}`).join(", ") : "none"}\n${formatCheckResult(check)}`);
}

export async function handleFinish(pi: ExtensionAPI, ctx: ExtensionContext) {
	let repo = await getRepoInfo(pi, ctx);
	const state = await loadStateForRepo(repo);
	if (!state) throw new Error("No Ralph ledger.");
	if (state.version !== VERSION) {
		await handleLegacyFinish(pi, ctx, state);
		return;
	}
	assertV2State(state);
	await assertSameRunContext(pi, ctx, state);
	if (activeRunningEntries(state).length > 0 || (state.mergeQueue ?? []).length > 0 || state.conflict || state.fixer || (state.verifier && ["spawning", "running"].includes(state.verifier.status))) {
		throw new Error("Ralph finish refused: workers, merge queue, conflict resolver, verifier, or fixer still active.");
	}
	if (!state.readyToFinish || state.verifier?.status !== "passed") {
		throw new Error("Ralph finish refused: PRD verifier has not passed. Run /ralph-resume.");
	}
	await ensureIntegrationWorktree(pi, ctx, state);
	await assertCleanTree(pi, ctx, state.integration.path, "Integration worktree");
	const verifiedHead = state.verifiedHead ?? state.verifier?.verifiedHead;
	if (!verifiedHead) throw new Error("Ralph finish refused: missing verified integration head.");
	const currentIntegrationHead = await revParse(pi, ctx, state.integration.path);
	if (currentIntegrationHead !== verifiedHead) throw new Error(`Ralph finish refused: integration HEAD ${currentIntegrationHead} != verified head ${verifiedHead}.`);
	const config = await readConfig();
	const integrationCheck = await runFullCheck(pi, ctx, state.integration.path, config);
	state.finalCheck = integrationCheck;
	await saveState(pi, state);
	if (integrationCheck.noCommand && !ctx.hasUI) throw new Error("No check command configured; refusing non-interactive /ralph-finish.");
	if (integrationCheck.noCommand && ctx.hasUI) {
		const ok = await ctx.ui.confirm("No check command configured", "Continue export/close anyway?");
		if (!ok) return;
	}
	if (!integrationCheck.ok) {
		emit(pi, `Ralph finish refused: integration check failed.\n\n${formatCheckResult(integrationCheck)}`);
		return;
	}
	await execRaw(pi, ctx, "git", ["restore", "."], 30_000, state.integration.path);
	const integrationStatusAfterCheck = await dirtyStatusIgnoringWorktrees(pi, ctx, state.integration.path);
	if (integrationStatusAfterCheck.trim()) {
		emit(pi, `Ralph finish refused: integration check dirtied worktree.\n\n${integrationStatusAfterCheck}`);
		return;
	}
	const integrationHeadAfterCheck = await revParse(pi, ctx, state.integration.path);
	if (integrationHeadAfterCheck !== verifiedHead) throw new Error(`Ralph finish refused: integration check changed HEAD ${integrationHeadAfterCheck} != verified ${verifiedHead}.`);

	repo = await getRepoInfo(pi, ctx, repo.repoRoot);
	await assertCleanTree(pi, ctx, repo.repoRoot, "Coordinator checkout");
	if (!state.exportedAt) {
		if (repo.branch !== state.branch) throw new Error(`Ralph finish refused: current branch ${repo.branch}, expected ${state.branch}.`);
		await assertBranchFresh(pi, ctx, repo);
		if (repo.head !== state.originalHead) throw new Error(`Ralph finish refused: coordinator HEAD changed from ${state.originalHead} to ${repo.head}.`);
		await execOk(pi, ctx, "git", ["merge", "--ff-only", verifiedHead], 120_000, repo.repoRoot);
		repo = await getRepoInfo(pi, ctx, repo.repoRoot);
		if (repo.head !== verifiedHead) throw new Error(`Ralph export failed: current HEAD ${repo.head} != verified head ${verifiedHead}.`);
		state.exportedAt = nowIso();
		state.exportedHead = repo.head;
		await saveState(pi, state);
		emit(pi, `Ralph exported integration to ${state.branch} at ${repo.head.slice(0, 12)}.`);
	} else if (state.exportedHead && repo.head !== state.exportedHead) {
		throw new Error(`Ralph finish refused: exported head was ${state.exportedHead}, current HEAD is ${repo.head}.`);
	} else if (state.exportedHead && state.exportedHead !== verifiedHead) {
		throw new Error(`Ralph finish refused: exported head ${state.exportedHead} != verified head ${verifiedHead}.`);
	}

	const mainCheck = await runFullCheck(pi, ctx, repo.repoRoot, config);
	state.finalCheck = mainCheck;
	await saveState(pi, state);
	if (!mainCheck.ok) {
		emit(pi, `Ralph finish refused: exported checkout check failed.\n\n${formatCheckResult(mainCheck)}`);
		return;
	}
	await execRaw(pi, ctx, "git", ["restore", "."], 30_000, repo.repoRoot);
	const mainStatusAfterCheck = await dirtyStatusIgnoringWorktrees(pi, ctx, repo.repoRoot);
	if (mainStatusAfterCheck.trim()) {
		emit(pi, `Ralph finish refused: exported checkout check dirtied worktree.\n\n${mainStatusAfterCheck}`);
		return;
	}

	await pushCurrentBranch(pi, ctx, repo);
	state.pushedAt = nowIso();
	await saveState(pi, state);

	const finalized = await closeCompletedIssues(pi, ctx, state);
	state.finalizedIssues = finalized;
	state.active = false;
	delete state.current;
	delete state.running;
	state.finishedAt = nowIso();
	state.stopReason = "Finished: exported, pushed, and completed issues closed.";
	await refreshIssueStates(pi, ctx, state);
	const stillOpen = state.issueOrder.filter((n) => state.issues[String(n)]?.state !== "CLOSED" && !finalized.includes(n));
	let prdClosed = false;
	if (stillOpen.length === 0 && ctx.hasUI) {
		const closePrd = await ctx.ui.confirm("All child issues closed", `Close PRD #${state.prd.number}?`);
		if (closePrd) {
			await execOk(pi, ctx, "gh", ["issue", "close", String(state.prd.number), "--repo", state.repo], 30_000);
			prdClosed = true;
		}
	}
	await cleanupRalphWorktrees(pi, ctx, state);
	await saveState(pi, state);
	emit(
		pi,
		[
			"Ralph finish complete.",
			`Exported head: ${state.exportedHead ?? "unknown"}`,
			`Closed issues: ${finalized.length ? finalized.map((n) => `#${n}`).join(", ") : "none"}`,
			stillOpen.length ? `Still open: ${stillOpen.map((n) => `#${n}`).join(", ")}` : "All child issues closed.",
			prdClosed ? `Closed PRD #${state.prd.number}.` : `PRD #${state.prd.number} left open.`,
			formatCheckResult(mainCheck),
		].join("\n"),
	);
}
