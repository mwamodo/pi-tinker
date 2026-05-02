import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import { resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";

const execFileAsync = promisify(execFile);

const DatabaseConnectionsParams = Type.Object({
    app_path: Type.Optional(
        Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
    ),
});

interface DatabaseConnectionSummary {
    name: string;
    driver?: string;
    host?: string;
    port?: string | number;
    database?: string;
    username?: string;
    password?: string;
    status: "reachable" | "unreachable";
    error?: string;
    is_default: boolean;
}

export function registerDatabaseConnectionsTool(pi: ExtensionAPI) {
    registerTool(pi, {
        name: "database_connections",
        label: "Database Connections",
        description:
            "List configured Laravel database connections with driver, host, database, masked credentials, and basic reachability status.",
        promptSnippet: "Inspect configured Laravel database connections and their reachability",
        promptGuidelines: [
            "Use this tool before database_schema or database_query to confirm the available connection names and database drivers.",
        ],
        parameters: DatabaseConnectionsParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
            const php = [
                "error_reporting(E_ERROR);",
                "require 'vendor/autoload.php';",
                "$app = require 'bootstrap/app.php';",
                "$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);",
                "$kernel->bootstrap();",
                "$default = config('database.default');",
                "$connections = config('database.connections', []);",
                "$results = [];",
                "foreach ($connections as $name => $config) {",
                "  $driver = $config['driver'] ?? null;",
                "  $database = $config['database'] ?? null;",
                "  $host = $config['host'] ?? ($driver === 'sqlite' ? ($database ?: null) : null);",
                "  $port = $config['port'] ?? null;",
                "  $username = $config['username'] ?? null;",
                "  $password = array_key_exists('password', $config) ? '********' : null;",
                "  $status = 'reachable';",
                "  $error = null;",
                "  try { Illuminate\\Support\\Facades\\DB::connection($name)->getPdo(); }",
                "  catch (Throwable $e) { $status = 'unreachable'; $error = $e->getMessage(); }",
                "  $results[] = [",
                "    'name' => $name,",
                "    'driver' => $driver,",
                "    'host' => $host,",
                "    'port' => $port,",
                "    'database' => $database,",
                "    'username' => $username,",
                "    'password' => $password,",
                "    'status' => $status,",
                "    'error' => $error,",
                "    'is_default' => $name === $default,",
                "  ];",
                "}",
                "echo json_encode(['default_connection' => $default, 'connections' => $results], JSON_UNESCAPED_SLASHES);",
            ].join(" ");

            let stdout = "";
            try {
                const result = await execFileAsync("php", ["-r", php], { cwd: appPath, maxBuffer: 20 * 1024 * 1024 });
                stdout = result.stdout.trim();
            } catch (error) {
                const failed = error as { stdout?: string; stderr?: string; message?: string };
                stdout = failed.stdout?.trim() || "";
                if (!stdout) {
                    throw new Error(failed.stderr?.trim() || failed.message || "Failed to inspect database connections.");
                }
            }

            if (!stdout) {
                throw new Error("Failed to inspect database connections: no output from Laravel application.");
            }

            let decoded: { default_connection?: string; connections?: DatabaseConnectionSummary[] };
            try {
                decoded = JSON.parse(stdout) as { default_connection?: string; connections?: DatabaseConnectionSummary[] };
            } catch {
                throw new Error(`Failed to inspect database connections: ${stdout}`);
            }

            const connections = Array.isArray(decoded.connections) ? decoded.connections : [];
            const text = JSON.stringify(
                {
                    default_connection: decoded.default_connection,
                    connections,
                },
                null,
                2,
            );

            return {
                content: [{ type: "text", text }],
                details: {
                    app_path: toRelativeAppPath(ctx.cwd, appPath),
                    default_connection: decoded.default_connection,
                    connections,
                },
            };
        },
    });
}
