import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplicationInfoTool } from "../tools/laravel-application-info.ts";
import { registerBrowserLogsTool } from "../tools/browser-logs.ts";
import { registerDatabaseConnectionsTool } from "../tools/database-connections.ts";
import { registerDatabaseQueryTool } from "../tools/database-query.ts";
import { registerDatabaseSchemaTool } from "../tools/database-schema.ts";
import { registerGetAbsoluteUrlTool } from "../tools/get-absolute-url.ts";
import { registerReadLogEntriesTool } from "../tools/read-log-entries.ts";
import { registerSearchDocsTool } from "../tools/search-docs.ts";
import { registerLastErrorTool } from "../tools/last-error.ts";

export default function laravelExtension(pi: ExtensionAPI) {
	registerApplicationInfoTool(pi);
	registerBrowserLogsTool(pi);
	registerDatabaseConnectionsTool(pi);
	registerDatabaseQueryTool(pi);
	registerDatabaseSchemaTool(pi);
	registerGetAbsoluteUrlTool(pi);
	registerReadLogEntriesTool(pi);
	registerSearchDocsTool(pi);
	registerLastErrorTool(pi);
}
