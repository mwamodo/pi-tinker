import { access, open, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CHUNK_SIZE_START = 64 * 1024;
const CHUNK_SIZE_MAX = 1024 * 1024;

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

export interface ReadLogEntriesFilters {
    level?: LogLevel;
    channel?: string;
    keyword?: string;
    date_from?: string;
    date_to?: string;
}

export interface ReadLogEntriesOptions extends ReadLogEntriesFilters {
    page: number;
    per_page: number;
    entry_filter?: (entry: ParsedLogEntry) => boolean;
}

export interface ParsedLogEntry {
    raw: string;
    timestamp?: string;
    channel?: string;
    level?: string;
    message?: string;
    context?: unknown;
    format: "psr" | "json";
}

async function tryExec(file: string, args: string[], cwd: string) {
    try {
        return await execFileAsync(file, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    } catch {
        return undefined;
    }
}

export async function resolveLaravelLogFilePath(appPath: string): Promise<{ logFile: string; source: string }> {
    const resolvedFromConfig = await resolveLaravelLogFilePathFromConfig(appPath);
    if (resolvedFromConfig) return resolvedFromConfig;

    const fallback = await resolveFallbackLaravelLogFilePath(appPath);
    return { logFile: fallback, source: "filesystem-fallback" };
}

async function resolveLaravelLogFilePathFromConfig(appPath: string): Promise<{ logFile: string; source: string } | undefined> {
    const php = [
        "error_reporting(E_ERROR);",
        "require 'vendor/autoload.php';",
        "$app = require 'bootstrap/app.php';",
        "$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);",
        "$kernel->bootstrap();",
        "$default = config('logging.default');",
        "$channels = config('logging.channels');",
        "echo json_encode(['default' => $default, 'channels' => $channels], JSON_UNESCAPED_SLASHES);",
    ].join(" ");

    const result = await tryExec("php", ["-r", php], appPath);
    if (!result?.stdout?.trim()) return undefined;

    try {
        const decoded = JSON.parse(result.stdout) as {
            default?: string;
            channels?: Record<string, Record<string, unknown>>;
        };
        const channels = decoded.channels ?? {};
        const channel = resolveChannelWithPath(channels, decoded.default);
        const baseLogPath = typeof channel?.path === "string" && channel.path.trim() ? channel.path.trim() : join(appPath, "storage/logs/laravel.log");
        const driver = typeof channel?.driver === "string" ? channel.driver : undefined;
        const logFile = driver === "daily" ? await resolveDailyLogFilePath(baseLogPath) : baseLogPath;
        return { logFile: resolve(appPath, logFile), source: "laravel-config" };
    } catch {
        return undefined;
    }
}

function resolveChannelWithPath(
    channels: Record<string, Record<string, unknown>>,
    channelName: string | undefined,
    depth = 0,
): Record<string, unknown> | undefined {
    if (!channelName || depth > 2) return undefined;
    const config = channels[channelName];
    if (!config) return undefined;
    if (typeof config.path === "string") return config;
    if (config.driver !== "stack" || !Array.isArray(config.channels)) return config;

    for (const nestedName of config.channels) {
        if (typeof nestedName !== "string") continue;
        const nested = resolveChannelWithPath(channels, nestedName, depth + 1);
        if (nested && typeof nested.path === "string") return nested;
    }

    return config;
}

async function resolveFallbackLaravelLogFilePath(appPath: string): Promise<string> {
    const logsDir = join(appPath, "storage/logs");
    const todayDaily = join(logsDir, `laravel-${new Date().toISOString().slice(0, 10)}.log`);
    if (await fileExists(todayDaily)) return todayDaily;

    const latestDaily = await findLatestDailyLog(logsDir, "laravel.log");
    if (latestDaily) return latestDaily;

    return join(logsDir, "laravel.log");
}

export async function resolveDailyLogFilePath(basePath: string): Promise<string> {
    const dir = dirname(basePath);
    const extension = extname(basePath);
    const filename = basename(basePath, extension);
    const todayLogFile = join(dir, `${filename}-${new Date().toISOString().slice(0, 10)}${extension}`);
    if (await fileExists(todayLogFile)) return todayLogFile;
    return (await findLatestDailyLog(dir, `${filename}${extension}`)) ?? todayLogFile;
}

async function findLatestDailyLog(directory: string, baseFilename: string): Promise<string | undefined> {
    const extension = extname(baseFilename);
    const filename = basename(baseFilename, extension);
    const pattern = new RegExp(`^${escapeRegExp(filename)}-\\d{4}-\\d{2}-\\d{2}${escapeRegExp(extension)}$`);

    try {
        const entries = await readdir(directory, { withFileTypes: true });
        const matches = entries
            .filter((entry) => entry.isFile() && pattern.test(entry.name))
            .map((entry) => entry.name)
            .sort();
        const latest = matches.at(-1);
        return latest ? join(directory, latest) : undefined;
    } catch {
        return undefined;
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, fsConstants.F_OK | fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTimestampRegex(): RegExp {
    return /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g;
}

function getEntrySplitRegex(): RegExp {
    return /(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\])/g;
}

function isJsonLogFormat(content: string): boolean {
    const firstLine = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    if (!firstLine || !firstLine.startsWith("{")) return false;
    try {
        JSON.parse(firstLine);
        return true;
    } catch {
        return false;
    }
}

async function scanLogChunkForEntries(logFile: string, chunkSize: number): Promise<string[]> {
    const file = await open(logFile, "r");
    try {
        const stats = await file.stat();
        const fileSize = stats.size;
        const offset = Math.max(fileSize - chunkSize, 0);
        const length = fileSize - offset;
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, offset);
        let content = buffer.toString("utf8");

        if (offset > 0) {
            const firstNewline = content.indexOf("\n");
            content = firstNewline === -1 ? "" : content.slice(firstNewline + 1);
        }

        if (!content.trim()) return [];

        if (isJsonLogFormat(content)) {
            return content
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
        }

        const normalized = content.replace(/\r\n/g, "\n");
        const entries = normalized.split(getEntrySplitRegex()).map((entry) => entry.trim()).filter(Boolean);
        return entries;
    } finally {
        await file.close();
    }
}

function parseJsonLogEntry(raw: string): ParsedLogEntry {
    try {
        const decoded = JSON.parse(raw) as Record<string, unknown>;
        const timestamp = firstString(decoded.datetime, decoded.timestamp, decoded["@timestamp"]);
        const channel = firstString(decoded.channel, decoded.type);
        const level = normalizeLevel(firstString(decoded.level_name, decoded.level, decoded.monolog_level));
        const message = firstString(decoded.message);
        const context = decoded.context;
        return { raw: raw.trim(), timestamp, channel, level, message, context, format: "json" };
    } catch {
        return { raw: raw.trim(), format: "json" };
    }
}

function parsePsrLogEntry(raw: string): ParsedLogEntry {
    const trimmed = raw.trim();
    const match = trimmed.match(/^\[(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+(?:(?<channel>[A-Za-z0-9_.-]+)\.)?(?<level>[A-Z]+):\s?(?<rest>[\s\S]*)$/);
    if (!match?.groups) return { raw: trimmed, format: "psr" };
    const timestamp = match.groups.timestamp;
    const channel = match.groups.channel;
    const level = normalizeLevel(match.groups.level);
    const rest = match.groups.rest ?? "";
    const [messageLine, ...extraLines] = rest.split(/\r?\n/);
    const context = extractTrailingJsonContext(messageLine ?? "");
    const message = stripTrailingJsonContext(messageLine ?? "");
    const reconstructed = [
        `[${timestamp}]${channel ? ` ${channel}.` : " "}${(match.groups.level ?? "").toUpperCase()}: ${message}`.trimEnd(),
        ...extraLines,
    ].join("\n").trim();
    return { raw: reconstructed || trimmed, timestamp, channel, level, message, context, format: "psr" };
}

export function parseLogEntry(raw: string): ParsedLogEntry {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) return parseJsonLogEntry(trimmed);
    return parsePsrLogEntry(trimmed);
}

function extractTrailingJsonContext(message: string): unknown {
    const match = message.match(/\s+(\{.*\}|\[.*\])$/);
    if (!match) return undefined;
    try {
        return JSON.parse(match[1]);
    } catch {
        return undefined;
    }
}

function stripTrailingJsonContext(message: string): string {
    const match = message.match(/^(.*?)(?:\s+(\{.*\}|\[.*\]))?$/);
    return match?.[1]?.trim() ?? message.trim();
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number") return String(value);
    }
    return undefined;
}

function normalizeLevel(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const upper = value.toUpperCase();
    if (/^\d+$/.test(upper)) {
        const level = Number(upper);
        if (level >= 600) return "EMERGENCY";
        if (level >= 550) return "ALERT";
        if (level >= 500) return "CRITICAL";
        if (level >= 400) return "ERROR";
        if (level >= 300) return "WARNING";
        if (level >= 250) return "NOTICE";
        if (level >= 200) return "INFO";
        return "DEBUG";
    }
    return upper;
}

function parseDateInput(value: string | undefined, endOfDay = false): number | undefined {
    if (!value?.trim()) return undefined;
    const trimmed = value.trim();
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? `${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`
        : trimmed.replace(" ", "T");
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function parseEntryTimestamp(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function matchesFilters(entry: ParsedLogEntry, filters: ReadLogEntriesFilters): boolean {
    if (filters.level && entry.level?.toLowerCase() !== filters.level.toLowerCase()) return false;
    if (filters.channel && entry.channel?.toLowerCase() !== filters.channel.toLowerCase()) return false;
    if (filters.keyword) {
        const needle = filters.keyword.toLowerCase();
        const haystack = [entry.raw, entry.message, entry.channel, entry.level]
            .filter((value): value is string => typeof value === "string")
            .join("\n")
            .toLowerCase();
        if (!haystack.includes(needle)) return false;
    }

    const entryTime = parseEntryTimestamp(entry.timestamp);
    const from = parseDateInput(filters.date_from, false);
    const to = parseDateInput(filters.date_to, true);
    if (from !== undefined && (entryTime === undefined || entryTime < from)) return false;
    if (to !== undefined && (entryTime === undefined || entryTime > to)) return false;

    return true;
}

export async function readFilteredLogEntries(
    logFile: string,
    options: ReadLogEntriesOptions,
): Promise<{ matchedEntries: ParsedLogEntry[]; scannedBytes: number; truncatedScan: boolean }> {
    let chunkSize = CHUNK_SIZE_START;
    let matchedEntries: ParsedLogEntry[] = [];
    let truncatedScan = false;
    const neededEntries = options.page * options.per_page;

    do {
        const rawEntries = await scanLogChunkForEntries(logFile, chunkSize);
        matchedEntries = rawEntries
            .map(parseLogEntry)
            .filter((entry) => matchesFilters(entry, options))
            .filter((entry) => options.entry_filter?.(entry) ?? true);

        if (matchedEntries.length >= neededEntries || chunkSize >= CHUNK_SIZE_MAX) {
            truncatedScan = chunkSize >= CHUNK_SIZE_MAX && matchedEntries.length < neededEntries;
            break;
        }

        chunkSize *= 2;
    } while (true);

    return { matchedEntries, scannedBytes: Math.min(chunkSize, CHUNK_SIZE_MAX), truncatedScan };
}

export function paginateMatchedEntries(entries: ParsedLogEntry[], page: number, perPage: number): ParsedLogEntry[] {
    const total = entries.length;
    const end = Math.max(total - (page - 1) * perPage, 0);
    const start = Math.max(end - perPage, 0);
    return entries.slice(start, end);
}

export function formatLogEntry(entry: ParsedLogEntry): string {
    if (entry.format === "json") {
        const header = `[${entry.timestamp ?? "unknown"}] ${entry.channel ?? "log"}.${entry.level ?? "INFO"}: ${entry.message ?? entry.raw}`;
        const context = entry.context !== undefined ? `\nContext: ${JSON.stringify(entry.context, null, 2)}` : "";
        return `${header}${context}`.trim();
    }

    if (entry.context !== undefined) {
        return `${entry.raw}\nContext: ${JSON.stringify(entry.context, null, 2)}`;
    }

    return entry.raw;
}

export function isErrorLogEntry(entry: ParsedLogEntry): boolean {
    const level = entry.level?.toUpperCase();
    return level === "ERROR" || level === "CRITICAL" || level === "ALERT" || level === "EMERGENCY";
}

export async function readLastErrorLogEntry(
    logFile: string,
): Promise<{ entry?: ParsedLogEntry; scannedBytes: number; truncatedScan: boolean }> {
    let chunkSize = CHUNK_SIZE_START;

    do {
        const rawEntries = await scanLogChunkForEntries(logFile, chunkSize);
        const parsedEntries = rawEntries.map(parseLogEntry);

        for (let i = parsedEntries.length - 1; i >= 0; i--) {
            if (isErrorLogEntry(parsedEntries[i])) {
                return { entry: parsedEntries[i], scannedBytes: Math.min(chunkSize, CHUNK_SIZE_MAX), truncatedScan: false };
            }
        }

        if (chunkSize >= CHUNK_SIZE_MAX) {
            return { scannedBytes: CHUNK_SIZE_MAX, truncatedScan: true };
        }

        chunkSize *= 2;
    } while (true);
}
