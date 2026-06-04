import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execRaw } from "./exec";
import { cap } from "./utils";
import type { CheckPlan, CheckResult, RalphConfig } from "./types";

export async function packageManager(repoRoot: string) {
	if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun";
	if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
	return "npm";
}

export function runScriptCommand(pm: string, script: string) {
	if (pm === "bun") return `bun ${script}`;
	if (pm === "pnpm") return `pnpm run ${script}`;
	if (pm === "yarn") return `yarn ${script}`;
	return `npm run ${script}`;
}

// Fresh git worktrees have no node_modules (gitignored), which makes package
// managers resolve stray global tool versions instead of the project's pinned
// ones. Install deps once per worktree so checks run against pinned tooling.
export async function resolveSetupCommand(repoRoot: string, config: RalphConfig): Promise<string | undefined> {
	if (config.setupCommand !== undefined) return config.setupCommand.trim() || undefined; // "" disables
	if (!existsSync(join(repoRoot, "package.json"))) return undefined;
	const pm = await packageManager(repoRoot);
	// Prefer frozen/ci variants: reproduce pinned deps, no lockfile mutation. Fall back to plain install if no lockfile.
	if (pm === "pnpm") return existsSync(join(repoRoot, "pnpm-lock.yaml")) ? "pnpm install --frozen-lockfile" : "pnpm install";
	if (pm === "bun") return existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb")) ? "bun install --frozen-lockfile" : "bun install";
	if (pm === "yarn") return existsSync(join(repoRoot, "yarn.lock")) ? "yarn install --frozen-lockfile" : "yarn install";
	return existsSync(join(repoRoot, "package-lock.json")) ? "npm ci" : "npm install";
}

export async function resolveCheckPlan(repoRoot: string, config: RalphConfig): Promise<CheckPlan> {
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

export async function runFullCheck(pi: ExtensionAPI, ctx: ExtensionContext, repoRoot: string, config: RalphConfig): Promise<CheckResult> {
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

export function formatCheckResult(result: CheckResult) {
	if (result.noCommand) return "No check command configured.";
	const chunks = [`$ ${result.command}`, result.ok ? "PASS" : `FAIL (exit ${result.exitCode})`];
	if (result.stdout?.trim()) chunks.push("stdout:\n" + result.stdout.trim());
	if (result.stderr?.trim()) chunks.push("stderr:\n" + result.stderr.trim());
	return chunks.join("\n");
}
