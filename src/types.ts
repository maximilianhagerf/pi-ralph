export const VERSION = 2;
export const LEGACY_VERSION = 1;
export const SPAWN_MARKER = "<ralph-spawn-request";
export const STATE_CUSTOM_TYPE = "ralph-state";
export const SUMMARY_LIMIT = 8_000;
export const WARN_TOKENS = 90_000;
export const COMPACT_TOKENS = 100_000;
export const HARD_STOP_TOKENS = 115_000;
export const DEFAULT_MODEL = "openai-codex/gpt-5.5";
export const DEFAULT_MAX_CONFLICT_RESOLVER_ATTEMPTS = 2;
export const DEFAULT_MAX_VERIFIER_FIX_ATTEMPTS = 3;
export const DEFAULT_MAX_PROVIDER_RETRIES = 3;
export const VERIFIER_TOOL_ALLOWLIST = "read,grep,find,ls";

export type RalphMode = "afk" | "hitl" | "once";
export type WorkerStatus = "success" | "blocked" | "failed" | "unknown";
export type RunningStatus = "spawning" | "running" | "pending-merge" | "merging" | "conflict" | "failed";
export type SpawnStatus = "spawning" | "running" | "failed";

export type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

export type RepoInfo = {
	repoRoot: string;
	gitDir: string;
	commonGitDir: string;
	branch: string;
	head: string;
	repo: string;
};

export type IssueInfo = {
	number: number;
	title: string;
	body: string;
	state: string;
	url?: string;
};

export type DiffSnapshot = {
	branch: string;
	status: string;
	diffHash: string;
	stagedDiffHash: string;
	untrackedHashes: Record<string, string>;
	createdAt: string;
};

export type CompletedIssue = {
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

export type RunningIssue = {
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

export type WorktreeState = {
	path: string;
	branch: string;
	createdAt: string;
	head?: string;
};

export type PendingWorkerResult = {
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

export type ConflictState = {
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

export type VerifierState = {
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

export type FixerState = {
	status: SpawnStatus;
	attempt: number;
	startedAt: string;
	baseHead?: string;
	commit?: string;
	task?: string;
	sessionFile?: string;
	summary?: string;
};

export type RalphState = {
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

export type RalphConfig = {
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

export type CheckPlan = {
	command?: string;
	reason: string;
};

export type CheckResult = {
	ok: boolean;
	command?: string;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	noCommand?: boolean;
};

export type RalphSubagentSpec =
	| { kind: "worker"; issueNumber: number }
	| { kind: "conflict"; issueNumber: number }
	| { kind: "verifier" }
	| { kind: "fixer" };
