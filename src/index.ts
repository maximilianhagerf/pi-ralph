import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const VERSION = 2;
const LEGACY_VERSION = 1;
const SPAWN_MARKER = "<ralph-spawn-request";
const STATE_CUSTOM_TYPE = "ralph-state";
const SUMMARY_LIMIT = 8_000;
const WARN_TOKENS = 90_000;
const COMPACT_TOKENS = 100_000;
const HARD_STOP_TOKENS = 115_000;
const DEFAULT_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_MAX_CONFLICT_RESOLVER_ATTEMPTS = 2;
const DEFAULT_MAX_VERIFIER_FIX_ATTEMPTS = 3;
const DEFAULT_MAX_PROVIDER_RETRIES = 3;
const VERIFIER_TOOL_ALLOWLIST = "read,grep,find,ls";

type RalphMode = "afk" | "hitl" | "once";
type WorkerStatus = "success" | "blocked" | "failed" | "unknown";
type RunningStatus = "spawning" | "running" | "pending-merge" | "merging" | "conflict" | "failed";
type SpawnStatus = "spawning" | "running" | "failed";

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

type RepoInfo = {
	repoRoot: string;
	gitDir: string;
	commonGitDir: string;
	branch: string;
	head: string;
	repo: string;
};

type IssueInfo = {
	number: number;
	title: string;
	body: string;
	state: string;
	url?: string;
};

type DiffSnapshot = {
	branch: string;
	status: string;
	diffHash: string;
	stagedDiffHash: string;
	untrackedHashes: Record<string, string>;
	createdAt: string;
};

type CompletedIssue = {
	number: number;
	title: string;
	completedAt: string;
	status: "success";
	sessionFile?: string;
	elapsed?: number;
	summary: string;
	changedFiles: string[];
	diffStat: string;
	workerBranch?: string;
	workerCommit?: string;
	workerWorktreePath?: string;
	mergeCommit?: string;
};

type RunningIssue = {
	number: number;
	title: string;
	status: RunningStatus;
	startedAt: string;
	sessionFile?: string;
	beforeSnapshot: DiffSnapshot;
	branch?: string;
	worktreePath?: string;
	cwd?: string;
	baseHead?: string;
	task?: string;
};

type WorktreeState = {
	path: string;
	branch: string;
	createdAt: string;
	head?: string;
};

type PendingWorkerResult = {
	number: number;
	title: string;
	receivedAt: string;
	sessionFile?: string;
	elapsed?: number;
	summary: string;
	workerBranch: string;
	workerWorktreePath: string;
	baseHead?: string;
	changedFiles: string[];
	diffStat: string;
	workerCommit?: string;
};

type ConflictState = {
	issueNumber: number;
	branch: string;
	worktreePath: string;
	attempt: number;
	status: SpawnStatus;
	startedAt: string;
	preMergeHead?: string;
	workerCommit?: string;
	conflictPaths?: string[];
	task?: string;
	sessionFile?: string;
	lastSummary?: string;
};

type VerifierState = {
	status: "spawning" | "running" | "passed" | "failed";
	attempts: number;
	startedAt?: string;
	completedAt?: string;
	head?: string;
	verifiedHead?: string;
	task?: string;
	sessionFile?: string;
	summary?: string;
	check?: CheckResult;
};

type FixerState = {
	status: SpawnStatus;
	attempt: number;
	startedAt: string;
	baseHead?: string;
	commit?: string;
	task?: string;
	sessionFile?: string;
	summary?: string;
};

type RalphState = {
	version: number;
	active: boolean;
	mode: RalphMode;
	maxIterations: number;
	startedAt: string;
	updatedAt: string;
	cwd: string;
	repoRoot: string;
	gitDir: string;
	commonGitDir?: string;
	repo: string;
	branch: string;
	originalHead?: string;
	runId?: string;
	worktreeBase?: string;
	integration?: WorktreeState;
	prd: { number: number; title: string; url?: string };
	issueOrder: number[];
	issues: Record<string, IssueInfo>;
	completed: Record<string, CompletedIssue>;
	/** Legacy/current primary running issue. Kept for old ledgers and compact status. */
	current?: RunningIssue;
	/** All active Ralph workers, keyed by GitHub issue number. */
	running?: Record<string, RunningIssue>;
	mergeQueue?: number[];
	pendingResults?: Record<string, PendingWorkerResult>;
	conflict?: ConflictState;
	verifier?: VerifierState;
	fixer?: FixerState;
	verifierFixAttempts?: number;
	providerRetries?: number;
	/** Issues a worker reported blocked (issue number -> reason). AFK skips + reports these. */
	blocked?: Record<string, string>;
	/** Per-issue worker crash-retry counts (issue number -> attempts), bounded by maxIterations. */
	workerRetries?: Record<string, number>;
	readyToFinish?: boolean;
	verifiedHead?: string;
	fixerCommits?: string[];
	baselineSnapshot: DiffSnapshot;
	lastSnapshot: DiffSnapshot;
	lastResultSummary?: string;
	stopReason?: string;
	finishedAt?: string;
	finalCheck?: CheckResult;
	finalizedIssues?: number[];
	exportedAt?: string;
	exportedHead?: string;
	pushedAt?: string;
	cleanedAt?: string;
	processedResultKeys?: string[];
	pendingSubagentMessages?: Array<{ sessionFile?: string; name: string; elapsed?: number }>;
	autoFinish?: boolean;
};

type RalphConfig = {
	fullCheckCommand?: string;
	checkTimeoutMs?: number;
	workerAgent?: string;
	workerModel?: string;
	workerTools?: string;
	workerSkills?: string;
	conflictResolverAgent?: string;
	conflictResolverModel?: string;
	conflictResolverTools?: string;
	conflictResolverSkills?: string;
	prdVerifierAgent?: string;
	prdVerifierModel?: string;
	prdVerifierTools?: string;
	prdVerifierSkills?: string;
	fixerAgent?: string;
	fixerModel?: string;
	fixerTools?: string;
	fixerSkills?: string;
	maxConcurrent?: number;
	maxConflictResolverAttempts?: number;
	maxVerifierFixAttempts?: number;
	maxProviderRetries?: number;
	contextWarnTokens?: number;
	contextCompactTokens?: number;
	contextHardStopTokens?: number;
	worktreeBase?: string;
	autoFinish?: boolean;
	setupCommand?: string;
	setupTimeoutMs?: number;
};

