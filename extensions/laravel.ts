import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerApplicationInfoTool } from "../tools/laravel-application-info.ts";
import { registerSearchDocsTool } from "../tools/search-docs.ts";

export default function laravelExtension(pi: ExtensionAPI) {
	registerApplicationInfoTool(pi);
	registerSearchDocsTool(pi);
}
