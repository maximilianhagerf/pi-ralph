import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { readConfig } from "./config";
import { getRepoInfo, integrationCwd } from "./git";
import { loadCurrentState, processConflictResolverResult, processFixerResult, processPrdVerifierResult, processWorkerPing, processWorkerResult, retryProviderError } from "./orchestration";
import { assertV2State, getRunningIssue, loadStateForRepo, runningEntries, saveState, setRunningIssue } from "./state";
import { DEFAULT_MODEL, VERSION, type RalphConfig, type RalphState, type RalphSubagentSpec } from "./types";
import { cap, emit, isRalphSpawnMessage, isRalphSubagentMessage, messageText, notify, parseRalphSubagentName, pathInside } from "./utils";
import { verifierTools } from "./spawn";

let previousTokens: number | undefined;
let pendingRalphSubagentMessages: any[] = [];

const WARN_TOKENS = 90_000;

function toolPath(ctx: any, value: unknown) {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const raw = value.replace(/^@/, "");
	return isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw);
}

function ralphAllowedRootForCwd(state: RalphState, cwd: string) {
	if (state.version !== VERSION || !state.worktreeBase) return undefined;
	const roots = [
		state.integration?.path,
		...runningEntries(state).map((running) => running.worktreePath),
		...Object.values(state.completed).map((completed) => completed.workerWorktreePath),
	].filter((path): path is string => Boolean(path));
	return roots.find((root) => pathInside(cwd, root));
}

async function guardRalphWorktreeTool(pi: ExtensionAPI, ctx: any, event: any) {
	let repo: import("./types").RepoInfo;
	try {
		repo = await getRepoInfo(pi, ctx);
	} catch {
		return undefined;
	}
	const state = await loadStateForRepo(repo);
	if (!state || state.version !== VERSION) return undefined;
	const allowedRoot = ralphAllowedRootForCwd(state, ctx.cwd);
	if (!allowedRoot) return undefined;

	const pathValue = event.input?.path ?? event.input?.cwd ?? event.input?.dir;
	const target = toolPath(ctx, pathValue);
	if (target && !pathInside(target, allowedRoot)) {
		return { block: true, reason: `Ralph worktree guard blocked ${event.toolName} outside assigned worktree.` };
	}

	if (event.toolName === "bash") {
		const command = String(event.input?.command ?? "");
		const dangerous = [
			/\bsudo\b/,
			/\brm\s+-rf\s+(?:\/|~|\$HOME|\.\.)/,
			/\bgh\s+(?:api|pr\b|release\b|repo\b|issue\s+(?:close|edit|comment|reopen|delete))\b/,
		];
		if (dangerous.some((pattern) => pattern.test(command))) {
			return { block: true, reason: "Ralph worktree guard blocked dangerous command." };
		}
		if (/\bgit\b/.test(command) && !/\bgit(?:\s+-C\s+\S+)?\s+(?:diff|status|log|show|ls-files|stash\s+list)\b/.test(command)) {
			return { block: true, reason: "Ralph worktree guard blocked git command outside read-only allowlist." };
		}
		if (state.repoRoot && !pathInside(state.repoRoot, allowedRoot)) {
			const commandWithoutAllowedRoot = command.split(allowedRoot).join("");
			if (commandWithoutAllowedRoot.includes(state.repoRoot)) {
				return { block: true, reason: "Ralph worktree guard blocked parent checkout access." };
			}
		}
	}
	return undefined;
}

function expectedSubagentParams(state: RalphState, spec: RalphSubagentSpec, config: RalphConfig) {
	if (state.version !== VERSION) return undefined;
	assertV2State(state);
	if (spec.kind === "worker") {
		const running = getRunningIssue(state, spec.issueNumber);
		if (!running || (running.status !== "spawning" && running.status !== "failed") || !running.worktreePath) return undefined;
		return {
			agent: config.workerAgent ?? "ralph-worker",
			cwd: running.cwd ?? running.worktreePath,
			model: config.workerModel ?? DEFAULT_MODEL,
			tools: config.workerTools,
			skills: config.workerSkills,
			task: running.task,
		};
	}
	if (spec.kind === "conflict") {
		if (!state.conflict || state.conflict.issueNumber !== spec.issueNumber || state.conflict.status !== "spawning") return undefined;
		return {
			agent: config.conflictResolverAgent ?? "ralph-conflict-resolver",
			cwd: integrationCwd(state),
			model: config.conflictResolverModel ?? DEFAULT_MODEL,
			tools: config.conflictResolverTools ?? "read,bash,edit,write,grep,find,ls",
			skills: config.conflictResolverSkills,
			task: state.conflict.task,
		};
	}
	if (spec.kind === "verifier") {
		if (!state.verifier || state.verifier.status !== "spawning") return undefined;
		return {
			agent: config.prdVerifierAgent ?? "ralph-prd-verifier",
			cwd: integrationCwd(state),
			model: config.prdVerifierModel ?? DEFAULT_MODEL,
			tools: verifierTools(config),
			skills: config.prdVerifierSkills,
			task: state.verifier.task,
		};
	}
	if (!state.fixer || state.fixer.status !== "spawning") return undefined;
	return {
		agent: config.fixerAgent ?? "ralph-fixer",
		cwd: integrationCwd(state),
		model: config.fixerModel ?? DEFAULT_MODEL,
		tools: config.fixerTools ?? "read,bash,edit,write,grep,find,ls",
		skills: config.fixerSkills,
		task: state.fixer.task,
	};
}