type CheckPlan = {
	command?: string;
	reason: string;
};

type CheckResult = {
	ok: boolean;
	command?: string;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	noCommand?: boolean;
};

type RalphSubagentSpec =
	| { kind: "worker"; issueNumber: number }
	| { kind: "conflict"; issueNumber: number }
	| { kind: "verifier" }
	| { kind: "fixer" };

let previousTokens: number | undefined;
let pendingRalphSubagentMessages: any[] = [];
const processedResultKeys = new Set<string>();
let mergeDrainInFlight = false;

function nowIso() {
	return new Date().toISOString();
}

function cap(text: string, max = SUMMARY_LIMIT) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[ralph: truncated ${text.length - max} chars]`;
}

function textContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n");
}

function messageText(message: any): string {
	return textContent(message?.content);
}

function isRalphSpawnMessage(message: any): boolean {
	return message?.role === "user" && messageText(message).includes(SPAWN_MARKER);
}

function parseRalphSubagentName(name: unknown): RalphSubagentSpec | undefined {
	if (typeof name !== "string") return undefined;
	let match = name.match(/^Ralph #(\d+)(?: .+)?$/);
	if (match) return { kind: "worker", issueNumber: Number(match[1]) };
	match = name.match(/^Ralph conflict #(\d+)$/);
	if (match) return { kind: "conflict", issueNumber: Number(match[1]) };
	if (name === "Ralph verifier") return { kind: "verifier" };
	if (name === "Ralph fixer") return { kind: "fixer" };
	return undefined;
}

function isRalphSubagentMessage(message: any): boolean {
	return (
		message?.role === "custom" &&
		(message.customType === "subagent_result" || message.customType === "subagent_ping") &&
		Boolean(parseRalphSubagentName(message.details?.name))
	);
}

function issueNumberFromName(name: unknown): number | undefined {
	const spec = parseRalphSubagentName(name);
	return spec && "issueNumber" in spec ? spec.issueNumber : undefined;
}

function hashText(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

function hashFile(path: string): Promise<string> {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function positiveInt(raw: string | undefined, fallback: number, label: string) {
	const value = raw?.trim() ? Number(raw.trim()) : fallback;
	if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be positive integer.`);
	return value;
}

function statePathFor(gitDir: string) {
	return join(gitDir, "ralph", "state.json");
}

function configPath() {
	return join(homedir(), ".pi", "agent", "extensions", "ralph", "config.json");
}

async function readConfig(): Promise<RalphConfig> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return {};
	}
}

async function execRaw(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	args: string[],
	timeout = 60_000,
	cwd?: string,
): Promise<ExecResult> {
	const options: any = { signal: ctx.signal, timeout };
	if (cwd) options.cwd = cwd;
	return (await pi.exec(command, args, options)) as ExecResult;
}

async function execOk(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	args: string[],
	timeout = 60_000,
	cwd?: string,
): Promise<string> {
	const result = await execRaw(pi, ctx, command, args, timeout, cwd);
	if (result.code !== 0) {
		const rendered = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
		throw new Error(`${command} ${args.join(" ")} failed${rendered ? `:\n${rendered}` : ""}`);
	}
	return result.stdout.trim();
}

