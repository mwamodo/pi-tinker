import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerApplicationInfoTool } from "../tools/laravel-application-info.ts";
import { registerBrowserLogsTool } from "../tools/browser-logs.ts";
import { registerSearchDocsTool } from "../tools/search-docs.ts";
import { registerLastErrorTool } from "../tools/last-error.ts";

export default function laravelExtension(pi: ExtensionAPI) {
	registerApplicationInfoTool(pi);
	registerBrowserLogsTool(pi);
	registerSearchDocsTool(pi);
	registerLastErrorTool(pi);
}
