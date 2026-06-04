import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execOk, execRaw } from "./exec";
import { fetchIssue } from "./issues";
import { assertCleanTree, changedFiles, diffStat, getDiffSnapshot, gitStatus, revParse, validateExistingWorktree } from "./git";
import { assertV2State, removeRunningIssue, runningEntries } from "./state";
import { cap, nowIso, pathInside } from "./utils";
import { VERSION, type PendingWorkerResult, type RepoInfo, type RalphState } from "./types";

export async function unmergedPaths(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string) {
	const raw = await execOk(pi, ctx, "git", ["diff", "--name-only", "--diff-filter=U"], 30_000, cwd);
	return raw.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function commitWorkerChanges(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, pending: PendingWorkerResult) {
	if (!pending.baseHead) throw new Error(`Worker #${pending.number} missing base head; refusing to commit.`);
	await validateExistingWorktree(pi, ctx, state, pending.workerWorktreePath, pending.workerBranch);
	const branch = await execOk(pi, ctx, "git", ["branch", "--show-current"], 10_000, pending.workerWorktreePath);
	if (branch !== pending.workerBranch) throw new Error(`Worker #${pending.number} branch changed to ${branch}; expected ${pending.workerBranch}.`);
	const unmerged = await unmergedPaths(pi, ctx, pending.workerWorktreePath);
	if (unmerged.length > 0) throw new Error(`Worker #${pending.number} left unmerged paths: ${unmerged.join(", ")}`);
	const headBefore = await revParse(pi, ctx, pending.workerWorktreePath);
	if (headBefore !== pending.baseHead) throw new Error(`Worker #${pending.number} committed despite rules; HEAD ${headBefore} != base ${pending.baseHead}.`);
	const diffCheck = await execRaw(pi, ctx, "git", ["diff", "--check"], 60_000, pending.workerWorktreePath);
	if (diffCheck.code !== 0) throw new Error(`Worker #${pending.number} diff check failed:\n${cap([diffCheck.stderr, diffCheck.stdout].join("\n"), 4_000)}`);
	const status = await gitStatus(pi, ctx, pending.workerWorktreePath);
	let files = await changedFiles(pi, ctx, pending.workerWorktreePath);
	let statText = await diffStat(pi, ctx, pending.workerWorktreePath);
	if (!status.trim()) return { changedFiles: files, diffStat: statText, commit: undefined as string | undefined };
	await execOk(pi, ctx, "git", ["add", "-A"], 120_000, pending.workerWorktreePath);
	const stagedCheck = await execRaw(pi, ctx, "git", ["diff", "--cached", "--check"], 60_000, pending.workerWorktreePath);
	if (stagedCheck.code !== 0) throw new Error(`Worker #${pending.number} staged diff check failed:\n${cap([stagedCheck.stderr, stagedCheck.stdout].join("\n"), 4_000)}`);
	await execOk(
		pi,
		ctx,
		"git",
		["commit", "-m", `Ralph #${pending.number}: ${pending.title}`, "-m", `Worker result merged by Ralph run ${state.runId ?? "unknown"}.`],
		120_000,
		pending.workerWorktreePath,
	);
	const headAfter = await revParse(pi, ctx, pending.workerWorktreePath);
	const allFiles = await execOk(pi, ctx, "git", ["diff", "--name-only", `${pending.baseHead}..HEAD`], 60_000, pending.workerWorktreePath);
	const allStat = await execOk(pi, ctx, "git", ["diff", "--stat", `${pending.baseHead}..HEAD`], 60_000, pending.workerWorktreePath);
	files = allFiles.split("\n").map((s) => s.trim()).filter(Boolean);
	statText = allStat || statText;
	return { changedFiles: files, diffStat: statText, commit: headAfter };
}

export async function commitIntegrationChanges(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, message: string) {
	const status = await gitStatus(pi, ctx, cwd);
	if (!status.trim()) return undefined;
	await execOk(pi, ctx, "git", ["add", "-A"], 120_000, cwd);
	await execOk(pi, ctx, "git", ["commit", "-m", message], 120_000, cwd);
	return revParse(pi, ctx, cwd);
}

export async function mergeWorkerIntoIntegration(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, pending: PendingWorkerResult) {
	assertV2State(state);
	await assertCleanTree(pi, ctx, state.integration.path, "Integration worktree");
	const preMergeHead = await revParse(pi, ctx, state.integration.path);
	if (!pending.workerCommit) {
		return { ok: true, conflict: false, mergeCommit: preMergeHead, preMergeHead, noOp: true };
	}
	const result = await execRaw(pi, ctx, "git", ["merge", "--no-ff", "--no-edit", pending.workerCommit], 120_000, state.integration.path);
	if (result.code === 0) {
		return { ok: true, conflict: false, mergeCommit: await revParse(pi, ctx, state.integration.path), preMergeHead, noOp: false };
	}
	const conflicts = await unmergedPaths(pi, ctx, state.integration.path);
	if (conflicts.length > 0) {
		return { ok: false, conflict: true, mergeCommit: undefined, preMergeHead, noOp: false, output: cap([result.stderr, result.stdout].join("\n"), 6_000) };
	}
	throw new Error(`Merge of #${pending.number} failed without unmerged paths:\n${cap([result.stderr, result.stdout].join("\n"), 6_000)}`);
}

export function enqueueMerge(state: RalphState, issueNumber: number) {
	state.mergeQueue ??= [];
	if (!state.mergeQueue.includes(issueNumber)) {
		state.mergeQueue.push(issueNumber);
		state.mergeQueue.sort((a, b) => {
			const ai = state.issueOrder.indexOf(a);
			const bi = state.issueOrder.indexOf(b);
			return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
		});
	}
}

export async function markIssueMerged(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphState,
	issueNumber: number,
	pending: PendingWorkerResult,
	mergeCommit?: string,
) {
	state.completed[String(issueNumber)] = {
		number: issueNumber,
		title: pending.title,
		completedAt: nowIso(),
		status: "success",
		sessionFile: pending.sessionFile,
		elapsed: pending.elapsed,
		summary: pending.summary,
		changedFiles: pending.changedFiles,
		diffStat: pending.diffStat,
		workerBranch: pending.workerBranch,
		workerCommit: pending.workerCommit,
		workerWorktreePath: pending.workerWorktreePath,
		mergeCommit,
	};
	removeRunningIssue(state, issueNumber);
	delete state.pendingResults?.[String(issueNumber)];
	state.mergeQueue = (state.mergeQueue ?? []).filter((n) => n !== issueNumber);
	state.lastSnapshot = state.integration ? await getDiffSnapshot(pi, ctx, state.integration.path) : state.lastSnapshot;
}

export async function assertBranchFresh(pi: ExtensionAPI, ctx: ExtensionContext, repo: RepoInfo) {
	const upstream = await execRaw(pi, ctx, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 10_000, repo.repoRoot);
	if (upstream.code !== 0) return;
	const remote = await execOk(pi, ctx, "git", ["config", "--get", `branch.${repo.branch}.remote`], 20_000, repo.repoRoot).catch(() => "origin");
	const mergeRef = await execOk(pi, ctx, "git", ["config", "--get", `branch.${repo.branch}.merge`], 20_000, repo.repoRoot).catch(() => `refs/heads/${repo.branch}`);
	const remoteBranch = mergeRef.replace(/^refs\/heads\//, "");
	const trackingRef = `refs/remotes/${remote}/${remoteBranch}`;
	await execOk(pi, ctx, "git", ["fetch", "--quiet", remote, `${mergeRef}:${trackingRef}`], 120_000, repo.repoRoot);
	const countsRaw = await execOk(pi, ctx, "git", ["rev-list", "--left-right", "--count", `HEAD...${trackingRef}`], 20_000, repo.repoRoot);
	const [ahead, behind] = countsRaw.split(/\s+/).map((value) => Number(value || "0"));
	if (behind > 0) throw new Error(`Branch is ${behind} commit(s) behind upstream; pull/rebase before /ralph-finish.`);
	if (ahead > 0) return;
}

export async function pushCurrentBranch(pi: ExtensionAPI, ctx: ExtensionContext, repo: RepoInfo) {
	if (repo.branch.startsWith("detached:")) throw new Error("Cannot push detached HEAD. Check out a branch before /ralph-finish.");
	const upstream = await execRaw(pi, ctx, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 10_000, repo.repoRoot);
	if (upstream.code === 0) await execOk(pi, ctx, "git", ["push"], 120_000, repo.repoRoot);
	else await execOk(pi, ctx, "git", ["push", "-u", "origin", repo.branch], 120_000, repo.repoRoot);
	const remote = await execOk(pi, ctx, "git", ["config", "--get", `branch.${repo.branch}.remote`], 20_000, repo.repoRoot).catch(() => "origin");
	const mergeRef = await execOk(pi, ctx, "git", ["config", "--get", `branch.${repo.branch}.merge`], 20_000, repo.repoRoot).catch(() => `refs/heads/${repo.branch}`);
	const remoteBranch = mergeRef.replace(/^refs\/heads\//, "");
	const trackingRef = `refs/remotes/${remote}/${remoteBranch}`;
	await execRaw(pi, ctx, "git", ["fetch", "--quiet", remote, `${mergeRef}:${trackingRef}`], 120_000, repo.repoRoot).catch(() => undefined);
	const [localHead, upstreamHead] = await Promise.all([
		revParse(pi, ctx, repo.repoRoot),
		execOk(pi, ctx, "git", ["rev-parse", trackingRef], 20_000, repo.repoRoot),
	]);
	if (localHead !== upstreamHead) throw new Error(`Push verification failed: local ${localHead}, upstream ${upstreamHead}.`);
}

export async function closeCompletedIssues(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	const finalized: number[] = [];
	for (const completed of Object.values(state.completed).sort((a, b) => a.number - b.number)) {
		const issue = await fetchIssue(pi, ctx, state.repo, completed.number);
		if (issue.state !== "CLOSED") {
			await execOk(pi, ctx, "gh", ["issue", "close", String(completed.number), "--repo", state.repo], 30_000);
		}
		finalized.push(completed.number);
	}
	return finalized;
}

export async function cleanupRalphWorktrees(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	if (state.version !== VERSION || !state.worktreeBase || !state.runId) return;
	const branchPrefix = `ralph/${state.runId}/`;
	const branches = new Set<string>();
	if (state.integration?.branch?.startsWith(branchPrefix)) branches.add(state.integration.branch);
	for (const completed of Object.values(state.completed)) if (completed.workerBranch?.startsWith(branchPrefix)) branches.add(completed.workerBranch);
	for (const running of runningEntries(state)) if (running.branch?.startsWith(branchPrefix)) branches.add(running.branch);
	const paths = new Set<string>();
	if (state.integration?.path && pathInside(state.integration.path, state.worktreeBase)) paths.add(state.integration.path);
	for (const completed of Object.values(state.completed)) if (completed.workerWorktreePath && pathInside(completed.workerWorktreePath, state.worktreeBase)) paths.add(completed.workerWorktreePath);
	for (const running of runningEntries(state)) if (running.worktreePath && pathInside(running.worktreePath, state.worktreeBase)) paths.add(running.worktreePath);
	const list = await execOk(pi, ctx, "git", ["worktree", "list", "--porcelain"], 60_000, state.repoRoot).catch(() => "");
	const listedPaths = new Set([...list.matchAll(/^worktree (.+)$/gm)].map((match) => resolve(match[1])));
	for (const path of paths) {
		if (!pathInside(path, state.worktreeBase) || !listedPaths.has(resolve(path))) continue;
		await execRaw(pi, ctx, "git", ["worktree", "remove", "--force", path], 120_000, state.repoRoot).catch(() => undefined);
		await rm(path, { recursive: true, force: true }).catch(() => undefined);
	}
	for (const branch of branches) {
		if (!branch.startsWith(branchPrefix)) continue;
		const merged = await execRaw(pi, ctx, "git", ["merge-base", "--is-ancestor", branch, "HEAD"], 60_000, state.repoRoot);
		if (merged.code === 0) await execRaw(pi, ctx, "git", ["branch", "-d", branch], 60_000, state.repoRoot).catch(() => undefined);
	}
	if (pathInside(state.worktreeBase, join(state.commonGitDir ?? state.gitDir, "ralph", "worktrees"))) {
		await rm(state.worktreeBase, { recursive: true, force: true }).catch(() => undefined);
	}
	state.cleanedAt = nowIso();
}