async function getRepoInfo(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd): Promise<RepoInfo> {
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

async function ensureGhAuth(pi: ExtensionAPI, ctx: ExtensionContext) {
	const result = await execRaw(pi, ctx, "gh", ["auth", "status"], 20_000);
	if (result.code !== 0) {
		throw new Error("GitHub CLI not authenticated. Fix: gh auth login");
	}
}

function ensureSubagentTool(pi: ExtensionAPI) {
	const allNames = new Set((pi.getAllTools?.() ?? []).map((tool: any) => tool?.name ?? tool));
	if (!allNames.has("subagent")) {
		throw new Error("HazAT subagent tool missing. Install/enable pi-interactive-subagents, then /reload.");
	}
	const activeRaw = pi.getActiveTools?.();
	if (Array.isArray(activeRaw) && activeRaw.length > 0) {
		const activeNames = new Set(activeRaw.map((tool: any) => tool?.name ?? tool));
		if (!activeNames.has("subagent")) throw new Error("Ralph requires active subagent tool. Enable subagent tool, then retry.");
	}
}

async function gitStatus(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd) {
	return execOk(pi, ctx, "git", ["status", "--porcelain=v1", "--untracked-files=all"], 20_000, cwd);
}

async function assertCleanTree(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd, label = "Working tree") {
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
async function cleanIntegrationTree(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<string> {
	await execRaw(pi, ctx, "git", ["restore", "."], 30_000, cwd);
	await execRaw(pi, ctx, "git", ["clean", "-fd"], 30_000, cwd);
	return dirtyStatusIgnoringWorktrees(pi, ctx, cwd);
}

// Registered git worktrees nested under cwd (e.g. .claude/worktrees/agent-* created by the agent
// harness) are separate checkouts, not dirt; gitStatus(--untracked-files=all) lists each as an
// untracked entry and would wrongly fail a "clean tree?" gate. Subtract them before judging.
// (git clean -fd already skips nested worktrees — "Would skip repository …" — so cleaning is safe.)
async function dirtyStatusIgnoringWorktrees(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<string> {
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

async function getDiffSnapshot(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd): Promise<DiffSnapshot> {
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

async function diffStat(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd) {
	const [unstaged, staged] = await Promise.all([
		execOk(pi, ctx, "git", ["diff", "--stat"], 60_000, cwd),
		execOk(pi, ctx, "git", ["diff", "--cached", "--stat"], 60_000, cwd),
	]);
	return [staged && "# staged\n" + staged, unstaged && "# unstaged\n" + unstaged].filter(Boolean).join("\n\n");
}

async function changedFiles(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd) {
	const [unstaged, staged, untracked] = await Promise.all([
		execOk(pi, ctx, "git", ["diff", "--name-only"], 60_000, cwd),
		execOk(pi, ctx, "git", ["diff", "--cached", "--name-only"], 60_000, cwd),
		execOk(pi, ctx, "git", ["ls-files", "--others", "--exclude-standard"], 60_000, cwd),
	]);
	return [...new Set([...unstaged.split("\n"), ...staged.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean))].sort();
}

async function loadStateForRepo(repo: RepoInfo): Promise<RalphState | null> {
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

function runningEntries(state: RalphState): RunningIssue[] {
	const byNumber = new Map<number, RunningIssue>();
	for (const running of Object.values(state.running ?? {})) byNumber.set(running.number, running);
	if (state.current) byNumber.set(state.current.number, byNumber.get(state.current.number) ?? state.current);
	return [...byNumber.values()].sort((a, b) => {
		const ai = state.issueOrder.indexOf(a.number);
		const bi = state.issueOrder.indexOf(b.number);
		return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi) || a.number - b.number;
	});
}

function normalizeRunning(state: RalphState): RunningIssue[] {
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

function activeRunningEntries(state: RalphState): RunningIssue[] {
	return runningEntries(state).filter((running) => running.status !== "failed");
}

function getRunningIssue(state: RalphState, issueNumber: number): RunningIssue | undefined {
	return runningEntries(state).find((running) => running.number === issueNumber);
}

function setRunningIssue(state: RalphState, running: RunningIssue) {
	state.running ??= {};
	state.running[String(running.number)] = running;
	normalizeRunning(state);
}

function removeRunningIssue(state: RalphState, issueNumber: number) {
	if (state.running) delete state.running[String(issueNumber)];
	if (state.current?.number === issueNumber) delete state.current;
	normalizeRunning(state);
}

function assertV2State(state: RalphState): asserts state is RalphState & {
	runId: string;
	worktreeBase: string;
	integration: WorktreeState;
	originalHead: string;
} {
	if (state.version !== VERSION || !state.runId || !state.worktreeBase || !state.integration || !state.originalHead) {
		throw new Error("Ralph ledger is legacy v1/shared-worktree. Use /ralph-status, /ralph-finish, or /ralph-clear; /ralph-resume refuses migration.");
	}
}

async function saveState(pi: ExtensionAPI, state: RalphState) {
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

function renderState(state: RalphState) {
	const completed = Object.keys(state.completed).map(Number).sort((a, b) => a - b);
	const running = runningEntries(state);
	const runningNumbers = new Set(activeRunningEntries(state).map((issue) => issue.number));
	const remaining = state.issueOrder.filter((n) => !state.completed[String(n)] && !runningNumbers.has(n) && state.issues[String(n)]?.state !== "CLOSED");
	return [
		`Ralph ${state.active ? "active" : "stopped"}: PRD #${state.prd.number} ${state.prd.title}`,
		`Version: ${state.version ?? LEGACY_VERSION}${state.version === VERSION && state.runId ? ` (${state.runId})` : ""}`,
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

function emit(pi: ExtensionAPI, content: string, details?: any) {
	pi.sendMessage({ customType: "ralph", content, display: true, details });
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function parseLinkedIssues(body: string, prdNumber: number): number[] {
	const hits: Array<{ number: number; index: number }> = [];
	for (const match of body.matchAll(/(^|[^\w/])#([1-9]\d*)\b/g)) {
		hits.push({ number: Number(match[2]), index: match.index ?? 0 });
	}
	for (const match of body.matchAll(/https?:\/\/[^\s)]+\/issues\/([1-9]\d*)/g)) {
		hits.push({ number: Number(match[1]), index: match.index ?? 0 });
	}
	hits.sort((a, b) => a.index - b.index);
	const seen = new Set<number>();
	const ordered: number[] = [];
	for (const hit of hits) {
		if (hit.number === prdNumber || seen.has(hit.number)) continue;
		seen.add(hit.number);
		ordered.push(hit.number);
	}
	return ordered;
}

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bodyReferencesIssue(body: string, repo: string, issueNumber: number) {
	const repoPattern = escapeRegex(repo);
	const urlRef = new RegExp(`https?:\\/\\/github\\.com\\/${repoPattern}\\/issues\\/${issueNumber}\\b`, "i");
	const localRef = new RegExp(`(^|[^\\w/])#${issueNumber}\\b`);
	return urlRef.test(body) || localRef.test(body);
}

function mergeIssueNumbers(...groups: number[][]) {
	const seen = new Set<number>();
	const merged: number[] = [];
	for (const group of groups) {
		for (const number of group) {
			if (seen.has(number)) continue;
			seen.add(number);
			merged.push(number);
		}
	}
	return merged;
}

async function fetchIssuesReferencingPrd(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repo: string,
	prdNumber: number,
): Promise<IssueInfo[]> {
	const raw = await execOk(pi, ctx, "gh", [
		"issue",
		"list",
		"--repo",
		repo,
		"--state",
		"all",
		"--limit",
		"1000",
		"--json",
		"number,title,body,state,url",
	], 30_000);
	const parsed = JSON.parse(raw) as IssueInfo[];
	return parsed
		.filter((issue) => issue.number !== prdNumber && bodyReferencesIssue(issue.body ?? "", repo, prdNumber))
		.map((issue) => ({
			number: issue.number,
			title: issue.title ?? "",
			body: issue.body ?? "",
			state: issue.state ?? "UNKNOWN",
			url: issue.url,
		}))
		.sort((a, b) => a.number - b.number);
}

async function fetchIssue(pi: ExtensionAPI, ctx: ExtensionContext, repo: string, issueNumber: number): Promise<IssueInfo> {
	const raw = await execOk(pi, ctx, "gh", [
		"issue",
		"view",
		String(issueNumber),
		"--repo",
		repo,
		"--json",
		"number,title,body,state,url",
	], 30_000);
	const parsed = JSON.parse(raw);
	return {
		number: parsed.number,
		title: parsed.title ?? "",
		body: parsed.body ?? "",
		state: parsed.state ?? "UNKNOWN",
		url: parsed.url,
	};
}

async function fetchPrdAndChildren(pi: ExtensionAPI, ctx: ExtensionContext, repo: string, prdNumber: number) {
	const prd = await fetchIssue(pi, ctx, repo, prdNumber);
	const directLinks = parseLinkedIssues(prd.body, prdNumber);
	const backlinkedIssues = await fetchIssuesReferencingPrd(pi, ctx, repo, prdNumber);
	const linked = mergeIssueNumbers(directLinks, backlinkedIssues.map((issue) => issue.number));
	if (linked.length === 0) {
		throw new Error(
			`PRD #${prdNumber} has no child issue refs. Add #123/issue URLs to the PRD body or put PRD #${prdNumber}/URL in child issue bodies.`,
		);
	}
	const issues: Record<string, IssueInfo> = {};
	for (const issue of backlinkedIssues) {
		issues[String(issue.number)] = issue;
	}
	for (const number of linked) {
		issues[String(number)] ??= await fetchIssue(pi, ctx, repo, number);
	}
	return { prd, issueOrder: linked, issues };
}

async function refreshIssueStates(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	const raw = await execOk(pi, ctx, "gh", [
		"issue", "list",
		"--repo", state.repo,
		"--state", "all",
		"--limit", "1000",
		"--json", "number,title,body,state,url",
	], 30_000);
	const all = JSON.parse(raw) as IssueInfo[];
	const byNumber = new Map(all.map((issue) => [issue.number, issue]));
	for (const number of state.issueOrder) {
		const found = byNumber.get(number);
		if (found) {
			state.issues[String(number)] = {
				number: found.number,
				title: found.title ?? "",
				body: found.body ?? "",
				state: found.state ?? "UNKNOWN",
				url: found.url,
			};
		} else {
			try {
				state.issues[String(number)] = await fetchIssue(pi, ctx, state.repo, number);
			} catch (error) {
				throw new Error(`Linked issue #${number} missing or inaccessible. ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

function issueCompletedOrClosed(state: RalphState, issueNumber: number) {
	return Boolean(state.completed[String(issueNumber)] || state.issues[String(issueNumber)]?.state === "CLOSED");
}

function remainingIssues(state: RalphState): IssueInfo[] {
	const runningNumbers = new Set(activeRunningEntries(state).map((running) => running.number));
	return state.issueOrder
		.map((number) => state.issues[String(number)])
		.filter((issue): issue is IssueInfo => Boolean(issue))
		.filter((issue) => issue.state !== "CLOSED" && !state.completed[String(issue.number)] && !runningNumbers.has(issue.number) && !state.blocked?.[String(issue.number)]);
}

// Worker-reported blockers (issue -> reason). In AFK these are skipped, not fatal, and listed
// in the final report so a completed run surfaces everything that still needs a human.
function blockedSummary(state: RalphState): string {
	const entries = Object.entries(state.blocked ?? {});
	if (entries.length === 0) return "";
	return `\n\nBlocked (needs you): ${entries.map(([n, reason]) => `#${n} — ${reason}`).join("; ")}`;
}

function blockedBySection(body: string): string {
	const match = body.match(/^##\s+Blocked by\b([\s\S]*?)(?=^##\s+|(?![\s\S]))/im);
	return match?.[1]?.trim() ?? "";
}

function blockersForIssue(state: RalphState, issue: IssueInfo): number[] {
	const childNumbers = new Set(state.issueOrder);
	const section = blockedBySection(issue.body ?? "");
	if (!section || /\bnone\b/i.test(section)) return [];
	return parseLinkedIssues(section, issue.number).filter((number) => childNumbers.has(number) && number !== issue.number);
}

function unresolvedBlockers(state: RalphState, issue: IssueInfo): number[] {
	return blockersForIssue(state, issue).filter((number) => !issueCompletedOrClosed(state, number));
}

function runnableIssues(state: RalphState): IssueInfo[] {
	return remainingIssues(state).filter((issue) => unresolvedBlockers(state, issue).length === 0);
}

function blockedIssueSummary(state: RalphState) {
	return remainingIssues(state)
		.map((issue) => {
			const blockers = unresolvedBlockers(state, issue);
			return blockers.length ? `#${issue.number} waits for ${blockers.map((n) => `#${n}`).join(", ")}` : undefined;
		})
		.filter(Boolean)
		.join("; ");
}

async function packageManager(repoRoot: string) {
	if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun";
	if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
	return "npm";
}

function runScriptCommand(pm: string, script: string) {
	if (pm === "bun") return `bun ${script}`;
	if (pm === "pnpm") return `pnpm run ${script}`;
	if (pm === "yarn") return `yarn ${script}`;
	return `npm run ${script}`;
}

// Fresh git worktrees have no node_modules (gitignored), which makes package
// managers resolve stray global tool versions instead of the project's pinned
// ones. Install deps once per worktree so checks run against pinned tooling.
async function resolveSetupCommand(repoRoot: string, config: RalphConfig): Promise<string | undefined> {
	if (config.setupCommand !== undefined) return config.setupCommand.trim() || undefined; // "" disables
	if (!existsSync(join(repoRoot, "package.json"))) return undefined;
	const pm = await packageManager(repoRoot);
	// Prefer frozen/ci variants: reproduce pinned deps, no lockfile mutation. Fall back to plain install if no lockfile.
	if (pm === "pnpm") return existsSync(join(repoRoot, "pnpm-lock.yaml")) ? "pnpm install --frozen-lockfile" : "pnpm install";
	if (pm === "bun") return existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb")) ? "bun install --frozen-lockfile" : "bun install";
	if (pm === "yarn") return existsSync(join(repoRoot, "yarn.lock")) ? "yarn install --frozen-lockfile" : "yarn install";
	return existsSync(join(repoRoot, "package-lock.json")) ? "npm ci" : "npm install";
}

async function resolveCheckPlan(repoRoot: string, config: RalphConfig): Promise<CheckPlan> {
	if (config.fullCheckCommand?.trim()) return { command: config.fullCheckCommand.trim(), reason: "config" };
	const pkgPath = join(repoRoot, "package.json");
	if (!existsSync(pkgPath)) return { reason: "no package.json" };
	try {
		const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
		const scripts = pkg.scripts ?? {};
		const pm = await packageManager(repoRoot);
		if (scripts.check) return { command: runScriptCommand(pm, "check"), reason: "package script check" };
		const inferred = ["typecheck", "lint", "test"].filter((script) => scripts[script]).map((script) => runScriptCommand(pm, script));
		if (inferred.length > 0) return { command: inferred.join(" && "), reason: "inferred package scripts" };
		return { reason: "no check/typecheck/lint/test scripts" };
	} catch {
		return { reason: "invalid package.json" };
	}
}

async function runFullCheck(pi: ExtensionAPI, ctx: ExtensionContext, repoRoot: string, config: RalphConfig): Promise<CheckResult> {
	const plan = await resolveCheckPlan(repoRoot, config);
	if (!plan.command) return { ok: true, noCommand: true };
	const result = await execRaw(pi, ctx, "bash", ["-lc", plan.command], config.checkTimeoutMs ?? 600_000, repoRoot);
	return {
		ok: result.code === 0,
		command: plan.command,
		exitCode: result.code,
		stdout: cap(result.stdout, 6_000),
		stderr: cap(result.stderr, 6_000),
	};
}

function formatCheckResult(result: CheckResult) {
	if (result.noCommand) return "No check command configured.";
	const chunks = [`$ ${result.command}`, result.ok ? "PASS" : `FAIL (exit ${result.exitCode})`];
	if (result.stdout?.trim()) chunks.push("stdout:\n" + result.stdout.trim());
	if (result.stderr?.trim()) chunks.push("stderr:\n" + result.stderr.trim());
	return chunks.join("\n");
}

function parseWorkerStatus(summary: string): WorkerStatus {
	const match = summary.match(/^\s*Status\s*:\s*(success|succeeded|complete|completed|done|pass|passed|blocked|failed|failure)\b/im);
	if (!match) return "unknown";
	const raw = match[1].toLowerCase();
	if (["success", "succeeded", "complete", "completed", "done", "pass", "passed"].includes(raw)) return "success";
	if (raw === "blocked") return "blocked";
	return "failed";
}

function stripSubagentWrapper(content: string) {
	return content
		.replace(/^Sub-agent "Ralph[^"]*" completed \([^)]*\)\.\n\n/, "")
		.replace(/^Sub-agent "Ralph[^"]*" failed \(exit code \d+\)\.\n\n/, "")
		.replace(/\n\nSession: .+\nResume: .+$/s, "")
		.trim();
}

async function assertSameRunContext(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState): Promise<RepoInfo> {
	const repo = await getRepoInfo(pi, ctx);
	if (repo.repoRoot !== state.repoRoot) throw new Error(`Ralph ledger is for ${state.repoRoot}, current repo is ${repo.repoRoot}`);
	if (repo.branch !== state.branch) throw new Error(`Ralph ledger is for branch ${state.branch}, current branch is ${repo.branch}`);
	return repo;
}

async function ensureContextBudget(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, config: RalphConfig) {
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

function createRunId(prdNumber: number, head: string) {
	return `${prdNumber}-${Date.now().toString(36)}-${head.slice(0, 8)}`;
}

function integrationBranch(runId: string) {
	return `ralph/${runId}/integration`;
}

function issueBranch(runId: string, issueNumber: number) {
	return `ralph/${runId}/issue-${issueNumber}`;
}

function defaultWorktreeBase(repo: RepoInfo, runId: string, config: RalphConfig) {
	return config.worktreeBase?.trim() ? resolve(config.worktreeBase.trim(), runId) : join(repo.commonGitDir, "ralph", "worktrees", runId);
}

function integrationCwd(state: RalphState) {
	assertV2State(state);
	return worktreeCwd(state, state.integration.path);
}

function worktreeCwd(state: RalphState, worktreePath: string) {
	const rel = relative(state.repoRoot, state.cwd) || ".";
	if (rel === ".") return worktreePath;
	const candidate = join(worktreePath, rel);
	return existsSync(candidate) ? candidate : worktreePath;
}

async function revParse(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, rev = "HEAD") {
	return execOk(pi, ctx, "git", ["rev-parse", rev], 20_000, cwd);
}

async function branchExists(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, branch: string) {
	const result = await execRaw(pi, ctx, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], 20_000, cwd);
	return result.code === 0;
}

async function commonGitDirForCwd(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string) {
	try {
		return await execOk(pi, ctx, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000, cwd);
	} catch {
		const raw = await execOk(pi, ctx, "git", ["rev-parse", "--git-common-dir"], 10_000, cwd);
		return raw.startsWith("/") ? raw : resolve(cwd, raw);
	}
}

async function validateExistingWorktree(
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

async function ensureWorktree(
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

async function ensureIntegrationWorktree(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
	assertV2State(state);
	await ensureWorktree(pi, ctx, state, state.integration.path, state.integration.branch, state.originalHead);
	state.integration.head = await revParse(pi, ctx, state.integration.path);
}

async function ensureWorkerWorktree(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, issue: IssueInfo, currentSnapshot: DiffSnapshot) {
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

async function unmergedPaths(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string) {
	const raw = await execOk(pi, ctx, "git", ["diff", "--name-only", "--diff-filter=U"], 30_000, cwd);
	return raw.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function commitWorkerChanges(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, pending: PendingWorkerResult) {
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

async function commitIntegrationChanges(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, message: string) {
	const status = await gitStatus(pi, ctx, cwd);
	if (!status.trim()) return undefined;
	await execOk(pi, ctx, "git", ["add", "-A"], 120_000, cwd);
	await execOk(pi, ctx, "git", ["commit", "-m", message], 120_000, cwd);
	return revParse(pi, ctx, cwd);
}

async function mergeWorkerIntoIntegration(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, pending: PendingWorkerResult) {
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

function enqueueMerge(state: RalphState, issueNumber: number) {
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

async function markIssueMerged(
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

async function buildWorkerTask(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RalphState,
	issue: IssueInfo,
	running: RunningIssue,
	config: RalphConfig,
) {
	const checkPlan = await resolveCheckPlan(running.worktreePath ?? state.repoRoot, config);
	return `# Ralph worker task\n\nImplement exactly one GitHub issue in your assigned isolated git worktree.\n\nRepository: ${state.repo}\nCoordinator checkout (do not touch): ${state.repoRoot}\nAssigned worktree: ${running.worktreePath}\nAssigned branch: ${running.branch}\nWorking directory: ${running.cwd ?? running.worktreePath}\nPRD: #${state.prd.number} — ${state.prd.title}\nIssue: #${issue.number} — ${issue.title}\nIssue URL: ${issue.url ?? ""}\n\n## Issue body\n\n${issue.body || "(empty)"}\n\n## Hard rules\n\n1. Read CLAUDE.md before changes if it exists in the assigned worktree.\n2. Implement ONLY issue #${issue.number}. Do not start other PRD issues.\n3. Stay in assigned worktree and assigned branch. Do not switch branches or worktrees.\n4. Do NOT commit. Ralph commits your diff after success.\n5. Do NOT push.\n6. Do NOT close, edit, comment on, or update checkbox state in any GitHub issue. Local code changes only.\n7. Do NOT read/write parent checkout or sibling Ralph worktrees.\n8. Do NOT spawn subagents. If blocked, report blocker and stop.\n9. Run targeted/cheap checks relevant to changed files. Fix failures you caused.\n10. Full final check is run by Ralph later: ${checkPlan.command ?? `none configured (${checkPlan.reason})`}.\n11. Document new public functions, components, modules, and non-obvious behavior.\n12. If issue is already satisfied, make no changes and report success with explanation.\n13. Do NOT run dependency/tooling migrations (e.g. 'biome migrate', 'eslint --init', codemods) or modify lockfiles or tool config (biome.json, tsconfig.json, package.json, .eslintrc, etc.) unless this issue explicitly requires it. If a check fails from a tooling/version/config mismatch rather than your code, report blocked with the exact error; do not fix the environment.\n\n## Final response format (required exactly)\n\nRALPH_WORKER_RESULT\nIssue: #${issue.number} — ${issue.title}\nStatus: success | blocked | failed\nFiles changed:\n- path or none\nChecks:\n- command — pass/fail/not run — note\nRemaining work:\n- item or none\nRisks:\n- item or none\nSummary:\n- concise implementation summary\n`;
}

function buildConflictResolverTask(state: RalphState, issueNumber: number, conflicts: string[], output?: string) {
	assertV2State(state);
	const issue = state.issues[String(issueNumber)];
	return `# Ralph conflict resolver task\n\nResolve active git merge conflicts in the integration worktree.\n\nRepository: ${state.repo}\nIntegration worktree: ${state.integration.path}\nIntegration branch: ${state.integration.branch}\nConflicted issue: #${issueNumber} — ${issue?.title ?? ""}\nConflicted branch: ${state.conflict?.branch ?? ""}\nPRD: #${state.prd.number} — ${state.prd.title}\n\n## Conflicted paths\n${conflicts.length ? conflicts.map((path) => `- ${path}`).join("\n") : "- unknown; inspect git status"}\n\n${output ? `## Merge output\n\n${output}\n` : ""}\n## Hard rules\n\n1. Work only in integration worktree.\n2. Resolve merge conflicts for issue #${issueNumber}; do not broaden scope.\n3. Do not commit. Ralph will stage and commit the merge after validation.\n4. Do not abort the merge unless resolution is impossible; if impossible, report blocked.\n5. Run targeted checks for conflicted files if feasible.\n6. Do not close/edit/comment on GitHub issues.\n7. Do not spawn subagents.\n8. Do NOT run dependency/tooling migrations (e.g. 'biome migrate', codemods) or modify lockfiles or tool config (biome.json, tsconfig.json, package.json, .eslintrc, etc.) unless required to resolve the conflict itself. If a check fails from a tooling/version/config mismatch rather than the conflict, report blocked with the exact error; do not fix the environment.\n\n## Final response format (required exactly)\n\nRALPH_CONFLICT_RESOLVER_RESULT\nIssue: #${issueNumber}\nStatus: success | blocked | failed\nFiles changed:\n- path or none\nChecks:\n- command — pass/fail/not run — note\nRemaining work:\n- item or none\nRisks:\n- item or none\nSummary:\n- concise conflict resolution summary\n`;
}

function buildPrdVerifierTask(state: RalphState, check: CheckResult) {
	assertV2State(state);
	const children = state.issueOrder
		.map((number) => state.issues[String(number)])
		.filter((issue): issue is IssueInfo => Boolean(issue))
		.map((issue) => `## Child #${issue.number} — ${issue.title}\nState: ${issue.state}\nURL: ${issue.url ?? ""}\n\n${issue.body || "(empty)"}`)
		.join("\n\n---\n\n");
	const completed = Object.values(state.completed)
		.sort((a, b) => a.number - b.number)
		.map((issue) => `#${issue.number} ${issue.title}\nCommit: ${issue.mergeCommit ?? issue.workerCommit ?? "none"}\nFiles:\n${issue.changedFiles.length ? issue.changedFiles.map((f) => `- ${f}`).join("\n") : "- none"}\nSummary:\n${issue.summary}`)
		.join("\n\n---\n\n");
	return `# Ralph PRD verifier task\n\nRead-only verification. Check whether the integration worktree satisfies the PRD and all child issues.\n\nRepository: ${state.repo}\nIntegration worktree: ${state.integration.path}\nIntegration branch: ${state.integration.branch}\nPRD: #${state.prd.number} — ${state.prd.title}\nPRD URL: ${state.prd.url ?? ""}\n\n## Full check result\n\n${formatCheckResult(check)}\n\n## PRD body\n\n${state.issues[String(state.prd.number)]?.body ?? "(PRD body not stored; use gh issue view if needed)"}\n\n## Child issues\n\n${children || "(none)"}\n\n## Ralph completed summaries\n\n${completed || "(none)"}\n\n## Hard rules\n\n1. Read-only: do not edit files.\n2. Do not commit, push, or change GitHub issues.\n3. Verify implementation against PRD and all child issue acceptance criteria.\n4. Run cheap read-only inspection commands as needed.\n5. If gaps exist, report failed with exact fix list.\n6. Do not spawn subagents.\n\n## Final response format (required exactly)\n\nRALPH_PRD_VERIFIER_RESULT\nStatus: passed | failed\nChecks reviewed:\n- item\nGaps:\n- item or none\nRegression risks:\n- item or none\nSummary:\n- concise verification summary\n`;
}

function buildFixerTask(state: RalphState, verifierSummary: string, check: CheckResult | undefined) {
	assertV2State(state);
	return `# Ralph verifier fixer task\n\nFix only gaps found by the PRD verifier/check in the integration worktree.\n\nRepository: ${state.repo}\nIntegration worktree: ${state.integration.path}\nIntegration branch: ${state.integration.branch}\nPRD: #${state.prd.number} — ${state.prd.title}\n\n## Verifier/check failure\n\n${verifierSummary}\n\n${check ? `## Latest full check\n\n${formatCheckResult(check)}\n` : ""}\n## Hard rules\n\n1. Work only in integration worktree.\n2. Fix only verifier/check gaps; do not start unrelated work.\n3. Do not commit. Ralph commits your diff after success.\n4. Do not push or change GitHub issues.\n5. Run targeted checks for changed files.\n6. Do not spawn subagents.\n7. Do NOT run dependency/tooling migrations (e.g. 'biome migrate', 'eslint --init', codemods) or modify lockfiles or tool config (biome.json, tsconfig.json, package.json, .eslintrc, etc.) unless the PRD explicitly requires it. If the check fails from a tooling/version/config mismatch rather than code (e.g. a config schema/version warning), report blocked with the exact error; do not fix the environment.\n\n## Final response format (required exactly)\n\nRALPH_FIXER_RESULT\nStatus: success | blocked | failed\nFiles changed:\n- path or none\nChecks:\n- command — pass/fail/not run — note\nRemaining work:\n- item or none\nRisks:\n- item or none\nSummary:\n- concise fix summary\n`;
}

function buildSpawnPrompt(params: Record<string, unknown> | Record<string, unknown>[]) {
	const requests = Array.isArray(params) ? params : [params];
	const instruction = requests.length === 1
		? "Call the subagent tool exactly once with this exact JSON object as arguments, then stop and wait for subagent_result."
		: `Call the subagent tool ${requests.length} times, once for each JSON object below. Make all subagent calls before waiting for results.`;
	return `${SPAWN_MARKER} count="${requests.length}">\nRalph extension request. ${instruction} Do not call other tools. Do not summarize or invent worker results.\n\n${JSON.stringify(requests.length === 1 ? requests[0] : requests, null, 2)}\n</ralph-spawn-request>`;
}

function sendSpawnPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, defer = false) {
	const send = () => {
		if (ctx.isIdle()) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	};
	if (defer) setTimeout(send, 0);
	else send();
}

function applyDefaultSubagentParams(params: Record<string, unknown>, model?: string, tools?: string, skills?: string) {
	params.model = model ?? DEFAULT_MODEL;
	if (tools) params.tools = tools;
	if (skills) params.skills = skills;
	return params;
}

function verifierTools(config: RalphConfig) {
	if (!config.prdVerifierTools?.trim()) return VERIFIER_TOOL_ALLOWLIST;
	const allowed = new Set(VERIFIER_TOOL_ALLOWLIST.split(","));
	const selected = config.prdVerifierTools.split(",").map((tool) => tool.trim()).filter((tool) => allowed.has(tool));
	return selected.length ? selected.join(",") : VERIFIER_TOOL_ALLOWLIST;
}

async function launchNext(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, options: { retrySpawning?: boolean; defer?: boolean } = {}) {
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

async function stopV2WithCheck(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, reason: string) {
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

async function startRun(pi: ExtensionAPI, ctx: ExtensionContext, prdNumber: number, maxIterations: number, mode: RalphMode, autoFinish?: boolean) {
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
	state.baselineSnapshot = await getDiffSnapshot(pi, ctx, state.integration.path);
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

async function loadCurrentState(pi: ExtensionAPI, ctx: ExtensionContext) {
	const repo = await getRepoInfo(pi, ctx);
	const state = await loadStateForRepo(repo);
	return { repo, state };
}

async function processWorkerResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any, issueNumber: number) {
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

async function drainMergeQueue(pi: ExtensionAPI, ctx: ExtensionContext) {
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

async function prepareConflictRetry(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
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

async function launchConflictResolver(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, conflicts?: string[], output?: string) {
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

async function retryOrStopConflict(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, reason: string) {
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

async function processConflictResolverResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any, issueNumber: number) {
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

async function maybeContinueAfterSettled(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
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
			let choice: string;
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

async function beginFinalVerification(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
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

async function launchPrdVerifier(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, check: CheckResult) {
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

async function processPrdVerifierResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any) {
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

async function launchFixerOrStop(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState, reason: string, check?: CheckResult) {
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
async function respawnFixer(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
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
async function retryProviderError(
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

async function processFixerResult(pi: ExtensionAPI, ctx: ExtensionContext, message: any) {
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

async function processWorkerPing(pi: ExtensionAPI, ctx: ExtensionContext, message: any, spec: RalphSubagentSpec) {
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

async function handleResume(pi: ExtensionAPI, ctx: ExtensionContext, args: string) {
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

async function assertBranchFresh(pi: ExtensionAPI, ctx: ExtensionContext, repo: RepoInfo) {
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

async function pushCurrentBranch(pi: ExtensionAPI, ctx: ExtensionContext, repo: RepoInfo) {
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

async function closeCompletedIssues(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
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

async function cleanupRalphWorktrees(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
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

async function handleFinish(pi: ExtensionAPI, ctx: ExtensionContext) {
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

function registerCommands(pi: ExtensionAPI) {
	pi.registerCommand("ralph", {
		description: "Run Ralph AFK loop: /ralph <prd-issue> [max] [false]  — pass false to skip auto-finish",
		handler: async (args, ctx) => {
			try {
				const tokens = parseArgs(args);
				const autoFinish = !tokens.some((t) => t.toLowerCase() === "false");
				const integers = tokens.filter((t) => /^\d+$/.test(t));
				const [prdRaw, maxRaw] = integers;
				if (!prdRaw) throw new Error("Usage: /ralph <prd-issue> [max] [false]");
				await startRun(pi, ctx, Number(prdRaw), positiveInt(maxRaw, 20, "max"), "afk", autoFinish);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
				emit(pi, `Ralph error: ${message}`);
			}
		},
	});

	pi.registerCommand("ralph-once", {
		description: "Implement one PRD-linked issue: /ralph-once <prd-issue>",
		handler: async (args, ctx) => {
			try {
				const [prdRaw] = parseArgs(args);
				if (!prdRaw || !/^\d+$/.test(prdRaw)) throw new Error("Usage: /ralph-once <prd-issue>");
				await startRun(pi, ctx, Number(prdRaw), 1, "once");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
				emit(pi, `Ralph error: ${message}`);
			}
		},
	});

	pi.registerCommand("ralph-start", {
		description: "Interactive Ralph launcher",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.hasUI) throw new Error("/ralph-start requires interactive UI. Use /ralph <prd> [max].");
				const repo = await getRepoInfo(pi, ctx);
				await ensureGhAuth(pi, ctx);
				const raw = await execOk(pi, ctx, "gh", ["issue", "list", "--repo", repo.repo, "--state", "open", "--limit", "100", "--json", "number,title"], 30_000, repo.repoRoot);
				const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
				const choice = await ctx.ui.select("Pick PRD issue", issues.map((issue) => `#${issue.number} ${issue.title}`));
				if (!choice) return;
				const prd = Number(choice.match(/^#(\d+)/)?.[1]);
				const maxRaw = await ctx.ui.input("Max issues", "20");
				const max = positiveInt(maxRaw, 20, "max");
				const modeChoice = await ctx.ui.select("Mode", ["hitl", "afk"]);
				if (modeChoice !== "hitl" && modeChoice !== "afk") return;
				await startRun(pi, ctx, prd, max, modeChoice);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
				emit(pi, `Ralph error: ${message}`);
			}
		},
	});

	pi.registerCommand("ralph-status", {
		description: "Show Ralph ledger/status",
		handler: async (_args, ctx) => {
			try {
				const repo = await getRepoInfo(pi, ctx);
				const state = await loadStateForRepo(repo);
				emit(pi, state ? renderState(state) : "No Ralph ledger.");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				emit(pi, `Ralph status error: ${message}`);
			}
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop active Ralph loop",
		handler: async (_args, ctx) => {
			try {
				const repo = await getRepoInfo(pi, ctx);
				const state = await loadStateForRepo(repo);
				if (!state) return emit(pi, "No Ralph ledger.");
				state.active = false;
				state.stopReason = "Stopped by user.";
				await saveState(pi, state);
				emit(pi, renderState(state));
			} catch (error) {
				emit(pi, `Ralph stop error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	pi.registerCommand("ralph-clear", {
		description: "Clear Ralph ledger: /ralph-clear [prd]",
		handler: async (args, ctx) => {
			try {
				const repo = await getRepoInfo(pi, ctx);
				const state = await loadStateForRepo(repo);
				const [prdRaw] = parseArgs(args);
				if (prdRaw && state && state.prd.number !== Number(prdRaw)) throw new Error(`Ledger PRD is #${state.prd.number}, not #${prdRaw}.`);
				if (state?.version === VERSION) await cleanupRalphWorktrees(pi, ctx, state);
				await rm(statePathFor(repo.commonGitDir), { force: true });
				await rm(statePathFor(repo.gitDir), { force: true });
				emit(pi, "Ralph ledger cleared.");
			} catch (error) {
				emit(pi, `Ralph reset error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	pi.registerCommand("ralph-resume", {
		description: "Resume Ralph loop: /ralph-resume [hitl|afk]",
		handler: async (args, ctx) => {
			try {
				await handleResume(pi, ctx, args);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
				emit(pi, `Ralph resume error: ${message}`);
			}
		},
	});

	pi.registerCommand("ralph-check", {
		description: "Run Ralph full check command",
		handler: async (_args, ctx) => {
			try {
				const repo = await getRepoInfo(pi, ctx);
				const state = await loadStateForRepo(repo);
				const root = state?.version === VERSION && state.integration ? state.integration.path : repo.repoRoot;
				const result = await runFullCheck(pi, ctx, root, await readConfig());
				emit(pi, formatCheckResult(result));
			} catch (error) {
				emit(pi, `Ralph check error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	pi.registerCommand("ralph-finish", {
		description: "Export Ralph integration, push, and close completed issues",
		handler: async (_args, ctx) => {
			try {
				await handleFinish(pi, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
				emit(pi, `Ralph finish error: ${message}`);
			}
		},
	});
}

function pathInside(child: string, parent: string) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function toolPath(ctx: ExtensionContext, value: unknown) {
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

async function guardRalphWorktreeTool(pi: ExtensionAPI, ctx: ExtensionContext, event: any) {
	let repo: RepoInfo;
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

async function markSubagentStarted(pi: ExtensionAPI, ctx: ExtensionContext, spec: RalphSubagentSpec, details: any) {
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

async function markSubagentLaunchFailed(pi: ExtensionAPI, ctx: ExtensionContext, spec: RalphSubagentSpec, error: string) {
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

function registerEvents(pi: ExtensionAPI) {
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

	pi.on("session_shutdown", async (_event, ctx) => {
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

	pi.on("session_start", async (_event, ctx) => {
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

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens;
		if (!tokens) return;
		if (previousTokens !== undefined && previousTokens < WARN_TOKENS && tokens >= WARN_TOKENS) {
			notify(ctx, `Ralph context warning: ${tokens} tokens`, "warning");
		}
		previousTokens = tokens;
	});
}

export default function ralphExtension(pi: ExtensionAPI) {
	registerCommands(pi);
	registerEvents(pi);
}
