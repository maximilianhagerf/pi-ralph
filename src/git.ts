import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { readConfig } from "./config";
import { execOk, execRaw } from "./exec";
import { resolveSetupCommand } from "./checks";
import { assertV2State, getRunningIssue, normalizeRunning, setRunningIssue } from "./state";
import { cap, emit, hashFile, hashText, nowIso, pathInside } from "./utils";
import type {
	DiffSnapshot,
	IssueInfo,
	RalphConfig,
	RalphState,
	RepoInfo,
	RunningIssue,
	WorktreeState,
} from "./types";

export async function getRepoInfo(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd): Promise<RepoInfo> {
	try {
		const inside = await execOk(pi, ctx, "git", ["rev-parse", "--is-inside-work-tree"], 10_000, cwd);
		if (inside.trim() !== "true") throw new Error("not inside work tree");
	} catch {
		throw new Error("Ralph requires git repo. Run from repo checkout.");
	}

	const repoRoot = await execOk(pi, ctx, "git", ["rev-parse", "--show-toplevel"], 10_000, cwd);
	const gitDir = await execOk(pi, ctx, "git", ["rev-parse", "--absolute-git-dir"], 10_000, cwd);
	let commonGitDir: string;
	try {
		commonGitDir = await execOk(pi, ctx, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000, cwd);
	} catch {
		const raw = await execOk(pi, ctx, "git", ["rev-parse", "--git-common-dir"], 10_000, cwd);
		commonGitDir = raw.startsWith("/") ? raw : resolve(cwd, raw);
	}
	let branch = await execOk(pi, ctx, "git", ["branch", "--show-current"], 10_000, cwd);
	const head = await execOk(pi, ctx, "git", ["rev-parse", "HEAD"], 10_000, cwd);
	if (!branch) branch = `detached:${head.slice(0, 12)}`;

	let repo: string;
	try {
		repo = await execOk(pi, ctx, "gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], 20_000, cwd);
	} catch {
		throw new Error("Ralph requires GitHub CLI in a GitHub repo. Fix: gh auth login && gh repo view");
	}

	return { repoRoot, gitDir, commonGitDir, branch, head, repo };
}

export async function ensureGhAuth(pi: ExtensionAPI, ctx: ExtensionContext) {
	const result = await execRaw(pi, ctx, "gh", ["auth", "status"], 20_000);
	if (result.code !== 0) {
		throw new Error("GitHub CLI not authenticated. Fix: gh auth login");
	}
}

export async function gitStatus(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd) {
	return execOk(pi, ctx, "git", ["status", "--porcelain=v1", "--untracked-files=all"], 20_000, cwd);
}

export async function assertCleanTree(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd, label = "Working tree") {
	const status = await execOk(pi, ctx, "git", ["status", "--porcelain=v1", "--untracked-files=no"], 20_000, cwd);
	if (status.trim()) {
		throw new Error(`${label} must be clean. Current changes:\n${status}`);
	}
}

// Discard disposable churn so the AFK loop never stalls on a dirty worktree. By the time this
// runs, all real code is committed (worker diffs at merge, fixer diff after the fixer returns);
// anything left is build output / scratch. `git clean -fd` removes untracked files+dirs but
// LEAVES .gitignored paths, so node_modules and other installed deps are never touched.
// Returns the trimmed status after cleaning ("" means clean).
export async function cleanIntegrationTree(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<string> {
	await execRaw(pi, ctx, "git", ["restore", "."], 30_000, cwd);
	await execRaw(pi, ctx, "git", ["clean", "-fd"], 30_000, cwd);
	return dirtyStatusIgnoringWorktrees(pi, ctx, cwd);
}

// Registered git worktrees nested under cwd (e.g. .claude/worktrees/agent-* created by the agent
// harness) are separate checkouts, not dirt; gitStatus(--untracked-files=all) lists each as an
// untracked entry and would wrongly fail a "clean tree?" gate. Subtract them before judging.
// (git clean -fd already skips nested worktrees — "Would skip repository …" — so cleaning is safe.)
export async function dirtyStatusIgnoringWorktrees(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<string> {
	const [status, wtList] = await Promise.all([
		gitStatus(pi, ctx, cwd),
		execOk(pi, ctx, "git", ["worktree", "list", "--porcelain"], 30_000, cwd),
	]);
	const nested = wtList
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length).trim())
		.filter((p) => p !== cwd && pathInside(p, cwd))
		.map((p) => relative(cwd, p).replace(/\/+$/, ""));
	return status
		.split("\n")
		.filter((line) => {
			if (!line.trim()) return false;
			const p = line.slice(3).replace(/^"|"$/g, "").replace(/\/+$/, "");
			return !nested.some((w) => p === w || p.startsWith(`${w}/`));
		})
		.join("\n")
		.trim();
}

export async function getDiffSnapshot(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd): Promise<DiffSnapshot> {
	const repoRoot = await execOk(pi, ctx, "git", ["rev-parse", "--show-toplevel"], 10_000, cwd);
	let branch = await execOk(pi, ctx, "git", ["branch", "--show-current"], 10_000, cwd);
	if (!branch) branch = `detached:${(await execOk(pi, ctx, "git", ["rev-parse", "--short", "HEAD"], 10_000, cwd)).trim()}`;
	const [status, diff, stagedDiff, untrackedRaw] = await Promise.all([
		gitStatus(pi, ctx, cwd),
		execOk(pi, ctx, "git", ["diff", "--binary"], 120_000, cwd),
		execOk(pi, ctx, "git", ["diff", "--cached", "--binary"], 120_000, cwd),
		execOk(pi, ctx, "git", ["ls-files", "--others", "--exclude-standard", "-z"], 60_000, cwd),
	]);

	const untrackedHashes: Record<string, string> = {};
	const paths = untrackedRaw.split("\0").filter(Boolean).sort();
	for (const path of paths) {
		const absolute = join(repoRoot, path);
		try {
			const info = await stat(absolute);
			if (info.isFile()) untrackedHashes[path] = await hashFile(absolute);
			else untrackedHashes[path] = `non-file:${info.mode}`;
		} catch {
			untrackedHashes[path] = "missing";
		}
	}

	return {
		branch,
		status,
		diffHash: hashText(diff),
		stagedDiffHash: hashText(stagedDiff),
		untrackedHashes,
		createdAt: nowIso(),
	};
}

export async function diffStat(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd) {
	const [unstaged, staged] = await Promise.all([
		execOk(pi, ctx, "git", ["diff", "--stat"], 60_000, cwd),
		execOk(pi, ctx, "git", ["diff", "--cached", "--stat"], 60_000, cwd),
	]);
	return [staged && "# staged\n" + staged, unstaged && "# unstaged\n" + unstaged].filter(Boolean).join("\n\n");
}

export async function changedFiles(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd) {
	const [unstaged, staged, untracked] = await Promise.all([
		execOk(pi, ctx, "git", ["diff", "--name-only"], 60_000, cwd),
		execOk(pi, ctx, "git", ["diff", "--cached", "--name-only"], 60_000, cwd),
		execOk(pi, ctx, "git", ["ls-files", "--others", "--exclude-standard"], 60_000, cwd),
	]);
	return [...new Set([...unstaged.split("\n"), ...staged.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean))].sort();
}

export function createRunId(prdNumber: number, head: string) {
	return `${prdNumber}-${Date.now().toString(36)}-${head.slice(0, 8)}`;
}

export function integrationBranch(runId: string) {
	return `ralph/${runId}/integration`;
}

export function issueBranch(runId: string, issueNumber: number) {
	return `ralph/${runId}/issue-${issueNumber}`;
}

export function defaultWorktreeBase(repo: RepoInfo, runId: string, config: RalphConfig) {
	return config.worktreeBase?.trim() ? resolve(config.worktreeBase.trim(), runId) : join(repo.commonGitDir, "ralph", "worktrees", runId);
}

export function integrationCwd(state: RalphState) {
	assertV2State(state);
	return worktreeCwd(state, state.integration.path);
}

export function worktreeCwd(state: RalphState, worktreePath: string) {
	const rel = relative(state.repoRoot, state.cwd) || ".";
	if (rel === ".") return worktreePath;
	const candidate = join(worktreePath, rel);
	return existsSync(candidate) ? candidate : worktreePath;
}

export async function revParse(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, rev = "HEAD") {
	return execOk(pi, ctx, "git", ["rev-parse", rev], 20_000, cwd);
}

export async function branchExists(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, branch: string) {
	const result = await execRaw(pi, ctx, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], 20_000, cwd);
	return result.code === 0;
}

