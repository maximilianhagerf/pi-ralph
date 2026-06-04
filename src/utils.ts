import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { SPAWN_MARKER, SUMMARY_LIMIT, type RalphSubagentSpec } from "./types";

export function nowIso() {
	return new Date().toISOString();
}

export function cap(text: string, max = SUMMARY_LIMIT) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[ralph: truncated ${text.length - max} chars]`;
}

export function textContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n");
}

export function messageText(message: any): string {
	return textContent(message?.content);
}

export function isRalphSpawnMessage(message: any): boolean {
	return message?.role === "user" && messageText(message).includes(SPAWN_MARKER);
}

export function parseRalphSubagentName(name: unknown): RalphSubagentSpec | undefined {
	if (typeof name !== "string") return undefined;
	let match = name.match(/^Ralph #(\d+)(?: .+)?$/);
	if (match) return { kind: "worker", issueNumber: Number(match[1]) };
	match = name.match(/^Ralph conflict #(\d+)$/);
	if (match) return { kind: "conflict", issueNumber: Number(match[1]) };
	if (name === "Ralph verifier") return { kind: "verifier" };
	if (name === "Ralph fixer") return { kind: "fixer" };
	return undefined;
}

export function isRalphSubagentMessage(message: any): boolean {
	return (
		message?.role === "custom" &&
		(message.customType === "subagent_result" || message.customType === "subagent_ping") &&
		Boolean(parseRalphSubagentName(message.details?.name))
	);
}

export function issueNumberFromName(name: unknown): number | undefined {
	const spec = parseRalphSubagentName(name);
	return spec && "issueNumber" in spec ? spec.issueNumber : undefined;
}

export function hashText(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

export function hashFile(path: string): Promise<string> {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

export function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function parseArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

export function positiveInt(raw: string | undefined, fallback: number, label: string) {
	const value = raw?.trim() ? Number(raw.trim()) : fallback;
	if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be positive integer.`);
	return value;
}

export function pathInside(child: string, parent: string) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function emit(pi: ExtensionAPI, content: string, details?: any) {
	pi.sendMessage({ customType: "ralph", content, display: true, details });
}

export function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}
