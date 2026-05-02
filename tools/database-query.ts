import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import { resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";

const execFileAsync = promisify(execFile);

const DatabaseQueryParams = Type.Object({
	app_path: Type.Optional(
		Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
	),
	query: Type.String({
		description:
			"SQL query to execute. Only read-only queries are allowed, such as SELECT, SHOW, EXPLAIN, DESCRIBE, DESC, VALUES, TABLE, or WITH ... SELECT.",
	}),
	database: Type.Optional(
		Type.String({ description: "Optional Laravel database connection name. Defaults to the app's default connection." }),
	),
	limit: Type.Optional(
		Type.Integer({ description: "Maximum number of rows to return after execution. Default 100, max 1000." }),
	),
});

interface DatabaseQueryResult {
	connection?: string;
	row_count?: number;
	returned_count?: number;
	columns?: string[];
	rows?: Array<Record<string, unknown>>;
	error?: string;
}

export function registerDatabaseQueryTool(pi: ExtensionAPI) {
	registerTool(pi, {
		name: "database_query",
		label: "Database Query",
		description:
			"Execute a read-only SQL query against a Laravel database connection and return structured rows with column names.",
		promptSnippet: "Run a read-only SQL query against a Laravel database connection",
		promptGuidelines: [
			"Use database_connections first to confirm the connection name and database driver.",
			"Only use read-only SQL with this tool. Destructive statements are blocked.",
		],
		parameters: DatabaseQueryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
			const limit = Math.min(1000, Math.max(1, params.limit ?? 100));
			const payload = Buffer.from(
				JSON.stringify({
					query: params.query,
					database: params.database,
					limit,
				}),
			).toString("base64");

			const php = [
				"error_reporting(E_ERROR);",
				"require 'vendor/autoload.php';",
				"$app = require 'bootstrap/app.php';",
				"$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);",
				"$kernel->bootstrap();",
				`$payload = json_decode(base64_decode('${payload}'), true) ?: [];`,
				"$query = trim((string) ($payload['query'] ?? ''));",
				"$connectionName = $payload['database'] ?? null;",
				"$limit = max(1, min(1000, (int) ($payload['limit'] ?? 100)));",
				"$token = strtok(ltrim($query), \" \t\\n\\r\");",
				"if (! $token) { echo json_encode(['error' => 'Please pass a valid query'], JSON_UNESCAPED_SLASHES); exit(1); }",
				"$firstWord = strtoupper($token);",
				"$allowList = ['SELECT', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'WITH', 'VALUES', 'TABLE'];",
				"$isReadOnly = in_array($firstWord, $allowList, true);",
				"if ($firstWord === 'WITH') {",
				"  if (! preg_match('/\\)\\s*SELECT\\b/i', $query)) { $isReadOnly = false; }",
				"  if (preg_match('/\\)\\s*(DELETE|UPDATE|INSERT|DROP|ALTER|TRUNCATE|REPLACE|RENAME|CREATE)\\b/i', $query)) { $isReadOnly = false; }",
				"}",
				"if (! $isReadOnly) { echo json_encode(['error' => 'Only read-only queries are allowed (SELECT, SHOW, EXPLAIN, DESCRIBE, DESC, WITH … SELECT).'], JSON_UNESCAPED_SLASHES); exit(1); }",
				"try {",
				"  $connection = Illuminate\\Support\\Facades\\DB::connection($connectionName);",
				"  $prefix = $connection->getTablePrefix();",
				"  if ($prefix) {",
				"    $cteNames = [];",
				"    if (preg_match_all('/\\b(\\w+)\\s*(?:\\([^)]*\\))?\\s*AS\\s*\\(/i', $query, $cteMatches)) { $cteNames = $cteMatches[1]; }",
				"    $query = preg_replace_callback(\"/\\b(FROM|JOIN|INTO|UPDATE|TABLE|DESCRIBE|DESC)\\s+([`\\\"']?)(\\w+)\\2/i\", function ($matches) use ($prefix, $cteNames) {",
				"      $keyword = $matches[1];",
				"      $quote = $matches[2];",
				"      $tableName = $matches[3];",
				"      if (str_starts_with($tableName, $prefix) || in_array($tableName, $cteNames, true)) { return $matches[0]; }",
				"      return \"{$keyword} {$quote}{$prefix}{$tableName}{$quote}\";",
				"    }, $query) ?? $query;",
				"  }",
				"  $rows = array_map(function ($row) { return json_decode(json_encode($row, JSON_UNESCAPED_SLASHES), true); }, $connection->select($query));",
				"  $columns = isset($rows[0]) && is_array($rows[0]) ? array_values(array_map('strval', array_keys($rows[0]))) : [];",
				"  $rowCount = count($rows);",
				"  if ($rowCount > $limit) { $rows = array_slice($rows, 0, $limit); }",
				"  echo json_encode([",
				"    'connection' => $connectionName ?: config('database.default'),",
				"    'row_count' => $rowCount,",
				"    'returned_count' => count($rows),",
				"    'columns' => $columns,",
				"    'rows' => $rows,",
				"  ], JSON_UNESCAPED_SLASHES);",
				"} catch (Throwable $e) {",
				"  echo json_encode(['error' => 'Query failed: '.$e->getMessage()], JSON_UNESCAPED_SLASHES);",
				"  exit(1);",
				"}",
			].join(" ");

			let stdout = "";
			try {
				const result = await execFileAsync("php", ["-r", php], { cwd: appPath, maxBuffer: 20 * 1024 * 1024 });
				stdout = result.stdout.trim();
			} catch (error) {
				const failed = error as { stdout?: string; stderr?: string; message?: string };
				stdout = failed.stdout?.trim() || "";
				if (!stdout) {
					throw new Error(failed.stderr?.trim() || failed.message || "Failed to execute database query.");
				}
			}

			if (!stdout) {
				throw new Error("Failed to execute database query: no output from Laravel application.");
			}

			let decoded: DatabaseQueryResult;
			try {
				decoded = JSON.parse(stdout) as DatabaseQueryResult;
			} catch {
				throw new Error(`Failed to execute database query: ${stdout}`);
			}

			if (decoded.error) {
				throw new Error(decoded.error);
			}

			const result = {
				connection: decoded.connection,
				row_count: decoded.row_count ?? 0,
				returned_count: decoded.returned_count ?? 0,
				columns: Array.isArray(decoded.columns) ? decoded.columns : [],
				rows: Array.isArray(decoded.rows) ? decoded.rows : [],
			};

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: {
					app_path: toRelativeAppPath(ctx.cwd, appPath),
					query: params.query,
					requested_connection: params.database?.trim() || undefined,
					limit,
					...result,
				},
			};
		},
	});
}