async function markSubagentStarted(pi: ExtensionAPI, ctx: any, spec: RalphSubagentSpec, details: any) {
	const { state } = await loadCurrentState(pi, ctx);
	if (!state || state.version !== VERSION) return;
	if (spec.kind === "worker") {
		const running = getRunningIssue(state, spec.issueNumber);
		if (!running || (running.status !== "spawning" && running.status !== "failed")) return;
		const isRetry = running.status === "failed";
		running.status = "running";
		running.sessionFile = details.sessionFile;
		setRunningIssue(state, running);
		if (isRetry) {
			state.active = true;
			state.stopReason = undefined;
		}
	} else if (spec.kind === "conflict") {
		if (!state.conflict || state.conflict.issueNumber !== spec.issueNumber) return;
		state.conflict.status = "running";
		state.conflict.sessionFile = details.sessionFile;
	} else if (spec.kind === "verifier") {
		if (!state.verifier) return;
		state.verifier.status = "running";
		state.verifier.sessionFile = details.sessionFile;
	} else {
		if (!state.fixer) return;
		state.fixer.status = "running";
		state.fixer.sessionFile = details.sessionFile;
	}
	await saveState(pi, state);
}

async function markSubagentLaunchFailed(pi: ExtensionAPI, ctx: any, spec: RalphSubagentSpec, error: string) {
	const { state } = await loadCurrentState(pi, ctx);
	if (!state) return;
	// A failed launch is usually transient (transport/provider). Retry, bounded.
	if (state.version === VERSION) {
		await retryProviderError(pi, ctx, state, { kind: spec.kind, issueNumber: "issueNumber" in spec ? spec.issueNumber : undefined }, `Subagent launch failed (${spec.kind}): ${error}`);
		return;
	}
	state.active = false;
	state.stopReason = `Subagent launch failed: ${error}`;
	if (spec.kind === "worker") {
		const running = getRunningIssue(state, spec.issueNumber);
		if (running) {
			running.status = "failed";
			setRunningIssue(state, running);
		}
	} else if (spec.kind === "conflict" && state.conflict) state.conflict.status = "failed";
	else if (spec.kind === "verifier" && state.verifier) state.verifier.status = "failed";
	else if (spec.kind === "fixer" && state.fixer) state.fixer.status = "failed";
	await saveState(pi, state);
	emit(pi, `Ralph stopped. ${state.stopReason}`);
}