export async function commonGitDirForCwd(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string) {
	try {
		return await execOk(pi, ctx, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000, cwd);
	} catch {
		const raw = await execOk(pi, ctx, "git", ["rev-parse", "--git-common-dir"], 10_000, cwd);
		return raw.startsWith("/") ? raw : resolve(cwd, raw);
	}
}

export async function validateExistingWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphState,
	path: string,
	branch: string,
	options: { expectedHead?: string; requireClean?: boolean } = {},
) {
	const top = await execOk(pi, ctx, "git", ["rev-parse", "--show-toplevel"], 10_000, path);
	if (resolve(top) !== resolve(path)) throw new Error(`Ralph worktree path ${path} resolves to unexpected repo root ${top}.`);
	const common = await commonGitDirForCwd(pi, ctx, path);
	if (resolve(common) !== resolve(state.commonGitDir ?? state.gitDir)) throw new Error(`Ralph worktree ${path} belongs to different git common dir.`);
	const actualBranch = await execOk(pi, ctx, "git", ["branch", "--show-current"], 10_000, path);
	if (actualBranch !== branch) throw new Error(`Ralph worktree ${path} is on ${actualBranch || "detached HEAD"}, expected ${branch}.`);
	if (options.expectedHead) {
		const head = await revParse(pi, ctx, path);
		if (head !== options.expectedHead) throw new Error(`Ralph worktree ${path} HEAD ${head} != expected ${options.expectedHead}.`);
	}
	if (options.requireClean) await assertCleanTree(pi, ctx, path, `Ralph worktree ${path}`);
}

