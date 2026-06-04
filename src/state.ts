import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { statePathFor } from "./config";
import { nowIso } from "./utils";
import { STATE_CUSTOM_TYPE, VERSION, type IssueInfo, type RalphState, type RunningIssue } from "./types";

export const processedResultKeys = new Set<string>();

export async function loadStateForRepo(repo: { commonGitDir: string; gitDir: string }): Promise<RalphState | null> {
	const candidates = [statePathFor(repo.commonGitDir)];
	if (repo.gitDir !== repo.commonGitDir) candidates.push(statePathFor(repo.gitDir));
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const state = JSON.parse(await readFile(path, "utf8")) as RalphState;
			state.commonGitDir ??= repo.commonGitDir;
			normalizeRunning(state);
			state.mergeQueue ??= [];
			state.pendingResults ??= {};
			for (const key of state.processedResultKeys ?? []) processedResultKeys.add(key);
			return state;
		} catch {
			return null;
		}
	}
	return null;
}

export function runningEntries(state: RalphState): RunningIssue[] {
	const byNumber = new Map<number, RunningIssue>();
	for (const running of Object.values(state.running ?? {})) byNumber.set(running.number, running);
	if (state.current) byNumber.set(state.current.number, byNumber.get(state.current.number) ?? state.current);
	return [...byNumber.values()].sort((a, b) => {
		const ai = state.issueOrder.indexOf(a.number);
		const bi = state.issueOrder.indexOf(b.number);
		return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi) || a.number - b.number;
	});
}

export function normalizeRunning(state: RalphState): RunningIssue[] {
	const entries = runningEntries(state);
	if (entries.length === 0) {
		delete state.running;
		delete state.current;
		return [];
	}
	state.running = Object.fromEntries(entries.map((running) => [String(running.number), running]));
	state.current = entries[0];
	return entries;
}

export function activeRunningEntries(state: RalphState): RunningIssue[] {
	return runningEntries(state).filter((running) => running.status !== "failed");
}

export function getRunningIssue(state: RalphState, issueNumber: number): RunningIssue | undefined {
	return runningEntries(state).find((running) => running.number === issueNumber);
}

export function setRunningIssue(state: RalphState, running: RunningIssue) {
	state.running ??= {};
	state.running[String(running.number)] = running;
	normalizeRunning(state);
}

export function removeRunningIssue(state: RalphState, issueNumber: number) {
	if (state.running) delete state.running[String(issueNumber)];
	if (state.current?.number === issueNumber) delete state.current;
	normalizeRunning(state);
}

export function assertV2State(state: RalphState): asserts state is RalphState & {
	runId: string;
	worktreeBase: string;
	integration: import("./types").WorktreeState;
	originalHead: string;
} {
	if (state.version !== VERSION || !state.runId || !state.worktreeBase || !state.integration || !state.originalHead) {
		throw new Error("Ralph ledger is legacy v1/shared-worktree. Use /ralph-status, /ralph-finish, or /ralph-clear; /ralph-resume refuses migration.");
	}
}

export async function saveState(pi: ExtensionAPI, state: RalphState) {
	normalizeRunning(state);
	if (state.version === VERSION) {
		state.mergeQueue ??= [];
		state.pendingResults ??= {};
	}
	state.processedResultKeys = [...processedResultKeys];
	state.updatedAt = nowIso();
	const gitDir = state.commonGitDir ?? state.gitDir;
	const path = statePathFor(gitDir);
	await mkdir(join(gitDir, "ralph"), { recursive: true });
	await writeFile(path, JSON.stringify(state, null, 2), "utf8");
	try {
		pi.appendEntry(STATE_CUSTOM_TYPE, {
			version: state.version,
			active: state.active,
			mode: state.mode,
			prd: state.prd,
			runId: state.runId,
			integration: state.integration ? { branch: state.integration.branch, path: state.integration.path } : undefined,
			current: state.current ? { number: state.current.number, title: state.current.title, status: state.current.status } : undefined,
			running: runningEntries(state).map((running) => ({ number: running.number, title: running.title, status: running.status })),
			completed: Object.keys(state.completed).map(Number).sort((a, b) => a - b),
			mergeQueue: state.mergeQueue,
			conflict: state.conflict,
			verifier: state.verifier,
			fixer: state.fixer,
			readyToFinish: state.readyToFinish,
			verifiedHead: state.verifiedHead,
			stopReason: state.stopReason,
			statePath: path,
		});
	} catch {
		// appendEntry is best-effort; .git/ralph/state.json is source of truth.
	}
}

export function renderState(state: RalphState) {
	const completed = Object.keys(state.completed).map(Number).sort((a, b) => a - b);
	const running = runningEntries(state);
	const runningNumbers = new Set(activeRunningEntries(state).map((issue) => issue.number));
	const remaining = state.issueOrder.filter((n) => !state.completed[String(n)] && !runningNumbers.has(n) && state.issues[String(n)]?.state !== "CLOSED");
	return [
		`Ralph ${state.active ? "active" : "stopped"}: PRD #${state.prd.number} ${state.prd.title}`,
		`Version: ${state.version ?? 1}${state.version === VERSION && state.runId ? ` (${state.runId})` : ""}`,
		`Repo: ${state.repo} (${state.branch})`,
		state.integration ? `Integration: ${state.integration.branch} @ ${state.integration.path}` : undefined,
		`Mode: ${state.mode}, max: ${state.maxIterations}, auto-finish: ${state.autoFinish !== false ? "on" : "off"}`,
		`Completed: ${completed.length ? completed.map((n) => `#${n}`).join(", ") : "none"}`,
		`Running: ${running.length ? running.map((issue) => `#${issue.number} (${issue.status})`).join(", ") : "none"}`,
		state.mergeQueue?.length ? `Merge queue: ${state.mergeQueue.map((n) => `#${n}`).join(", ")}` : undefined,
		state.conflict ? `Conflict: #${state.conflict.issueNumber} (${state.conflict.status}, attempt ${state.conflict.attempt})` : undefined,
		state.verifier ? `Verifier: ${state.verifier.status} (attempts ${state.verifier.attempts})` : undefined,
		state.fixer ? `Fixer: ${state.fixer.status} (attempt ${state.fixer.attempt})` : undefined,
		state.readyToFinish ? "Ready to finish: yes" : undefined,
		state.exportedAt ? `Exported: ${state.exportedAt} (${state.exportedHead ?? "unknown head"})` : undefined,
		state.pushedAt ? `Pushed: ${state.pushedAt}` : undefined,
		`Remaining: ${remaining.length ? remaining.map((n) => `#${n}`).join(", ") : "none"}`,
		state.stopReason ? `Stop reason: ${state.stopReason}` : undefined,
		`Ledger: ${statePathFor(state.commonGitDir ?? state.gitDir)}`,
	].filter(Boolean).join("\n");
}

export function issueCompletedOrClosed(state: RalphState, issueNumber: number) {
	return Boolean(state.completed[String(issueNumber)] || state.issues[String(issueNumber)]?.state === "CLOSED");
}

export function remainingIssues(state: RalphState): IssueInfo[] {
	const runningNumbers = new Set(activeRunningEntries(state).map((running) => running.number));
	return state.issueOrder
		.map((number) => state.issues[String(number)])
		.filter((issue): issue is IssueInfo => Boolean(issue))
		.filter((issue) => issue.state !== "CLOSED" && !state.completed[String(issue.number)] && !runningNumbers.has(issue.number) && !state.blocked?.[String(issue.number)]);
}
