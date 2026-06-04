import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
import { registerEvents } from "./events";

export default function ralphExtension(pi: ExtensionAPI) {
	registerCommands(pi);
	registerEvents(pi);
}
