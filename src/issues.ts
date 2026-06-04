import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execOk } from "./exec";
import { activeRunningEntries, issueCompletedOrClosed, remainingIssues } from "./state";
import type { IssueInfo, RalphState } from "./types";

export function parseLinkedIssues(body: string, prdNumber: number): number[] {
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

export async function fetchIssuesReferencingPrd(
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

export async function fetchIssue(pi: ExtensionAPI, ctx: ExtensionContext, repo: string, issueNumber: number): Promise<IssueInfo> {
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

export async function fetchPrdAndChildren(pi: ExtensionAPI, ctx: ExtensionContext, repo: string, prdNumber: number) {
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

export async function refreshIssueStates(pi: ExtensionAPI, ctx: ExtensionContext, state: RalphState) {
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

// Worker-reported blockers (issue -> reason). In AFK these are skipped, not fatal, and listed
// in the final report so a completed run surfaces everything that still needs a human.
export function blockedSummary(state: RalphState): string {
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

export function runnableIssues(state: RalphState): IssueInfo[] {
	return remainingIssues(state).filter((issue) => unresolvedBlockers(state, issue).length === 0);
}

export function blockedIssueSummary(state: RalphState) {
	return remainingIssues(state)
		.map((issue) => {
			const blockers = unresolvedBlockers(state, issue);
			return blockers.length ? `#${issue.number} waits for ${blockers.map((n) => `#${n}`).join(", ")}` : undefined;
		})
		.filter(Boolean)
		.join("; ");
}
