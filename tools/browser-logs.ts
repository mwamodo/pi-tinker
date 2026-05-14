import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTool } from "../utils/register-tool.ts";
import { resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";
import { formatLogEntry, paginateMatchedEntries, readFilteredLogEntries, type LogLevel } from "../utils/logs.ts";

const execFileAsync = promisify(execFile);
const levels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const satisfies ReadonlyArray<LogLevel>;

const BrowserLogsParams = Type.Object({
    app_path: Type.Optional(
        Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
    ),
    level: Type.Optional(
        Type.Union(levels.map((level) => Type.Literal(level)), { description: "Optional browser log level filter" }),
    ),
    url: Type.Optional(Type.String({ description: "Optional absolute page URL filter" })),
    path: Type.Optional(Type.String({ description: "Optional relative app path filter, for example /dashboard" })),
    route: Type.Optional(Type.String({ description: "Optional named Laravel route to scope logs to" })),
    parameters: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
            description: "Optional route parameters used when resolving the route filter",
        }),
    ),
    keyword: Type.Optional(Type.String({ description: "Optional keyword filter matched against message/raw entry" })),
    page: Type.Optional(Type.Integer({ description: "Results page number. Page 1 is the most recent matching page." })),
    per_page: Type.Optional(Type.Integer({ description: "Number of entries per page. Default 20, max 100." })),
});

export function registerBrowserLogsTool(pi: ExtensionAPI) {
    registerTool(pi, {
        name: "browser_logs",
        label: "Browser Logs",
        description:
            "Inspect captured browser console output and client-side JS errors from a Laravel app's browser log file. Supports filtering by log level and page URL.",
        promptSnippet: "Inspect Laravel browser console logs and client-side errors for a page or recent session",
        promptGuidelines: [
            "Use get_absolute_url first when you need to scope browser logs to a route or relative path.",
            "Use level filters such as error or warning to reduce noisy browser console output.",
        ],
        parameters: BrowserLogsParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
            const page = Math.max(1, params.page ?? 1);
            const perPage = Math.min(100, Math.max(1, params.per_page ?? 20));
            const targetUrl = await resolveTargetUrl(appPath, params);
            const logFile = await resolveBrowserLogFilePath(appPath);
            const logFileExists = await isReadableFile(logFile);
            const { matchedEntries, scannedBytes, truncatedScan } = logFileExists
                ? await readFilteredLogEntries(logFile, {
                    level: params.level,
                    keyword: params.keyword?.trim() || undefined,
                    entry_filter: targetUrl ? (entry) => getBrowserLogUrl(entry) === targetUrl : undefined,
                    page,
                    per_page: perPage,
                })
                : { matchedEntries: [], scannedBytes: 0, truncatedScan: false };
            const pageEntries = paginateMatchedEntries(matchedEntries, page, perPage);
            const text = buildBrowserLogsResult({
                logFile,
                targetUrl,
                page,
                perPage,
                pageEntries,
                totalMatched: matchedEntries.length,
                truncatedScan,
                logFileExists,
            });

            return {
                content: [{ type: "text", text }],
                details: {
                    app_path: toRelativeAppPath(ctx.cwd, appPath),
                    log_file: logFile,
                    target_url: targetUrl,
                    log_file_exists: logFileExists,
                    page,
                    per_page: perPage,
                    returned_count: pageEntries.length,
                    total_matched_in_scanned_window: matchedEntries.length,
                    has_more: matchedEntries.length > page * perPage || truncatedScan,
                    truncated_scan: truncatedScan,
                    scanned_bytes: scannedBytes,
                    filters: {
                        level: params.level,
                        url: targetUrl,
                        keyword: params.keyword?.trim() || undefined,
                    },
                },
            };
        },
    });
}