export async function ensureWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphState,
	path: string,
	branch: string,
	startPoint: string,
) {
	if (existsSync(join(path, ".git"))) {
		await validateExistingWorktree(pi, ctx, state, path, branch);
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	const exists = await branchExists(pi, ctx, state.repoRoot, branch);
	const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, startPoint];
	await execOk(pi, ctx, "git", args, 120_000, state.repoRoot);
	await validateExistingWorktree(pi, ctx, state, path, branch);
	const config = await readConfig();
	const setup = await resolveSetupCommand(state.repoRoot, config);
	if (setup) {
		emit(pi, `Ralph installing dependencies in ${path} (${setup}).`);
		const res = await execRaw(pi, ctx, "bash", ["-lc", setup], config.setupTimeoutMs ?? 600_000, path);
		if (res.code !== 0) emit(pi, `Ralph worktree setup ('${setup}') failed in ${path}; checks may resolve wrong tool versions.\n${cap([res.stderr, res.stdout].join("\n"), 4_000)}`);
	}
}

export async function ensureIntegrationWorktree(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	assertV2State(state);
	await ensureWorktree(pi, ctx, state, state.integration.path, state.integration.branch, state.originalHead);
	state.integration.head = await revParse(pi, ctx, state.integration.path);
}

export async function ensureWorkerWorktree(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, issue: IssueInfo, currentSnapshot: DiffSnapshot) {
	assertV2State(state);
	await ensureIntegrationWorktree(pi, ctx, state);
	const existing = getRunningIssue(state, issue.number);
	const branch = existing?.branch ?? issueBranch(state.runId, issue.number);
	const worktreePath = existing?.worktreePath ?? join(state.worktreeBase, `issue-${issue.number}`);
	const baseHead = existing?.baseHead ?? await revParse(pi, ctx, state.integration.path);
	await ensureWorktree(pi, ctx, state, worktreePath, branch, baseHead);
	if (!existing?.sessionFile) await validateExistingWorktree(pi, ctx, state, worktreePath, branch, { expectedHead: baseHead, requireClean: true });
	const cwd = worktreeCwd(state, worktreePath);
	const running: RunningIssue = {
		number: issue.number,
		title: issue.title,
		status: existing?.status ?? "spawning",
		startedAt: existing?.startedAt ?? nowIso(),
		sessionFile: existing?.sessionFile,
		beforeSnapshot: existing?.beforeSnapshot ?? currentSnapshot,
		branch,
		worktreePath,
		cwd,
		baseHead,
	};
	setRunningIssue(state, running);
	return running;
}