export function registerEvents(pi: ExtensionAPI) {
	pi.on("tool_call", async (event: any, ctx) => {
		if (event.toolName !== "subagent") {
			return guardRalphWorktreeTool(pi, ctx, event);
		}
		const repo = await getRepoInfo(pi, ctx);
		const state = await loadStateForRepo(repo);
		const spec = parseRalphSubagentName(event.input?.name);
		if (!spec) {
			// Guard rail: while a Ralph ledger exists (active OR stopped — terminal stops are
			// exactly when the idle coordinator improvises), the main thread must never spawn its
			// own subagents. Ralph drives all delegation with correct model/cwd/task; a hand-rolled
			// spawn is how a wrong-model verifier got launched. Ralph's own spawns carry a reserved
			// name (parseRalphSubagentName) and pass; everything else stands down.
			if (state) {
				return {
					block: true,
					reason:
						"Ralph runs AFK and spawns every worker, verifier, and fixer itself with the correct settings. Do NOT spawn your own subagents and do NOT do the work in the main thread — take no action and wait for Ralph's next step. If the loop has genuinely stopped, run /ralph-resume.",
				};
			}
			return;
		}
		if (!state) return { block: true, reason: "Ralph subagent call has no active ledger." };
		if (event.input.fork === true) return { block: true, reason: "Ralph subagents must not fork main context." };
		const config = await readConfig();
		const expected = expectedSubagentParams(state, spec, config);
		if (!expected) return { block: true, reason: "Ralph subagent call does not match active spawn." };
		if (!expected.task) return { block: true, reason: "Ralph subagent call missing stored task." };
		event.input.agent = expected.agent;
		event.input.interactive = false;
		event.input.cwd = expected.cwd;
		event.input.model = expected.model;
		event.input.task = expected.task;
		if (expected.tools) event.input.tools = expected.tools;
		else delete event.input.tools;
		if (expected.skills) event.input.skills = expected.skills;
		else delete event.input.skills;
	});

	pi.on("tool_result", async (event: any, ctx) => {
		if (event.toolName !== "subagent") return;
		const spec = parseRalphSubagentName(event.details?.name ?? event.input?.name);
		if (!spec) return;
		if (event.details?.status === "started") {
			await markSubagentStarted(pi, ctx, spec, event.details);
			return;
		}
		if (event.details?.error) {
			await markSubagentLaunchFailed(pi, ctx, spec, event.details.error);
		}
	});

	pi.on("message_end", async (event: any) => {
		if (isRalphSubagentMessage(event.message)) pendingRalphSubagentMessages.push(event.message);
	});

	pi.on("agent_end", async (event: any, ctx) => {
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const candidates = [...messages.filter(isRalphSubagentMessage), ...pendingRalphSubagentMessages];
		pendingRalphSubagentMessages = [];
		const seen = new Set<string>();
		for (const message of candidates) {
			const spec = parseRalphSubagentName(message.details?.name);
			if (!spec) continue;
			const key = `${message.customType}:${message.details?.sessionFile ?? "no-session"}:${message.details?.name ?? "no-name"}:${message.details?.elapsed ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			try {
				if (message.customType === "subagent_ping") await processWorkerPing(pi, ctx, message, spec);
				else if (spec.kind === "worker") await processWorkerResult(pi, ctx, message, spec.issueNumber);
				else if (spec.kind === "conflict") await processConflictResolverResult(pi, ctx, message, spec.issueNumber);
				else if (spec.kind === "verifier") await processPrdVerifierResult(pi, ctx, message);
				else await processFixerResult(pi, ctx, message);
			} catch (error) {
				emit(pi, `Ralph result handling error: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});

	pi.on("context", async (event: any) => {
		const messages = Array.isArray(event.messages) ? event.messages : [];
		let latestSpawn = -1;
		let latestRalphResult = -1;
		for (let i = 0; i < messages.length; i++) {
			if (isRalphSpawnMessage(messages[i])) latestSpawn = i;
			if (isRalphSubagentMessage(messages[i])) latestRalphResult = i;
		}
		const hasResultAfterSpawn = latestSpawn >= 0 && latestRalphResult > latestSpawn;
		const filtered = messages.flatMap((message: any, index: number) => {
			if (message?.role === "custom" && message.customType === "ralph") return [];
			if (isRalphSpawnMessage(message)) {
				return index === latestSpawn && !hasResultAfterSpawn ? [message] : [];
			}
			if (isRalphSubagentMessage(message)) {
				if (index !== latestRalphResult) return [];
				return [{ ...message, content: cap(messageText(message)) }];
			}
			return [message];
		});
		return { messages: filtered };
	});

	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		if (pendingRalphSubagentMessages.length === 0) return;
		const { state } = await loadCurrentState(pi, ctx);
		if (!state) return;
		state.pendingSubagentMessages = pendingRalphSubagentMessages.map((msg) => ({
			sessionFile: msg.details?.sessionFile,
			name: String(msg.details?.name ?? ""),
			elapsed: msg.details?.elapsed,
		}));
		await saveState(pi, state);
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		const { state } = await loadCurrentState(pi, ctx);
		if (!state?.pendingSubagentMessages?.length) return;
		for (const ref of state.pendingSubagentMessages) {
			pendingRalphSubagentMessages.push({
				role: "custom",
				customType: "subagent_result",
				content: "",
				details: { sessionFile: ref.sessionFile, name: ref.name, elapsed: ref.elapsed },
			});
		}
		state.pendingSubagentMessages = [];
		await saveState(pi, state);
	});

	pi.on("turn_end", (_event: any, ctx: any) => {
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens;
		if (!tokens) return;
		if (previousTokens !== undefined && previousTokens < WARN_TOKENS && tokens >= WARN_TOKENS) {
			notify(ctx, `Ralph context warning: ${tokens} tokens`, "warning");
		}
		previousTokens = tokens;
	});
}
