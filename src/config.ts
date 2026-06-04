import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RalphConfig } from "./types";

export function statePathFor(gitDir: string) {
	return join(gitDir, "ralph", "state.json");
}

export function configPath() {
	return join(homedir(), ".pi", "agent", "extensions", "ralph", "config.json");
}

export async function readConfig(): Promise<RalphConfig> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return {};
	}
}
