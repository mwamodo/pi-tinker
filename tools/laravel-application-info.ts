import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import { collectApplicationInfo, resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";

export function registerApplicationInfoTool(pi: ExtensionAPI) {
	registerTool(pi, {
		name: "application_info",
		label: "Application Info",
		description:
			"Get Laravel project context including PHP version, Laravel version, database engine, installed Composer/NPM packages, and likely Eloquent model files.",
		promptSnippet: "Inspect Laravel project context, package versions, and likely model files",
		promptGuidelines: [
			"Use this tool early when working in a Laravel project to understand versions, packages, and app structure.",
		],
		parameters: Type.Object({
			app_path: Type.Optional(
				Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
			const info = await collectApplicationInfo(appPath);
			return {
				content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
				details: {
					app_path: toRelativeAppPath(ctx.cwd, appPath),
					...info,
				},
			};
		},
	});
}