async function resolveBrowserLogFilePath(appPath: string): Promise<string> {
    const php = [
        "error_reporting(E_ERROR);",
        "require 'vendor/autoload.php';",
        "$app = require 'bootstrap/app.php';",
        "$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);",
        "$kernel->bootstrap();",
        "$path = config('logging.channels.browser.path') ?: storage_path('logs/browser.log');",
        "echo json_encode(['path' => $path], JSON_UNESCAPED_SLASHES);",
    ].join(" ");

    try {
        const result = await execFileAsync("php", ["-r", php], { cwd: appPath, maxBuffer: 20 * 1024 * 1024 });
        const decoded = JSON.parse(result.stdout.trim()) as { path?: string };
        if (decoded.path?.trim()) return decoded.path.trim();
    } catch {
        // fall through
    }

    return `${appPath}/storage/logs/browser.log`;
}

async function resolveTargetUrl(
    appPath: string,
    params: {
        url?: string;
        path?: string;
        route?: string;
        parameters?: Record<string, unknown>;
    },
): Promise<string | undefined> {
    if (params.url?.trim()) return params.url.trim();
    if (!params.path?.trim() && !params.route?.trim()) return undefined;

    const payload = Buffer.from(
        JSON.stringify({
            path: params.path,
            route: params.route,
            parameters: params.parameters ?? {},
        }),
    ).toString("base64");

    const php = [
        "error_reporting(E_ERROR);",
        "require 'vendor/autoload.php';",
        "$app = require 'bootstrap/app.php';",
        "$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);",
        "$kernel->bootstrap();",
        `$payload = json_decode(base64_decode('${payload}'), true) ?: [];`,
        "$path = $payload['path'] ?? null;",
        "$route = $payload['route'] ?? null;",
        "$parameters = is_array($payload['parameters'] ?? null) ? $payload['parameters'] : [];",
        "if (is_string($path) && trim($path) !== '') { $url = url($path); }",
        "elseif (is_string($route) && trim($route) !== '') { $url = route($route, $parameters, true); }",
        "else { $url = null; }",
        "echo json_encode(['url' => $url], JSON_UNESCAPED_SLASHES);",
    ].join(" ");

    const result = await execFileAsync("php", ["-r", php], { cwd: appPath, maxBuffer: 20 * 1024 * 1024 });
    const decoded = JSON.parse(result.stdout.trim()) as { url?: string };
    return decoded.url?.trim() || undefined;
}

async function isReadableFile(path: string): Promise<boolean> {
    try {
        await access(path, fsConstants.F_OK | fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function getBrowserLogUrl(entry: { context?: unknown }): string | undefined {
    const context = asRecord(entry.context);
    return typeof context?.url === "string" ? context.url : undefined;
}

function buildBrowserLogsResult({
    logFile,
    targetUrl,
    page,
    perPage,
    pageEntries,
    totalMatched,
    truncatedScan,
    logFileExists,
}: {
    logFile: string;
    targetUrl?: string;
    page: number;
    perPage: number;
    pageEntries: Awaited<ReturnType<typeof readFilteredLogEntries>>["matchedEntries"];
    totalMatched: number;
    truncatedScan: boolean;
    logFileExists: boolean;
}) {
    const header = [
        `Log file: ${logFile}`,
        targetUrl ? `URL filter: ${targetUrl}` : "URL filter: none (recent browser session logs)",
        `Showing page ${page} (${pageEntries.length} entries, page size ${perPage}) from ${totalMatched} matching entr${totalMatched === 1 ? "y" : "ies"} in the scanned log window.`,
        truncatedScan
            ? "Note: only the last portion of the browser log file was scanned. Older matching entries may exist outside the scanned window."
            : undefined,
    ]
        .filter(Boolean)
        .join("\n");

    if (!logFileExists) return `${header}\n\nBrowser log file does not exist yet.`;
    if (pageEntries.length === 0) return `${header}\n\nNo matching browser log entries found.`;

    const body = pageEntries
        .map((entry, index) => {
            const context = asRecord(entry.context);
            const sourceBits = [getBrowserLogUrl(entry), typeof context?.timestamp === "string" ? context.timestamp : undefined]
                .filter(Boolean)
                .join(" | ");
            return `#${index + 1}${sourceBits ? `\nSource: ${sourceBits}` : ""}\n${formatLogEntry(entry)}`;
        })
        .join("\n\n---\n\n");

    return `${header}\n\n${body}`;
}
