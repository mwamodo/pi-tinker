import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import {
	formatLogEntry,
	paginateMatchedEntries,
	readFilteredLogEntries,
	resolveLaravelLogFilePath,
	type LogLevel,
} from "../utils/logs.ts";
import { resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";

const levels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const satisfies ReadonlyArray<LogLevel>;

const ReadLogEntriesParams = Type.Object({
	app_path: Type.Optional(
		Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
	),
	level: Type.Optional(
		Type.Union(levels.map((level) => Type.Literal(level)), { description: "Optional log level filter" }),
	),
	channel: Type.Optional(Type.String({ description: "Optional log channel filter" })),
	keyword: Type.Optional(Type.String({ description: "Optional keyword filter matched against message/raw entry" })),
	date_from: Type.Optional(
		Type.String({ description: "Optional inclusive start date/time filter (for example 2026-04-01 or 2026-04-01 14:30:00)" }),
	),
	date_to: Type.Optional(
		Type.String({ description: "Optional inclusive end date/time filter (for example 2026-04-06 or 2026-04-06 14:30:00)" }),
	),
	page: Type.Optional(Type.Integer({ description: "Results page number. Page 1 is the most recent matching page." })),
	per_page: Type.Optional(Type.Integer({ description: "Number of entries per page. Default 20, max 100." })),
});

export function registerReadLogEntriesTool(pi: ExtensionAPI) {
	registerTool(pi, {
		name: "read_log_entries",
		label: "Read Log Entries",
		description:
			"Inspect recent Laravel application log entries with optional filters for level, channel, date range, and keyword. Works with common single and daily log file setups.",
		promptSnippet: "Inspect recent Laravel application log output with optional filters and pagination",
		promptGuidelines: [
			"Use this tool when you need broader log browsing than a single last error.",
			"Prefer adding level, keyword, or date filters when the log file may be noisy.",
		],
		parameters: ReadLogEntriesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
			const page = Math.max(1, params.page ?? 1);
			const perPage = Math.min(100, Math.max(1, params.per_page ?? 20));
			const { logFile, source } = await resolveLaravelLogFilePath(appPath);
			const { matchedEntries, scannedBytes, truncatedScan } = await readFilteredLogEntries(logFile, {
				level: params.level,
				channel: params.channel?.trim() || undefined,
				keyword: params.keyword?.trim() || undefined,
				date_from: params.date_from?.trim() || undefined,
				date_to: params.date_to?.trim() || undefined,
				page,
				per_page: perPage,
			});

			const pageEntries = paginateMatchedEntries(matchedEntries, page, perPage);
			const text = buildResultText({
				page,
				perPage,
				pageEntries,
				totalMatched: matchedEntries.length,
				logFile,
				source,
				truncatedScan,
			});

			return {
				content: [{ type: "text", text }],
				details: {
					app_path: toRelativeAppPath(ctx.cwd, appPath),
					log_file: logFile,
					log_file_source: source,
					page,
					per_page: perPage,
					returned_count: pageEntries.length,
					total_matched_in_scanned_window: matchedEntries.length,
					has_more: matchedEntries.length > page * perPage || truncatedScan,
					truncated_scan: truncatedScan,
					scanned_bytes: scannedBytes,
					filters: {
						level: params.level,
						channel: params.channel?.trim() || undefined,
						keyword: params.keyword?.trim() || undefined,
						date_from: params.date_from?.trim() || undefined,
						date_to: params.date_to?.trim() || undefined,
					},
				},
			};
		},
	});
}

function buildResultText({
	page,
	perPage,
	pageEntries,
	totalMatched,
	logFile,
	source,
	truncatedScan,
}: {
	page: number;
	perPage: number;
	pageEntries: Array<ReturnType<typeof paginateMatchedEntries>[number]>;
	totalMatched: number;
	logFile: string;
	source: string;
	truncatedScan: boolean;
}) {
	const header = [
		`Log file: ${logFile}`,
		`Source: ${source}`,
		`Showing page ${page} (${pageEntries.length} entries, page size ${perPage}) from ${totalMatched} matching entr${totalMatched === 1 ? "y" : "ies"} in the scanned log window.`,
		truncatedScan
			? "Note: only the last portion of the log file was scanned. Older matching entries may exist outside the scanned window."
			: undefined,
	]
		.filter(Boolean)
		.join("\n");

	if (pageEntries.length === 0) {
		return `${header}\n\nNo matching log entries found.`;
	}

	const body = pageEntries
		.map((entry, index) => `#${index + 1}\n${formatLogEntry(entry)}`)
		.join("\n\n---\n\n");

	return `${header}\n\n${body}`;
}
