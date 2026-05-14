import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import { formatLogEntry, readLastErrorLogEntry, resolveLaravelLogFilePath } from "../utils/logs.ts";
import { resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";

const LastErrorParams = Type.Object({
    app_path: Type.Optional(
        Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
    ),
});

export function registerLastErrorTool(pi: ExtensionAPI) {
    registerTool(pi, {
        name: "last_error",
        label: "Last Error",
        description:
            "Get the most recent backend error or exception from a Laravel application's log files. Use this for quick server-side debugging before broader log browsing.",
        promptSnippet: "Inspect the most recent backend Laravel error or exception",
        promptGuidelines: [
            "Use this tool for a fast first pass when debugging a failing Laravel request or command.",
            "Use read_log_entries when you need broader browsing, pagination, or non-error log levels.",
        ],
        parameters: LastErrorParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
            const { logFile, source } = await resolveLaravelLogFilePath(appPath);
            const result = await readLastErrorLogEntry(logFile);

            const text = result.entry
                ? formatLastErrorResult(logFile, source, formatLogEntry(result.entry), result.truncatedScan)
                : formatNoErrorResult(logFile, source, result.truncatedScan);

            return {
                content: [{ type: "text", text }],
                details: {
                    app_path: toRelativeAppPath(ctx.cwd, appPath),
                    log_file: logFile,
                    log_file_source: source,
                    found_error: Boolean(result.entry),
                    level: result.entry?.level,
                    timestamp: result.entry?.timestamp,
                    channel: result.entry?.channel,
                    scanned_bytes: result.scannedBytes,
                    truncated_scan: result.truncatedScan,
                },
            };
        },
    });
}

function formatLastErrorResult(logFile: string, source: string, entry: string, truncatedScan: boolean): string {
    return [
        `Log file: ${logFile}`,
        `Source: ${source}`,
        truncatedScan ? "Note: only the recent scanned log window was inspected before finding this error." : undefined,
        "",
        entry,
    ]
        .filter((line) => line !== undefined)
        .join("\n");
}

function formatNoErrorResult(logFile: string, source: string, truncatedScan: boolean): string {
    return [
        `Log file: ${logFile}`,
        `Source: ${source}`,
        truncatedScan
            ? "No errors found in the inspected recent log window. Older errors may exist outside the scanned window."
            : "No errors found in the log file.",
    ]
        .filter(Boolean)
        .join("\n");
}
