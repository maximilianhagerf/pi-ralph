import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { statePathFor } from "./config";
import { execOk } from "./exec";
import { ensureGhAuth, getRepoInfo } from "./git";
import { runFullCheck, formatCheckResult } from "./checks";
import { readConfig } from "./config";
import { cleanupRalphWorktrees } from "./merge";
import { handleFinish, handleResume, startRun } from "./orchestration";
import { loadStateForRepo, renderState, saveState } from "./state";
import { emit, notify, parseArgs, positiveInt } from "./utils";
import { VERSION } from "./types";

export function registerCommands(pi: ExtensionAPI) {
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
		handler: async (_args, _ctx) => {
			try {
				const repo = await getRepoInfo(pi, _ctx);
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
