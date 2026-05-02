import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import { resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";

const execFileAsync = promisify(execFile);

const DatabaseSchemaParams = Type.Object({
	app_path: Type.Optional(
		Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
	),
	database: Type.Optional(
		Type.String({ description: "Optional Laravel database connection name. Defaults to the app's default connection." }),
	),
	table: Type.Optional(
		Type.String({ description: "Optional table name. When provided, returns detailed schema information for that table." }),
	),
	filter: Type.Optional(
		Type.String({ description: "Optional substring filter for table names when listing tables." }),
	),
	include_column_details: Type.Optional(
		Type.Boolean({ description: "Include nullable/default/auto_increment/comment/generation metadata for columns." }),
	),
	include_views: Type.Optional(
		Type.Boolean({ description: "Include database views when listing schema." }),
	),
	include_routines: Type.Optional(
		Type.Boolean({ description: "Include stored procedures, functions, and sequences when supported." }),
	),
});

export function registerDatabaseSchemaTool(pi: ExtensionAPI) {
	registerTool(pi, {
		name: "database_schema",
		label: "Database Schema",
		description:
			"Browse Laravel database schema information, including tables, columns, indexes, and foreign keys for a selected connection.",
		promptSnippet: "Inspect Laravel database schema before writing or running queries",
		promptGuidelines: [
			"Use this tool before database_query when you need table, column, index, or foreign key details.",
			"List or filter tables first, then request a specific table for detailed schema output.",
		],
		parameters: DatabaseSchemaParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
			const payload = Buffer.from(
				JSON.stringify({
					database: params.database,
					table: params.table,
					filter: params.filter,
					include_column_details: params.include_column_details ?? false,
					include_views: params.include_views ?? false,
					include_routines: params.include_routines ?? false,
				}),
			).toString("base64");

			const php = [
				"error_reporting(E_ERROR);",
				"require 'vendor/autoload.php';",
				"$app = require 'bootstrap/app.php';",
				"$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);",
				"$kernel->bootstrap();",
				`$payload = json_decode(base64_decode('${payload}'), true) ?: [];`,
				"$connection = $payload['database'] ?? config('database.default');",
				"$table = isset($payload['table']) ? trim((string) $payload['table']) : '';",
				"$filter = isset($payload['filter']) ? strtolower(trim((string) $payload['filter'])) : '';",
				"$includeColumnDetails = (bool) ($payload['include_column_details'] ?? false);",
				"$includeViews = (bool) ($payload['include_views'] ?? false);",
				"$includeRoutines = (bool) ($payload['include_routines'] ?? false);",
				"$db = Illuminate\\Support\\Facades\\DB::connection($connection);",
				"$schema = Illuminate\\Support\\Facades\\Schema::connection($connection);",
				"$driver = $db->getDriverName();",
				"$normalizeTableName = function ($table) {",
				"  if (is_object($table)) { foreach (['name', 'table_name', 'tablename', 'TABLE_NAME'] as $key) { if (isset($table->$key)) return (string) $table->$key; } }",
				"  if (is_array($table)) { foreach (['name', 'table_name', 'tablename', 'TABLE_NAME'] as $key) { if (isset($table[$key])) return (string) $table[$key]; } }",
				"  return is_string($table) ? $table : '';",
				"};",
				"$getTables = function () use ($schema, $driver, $db, $normalizeTableName) {",
				"  try { if (method_exists($schema, 'getTables')) { return array_values(array_filter(array_map($normalizeTableName, $schema->getTables()))); } } catch (Throwable $e) {}",
				"  try {",
				"    $rows = match ($driver) {",
				"      'mysql', 'mariadb' => $db->select('SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = ? ORDER BY TABLE_NAME', ['BASE TABLE']),",
				"      'pgsql' => $db->select('SELECT tablename as name FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename'),",
				"      'sqlite' => $db->select(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name\"),",
				"      default => [],",
				"    };",
				"    return array_values(array_filter(array_map($normalizeTableName, $rows)));",
				"  } catch (Throwable $e) { return []; }",
				"};",
				"$getViews = function () use ($schema, $driver, $db, $normalizeTableName) {",
				"  try { if (method_exists($schema, 'getViews')) { return $schema->getViews(); } } catch (Throwable $e) {}",
				"  try { return match ($driver) {",
				"    'mysql', 'mariadb' => $db->select('SELECT TABLE_NAME as name, VIEW_DEFINITION as definition FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()'),",
				"    'pgsql' => $db->select(\"SELECT schemaname, viewname as name, definition FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema')\"),",
				"    'sqlite' => $db->select(\"SELECT name, sql as definition FROM sqlite_master WHERE type = 'view'\"),",
				"    default => [], }; } catch (Throwable $e) { return []; }",
				"};",
				"$getRoutines = function () use ($driver, $db) {",
				"  try {",
				"    if ($driver === 'mysql' || $driver === 'mariadb') { return [",
				"      'stored_procedures' => $db->select('SHOW PROCEDURE STATUS WHERE Db = DATABASE()'),",
				"      'functions' => $db->select('SHOW FUNCTION STATUS WHERE Db = DATABASE()'),",
				"      'sequences' => [], ]; }",
				"    if ($driver === 'pgsql') { return [",
				"      'stored_procedures' => $db->select(\"SELECT proname, prosrc, proargnames, prorettype FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND prokind = 'p'\"),",
				"      'functions' => $db->select(\"SELECT proname, prosrc, proargnames, prorettype FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND prokind = 'f'\"),",
				"      'sequences' => $db->select('SELECT sequence_name, start_value, minimum_value, maximum_value, increment FROM information_schema.sequences WHERE sequence_schema = current_schema()'), ]; }",
				"  } catch (Throwable $e) {}",
				"  return ['stored_procedures' => [], 'functions' => [], 'sequences' => []];",
				"};",
				"$getTriggers = function ($tableName) use ($driver, $db) {",
				"  try {",
				"    if ($driver === 'mysql' || $driver === 'mariadb') { return $db->select('SHOW TRIGGERS WHERE `Table` = ?', [$tableName]); }",
				"    if ($driver === 'pgsql') { return $db->select('SELECT trigger_name, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema = current_schema() AND event_object_table = ?', [$tableName]); }",
				"    if ($driver === 'sqlite') { return $db->select(\"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?\", [$tableName]); }",
				"  } catch (Throwable $e) {}",
				"  return [];",
				"};",
				"$getCheckConstraints = function ($tableName) use ($driver, $db) {",
				"  try {",
				"    if ($driver === 'mysql' || $driver === 'mariadb') { return $db->select('SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?', [$tableName]); }",
				"    if ($driver === 'pgsql') { return $db->select(\"SELECT conname, pg_get_constraintdef(oid) as definition FROM pg_constraint WHERE contype = 'c' AND conrelid = ?::regclass\", [$tableName]); }",
				"  } catch (Throwable $e) {}",
				"  return [];",
				"};",
				"$getColumns = function ($tableName) use ($schema, $includeColumnDetails) {",
				"  $details = [];",
				"  foreach ($schema->getColumns($tableName) as $column) {",
				"    $detail = ['type' => $column['type'] ?? null];",
				"    if ($includeColumnDetails) {",
				"      $detail['nullable'] = $column['nullable'] ?? null;",
				"      $detail['default'] = $column['default'] ?? null;",
				"      $detail['auto_increment'] = $column['auto_increment'] ?? null;",
				"      if (($column['comment'] ?? null) !== null && ($column['comment'] ?? '') !== '') $detail['comment'] = $column['comment'];",
				"      if (($column['generation'] ?? null) !== null) $detail['generation'] = $column['generation'];",
				"    }",
				"    $details[$column['name']] = $detail;",
				"  }",
				"  return $details;",
				"};",
				"$getIndexes = function ($tableName) use ($schema) {",
				"  try { $indexes = []; foreach ($schema->getIndexes($tableName) as $index) { $indexes[$index['name']] = ['columns' => $index['columns'] ?? null, 'type' => $index['type'] ?? null, 'is_unique' => $index['unique'] ?? false, 'is_primary' => $index['primary'] ?? false]; } return $indexes; } catch (Throwable $e) { return []; }",
				"};",
				"$getForeignKeys = function ($tableName) use ($schema) { try { return $schema->getForeignKeys($tableName); } catch (Throwable $e) { return []; } };",
				"$allTables = array_values(array_filter($getTables(), function ($name) use ($filter) { return $filter === '' || str_contains(strtolower($name), $filter); }));",
				"sort($allTables);",
				"if ($table !== '') {",
				"  if (! in_array($table, $allTables, true) && ! in_array($table, $getTables(), true)) { echo json_encode(['error' => 'Table not found: '.$table], JSON_UNESCAPED_SLASHES); exit(1); }",
				"  $result = [",
				"    'engine' => $driver,",
				"    'connection' => $connection,",
				"    'table' => $table,",
				"    'columns' => $getColumns($table),",
				"    'indexes' => $getIndexes($table),",
				"    'foreign_keys' => $getForeignKeys($table),",
				"    'triggers' => $getTriggers($table),",
				"    'check_constraints' => $getCheckConstraints($table),",
				"  ];",
				"  echo json_encode($result, JSON_UNESCAPED_SLASHES);",
				"  exit(0);",
				"}",
				"$result = ['engine' => $driver, 'connection' => $connection, 'tables' => $allTables];",
				"if ($includeViews) { $result['views'] = $getViews(); }",
				"if ($includeRoutines) { $result['routines'] = $getRoutines(); }",
				"echo json_encode($result, JSON_UNESCAPED_SLASHES);",
			].join(" ");

			let stdout = "";
			try {
				const result = await execFileAsync("php", ["-r", php], { cwd: appPath, maxBuffer: 50 * 1024 * 1024 });
				stdout = result.stdout.trim();
			} catch (error) {
				const failed = error as { stdout?: string; stderr?: string; message?: string };
				stdout = failed.stdout?.trim() || "";
				if (!stdout) {
					throw new Error(failed.stderr?.trim() || failed.message || "Failed to inspect database schema.");
				}
			}

			if (!stdout) {
				throw new Error("Failed to inspect database schema: no output from Laravel application.");
			}

			let decoded: Record<string, unknown>;
			try {
				decoded = JSON.parse(stdout) as Record<string, unknown>;
			} catch {
				throw new Error(`Failed to inspect database schema: ${stdout}`);
			}

			if (typeof decoded.error === "string" && decoded.error) {
				throw new Error(decoded.error);
			}

			return {
				content: [{ type: "text", text: JSON.stringify(decoded, null, 2) }],
				details: {
					app_path: toRelativeAppPath(ctx.cwd, appPath),
					database: params.database?.trim() || undefined,
					table: params.table?.trim() || undefined,
					filter: params.filter?.trim() || undefined,
					...decoded,
				},
			};
		},
	});
}
