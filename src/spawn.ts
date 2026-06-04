import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCheckPlan } from "./checks";
import { formatCheckResult } from "./checks";
import { DEFAULT_MODEL, SPAWN_MARKER, VERIFIER_TOOL_ALLOWLIST, type CheckResult, type IssueInfo, type RalphConfig, type RalphState, type RunningIssue } from "./types";
import { assertV2State } from "./state";

export function ensureSubagentTool(pi: ExtensionAPI) {
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

export async function buildWorkerTask(
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

export function buildConflictResolverTask(state: RalphState, issueNumber: number, conflicts: string[], output?: string) {
	assertV2State(state);
	const issue = state.issues[String(issueNumber)];
	return `# Ralph conflict resolver task\n\nResolve active git merge conflicts in the integration worktree.\n\nRepository: ${state.repo}\nIntegration worktree: ${state.integration.path}\nIntegration branch: ${state.integration.branch}\nConflicted issue: #${issueNumber} — ${issue?.title ?? ""}\nConflicted branch: ${state.conflict?.branch ?? ""}\nPRD: #${state.prd.number} — ${state.prd.title}\n\n## Conflicted paths\n${conflicts.length ? conflicts.map((path) => `- ${path}`).join("\n") : "- unknown; inspect git status"}\n\n${output ? `## Merge output\n\n${output}\n` : ""}\n## Hard rules\n\n1. Work only in integration worktree.\n2. Resolve merge conflicts for issue #${issueNumber}; do not broaden scope.\n3. Do not commit. Ralph will stage and commit the merge after validation.\n4. Do not abort the merge unless resolution is impossible; if impossible, report blocked.\n5. Run targeted checks for conflicted files if feasible.\n6. Do not close/edit/comment on GitHub issues.\n7. Do not spawn subagents.\n8. Do NOT run dependency/tooling migrations (e.g. 'biome migrate', codemods) or modify lockfiles or tool config (biome.json, tsconfig.json, package.json, .eslintrc, etc.) unless required to resolve the conflict itself. If a check fails from a tooling/version/config mismatch rather than the conflict, report blocked with the exact error; do not fix the environment.\n\n## Final response format (required exactly)\n\nRALPH_CONFLICT_RESOLVER_RESULT\nIssue: #${issueNumber}\nStatus: success | blocked | failed\nFiles changed:\n- path or none\nChecks:\n- command — pass/fail/not run — note\nRemaining work:\n- item or none\nRisks:\n- item or none\nSummary:\n- concise conflict resolution summary\n`;
}

export function buildPrdVerifierTask(state: RalphState, check: CheckResult) {
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

export function buildFixerTask(state: RalphState, verifierSummary: string, check: CheckResult | undefined) {
	assertV2State(state);
	return `# Ralph verifier fixer task\n\nFix only gaps found by the PRD verifier/check in the integration worktree.\n\nRepository: ${state.repo}\nIntegration worktree: ${state.integration.path}\nIntegration branch: ${state.integration.branch}\nPRD: #${state.prd.number} — ${state.prd.title}\n\n## Verifier/check failure\n\n${verifierSummary}\n\n${check ? `## Latest full check\n\n${formatCheckResult(check)}\n` : ""}\n## Hard rules\n\n1. Work only in integration worktree.\n2. Fix only verifier/check gaps; do not start unrelated work.\n3. Do not commit. Ralph commits your diff after success.\n4. Do not push or change GitHub issues.\n5. Run targeted checks for changed files.\n6. Do not spawn subagents.\n7. Do NOT run dependency/tooling migrations (e.g. 'biome migrate', 'eslint --init', codemods) or modify lockfiles or tool config (biome.json, tsconfig.json, package.json, .eslintrc, etc.) unless the PRD explicitly requires it. If the check fails from a tooling/version/config mismatch rather than code (e.g. a config schema/version warning), report blocked with the exact error; do not fix the environment.\n\n## Final response format (required exactly)\n\nRALPH_FIXER_RESULT\nStatus: success | blocked | failed\nFiles changed:\n- path or none\nChecks:\n- command — pass/fail/not run — note\nRemaining work:\n- item or none\nRisks:\n- item or none\nSummary:\n- concise fix summary\n`;
}

export function buildSpawnPrompt(params: Record<string, unknown> | Record<string, unknown>[]) {
	const requests = Array.isArray(params) ? params : [params];
	const instruction = requests.length === 1
		? "Call the subagent tool exactly once with this exact JSON object as arguments, then stop and wait for subagent_result."
		: `Call the subagent tool ${requests.length} times, once for each JSON object below. Make all subagent calls before waiting for results.`;
	return `${SPAWN_MARKER} count="${requests.length}">\nRalph extension request. ${instruction} Do not call other tools. Do not summarize or invent worker results.\n\n${JSON.stringify(requests.length === 1 ? requests[0] : requests, null, 2)}\n</ralph-spawn-request>`;
}

export function sendSpawnPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, defer = false) {
	const send = () => {
		if (ctx.isIdle()) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	};
	if (defer) setTimeout(send, 0);
	else send();
}

export function applyDefaultSubagentParams(params: Record<string, unknown>, model?: string, tools?: string, skills?: string) {
	params.model = model ?? DEFAULT_MODEL;
	if (tools) params.tools = tools;
	if (skills) params.skills = skills;
	return params;
}

export function verifierTools(config: RalphConfig) {
	if (!config.prdVerifierTools?.trim()) return VERIFIER_TOOL_ALLOWLIST;
	const allowed = new Set(VERIFIER_TOOL_ALLOWLIST.split(","));
	const selected = config.prdVerifierTools.split(",").map((tool) => tool.trim()).filter((tool) => allowed.has(tool));
	return selected.length ? selected.join(",") : VERIFIER_TOOL_ALLOWLIST;
}
