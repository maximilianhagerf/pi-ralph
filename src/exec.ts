import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecResult } from "./types";

export async function execRaw(
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

export async function execOk(
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
