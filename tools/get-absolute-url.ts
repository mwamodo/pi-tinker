import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import { resolveLaravelAppPath, toRelativeAppPath } from "../utils/project.ts";

const execFileAsync = promisify(execFile);

const GetAbsoluteUrlParams = Type.Object({
    app_path: Type.Optional(
        Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
    ),
    path: Type.Optional(
        Type.String({ description: "Relative URL/path to convert to an absolute URL, for example /dashboard" }),
    ),
    route: Type.Optional(
        Type.String({ description: "Named Laravel route to generate an absolute URL for, for example home" }),
    ),
    parameters: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
            description: "Optional route parameters for named routes, useful for route model keys or domain placeholders",
        }),
    ),
});

export function registerGetAbsoluteUrlTool(pi: ExtensionAPI) {
    registerTool(pi, {
        name: "get_absolute_url",
        label: "Get Absolute URL",
        description:
            "Resolve a fully qualified application URL from a relative path or named Laravel route. Respects the app's URL configuration and route/domain setup.",
        promptSnippet: "Resolve a fully qualified Laravel application URL from a path or named route",
        promptGuidelines: [
            "Use this tool before browser-oriented tooling when you need the correct absolute app URL.",
            "Prefer route generation when the destination is a named Laravel route or may depend on domain configuration.",
        ],
        parameters: GetAbsoluteUrlParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
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
                "try {",
                "  if (is_string($path) && trim($path) !== '') { $url = url($path); }",
                "  elseif (is_string($route) && trim($route) !== '') { $url = route($route, $parameters, true); }",
                "  else { $url = url('/'); }",
                "  echo json_encode(['url' => $url], JSON_UNESCAPED_SLASHES);",
                "} catch (Throwable $e) {",
                "  echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_SLASHES);",
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
                    throw new Error(failed.stderr?.trim() || failed.message || "Failed to resolve URL.");
                }
            }
            if (!stdout) {
                throw new Error("Failed to resolve URL: no output from Laravel application.");
            }

            let decoded: { url?: string; error?: string };
            try {
                decoded = JSON.parse(stdout) as { url?: string; error?: string };
            } catch {
                throw new Error(`Failed to resolve URL: ${stdout}`);
            }

            if (decoded.error) {
                throw new Error(`Failed to resolve URL: ${decoded.error}`);
            }

            if (!decoded.url) {
                throw new Error("Failed to resolve URL: Laravel did not return a URL.");
            }

            return {
                content: [{ type: "text", text: decoded.url }],
                details: {
                    app_path: toRelativeAppPath(ctx.cwd, appPath),
                    url: decoded.url,
                    path: params.path?.trim() || undefined,
                    route: params.route?.trim() || undefined,
                    parameters: params.parameters ?? {},
                },
            };
        },
    });
}
