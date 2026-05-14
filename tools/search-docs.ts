import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "../utils/register-tool.ts";
import { getProjectPackages, resolveLaravelAppPath, toRelativeAppPath, toSearchDocPackages } from "../utils/project.ts";

const SearchDocsParams = Type.Object({
    queries: Type.Array(Type.String({ description: "Documentation search query" })),
    packages: Type.Optional(
        Type.Array(Type.String({ description: "Optional package names to restrict searching to" })),
    ),
    app_path: Type.Optional(
        Type.String({ description: "Path to the Laravel app, relative to the current repo root" }),
    ),
    token_limit: Type.Optional(
        Type.Integer({ description: "Maximum tokens to return. Default 3000, capped at 1000000" }),
    ),
});

const SEARCH_DOCS_TIMEOUT_MS = 15_000;

function createAbortSignal(timeoutMs: number, signal?: AbortSignal) {
    const controller = new AbortController();
    let timeoutReached = false;

    const abortWithReason = (reason: unknown) => {
        if (!controller.signal.aborted) {
            controller.abort(reason);
        }
    };

    const timeout = setTimeout(() => {
        timeoutReached = true;
        abortWithReason(new Error(`Documentation search timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onAbort = () => {
        abortWithReason(signal?.reason ?? new Error("Documentation search was aborted."));
    };

    if (signal) {
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    }

    return {
        signal: controller.signal,
        didTimeout: () => timeoutReached,
        cleanup: () => {
            clearTimeout(timeout);
            if (signal && !signal.aborted) {
                signal.removeEventListener("abort", onAbort);
            }
        },
    };
}

function toSearchDocsError(error: unknown, didTimeout: boolean, signal?: AbortSignal) {
    if (didTimeout) {
        return new Error(`Documentation search timed out after ${SEARCH_DOCS_TIMEOUT_MS}ms.`);
    }

    if (signal?.aborted) {
        const reason = signal.reason;
        const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "The tool invocation was aborted.";
        return new Error(`Documentation search was aborted: ${detail}`);
    }

    if (error instanceof Error && error.name === "AbortError") {
        return new Error("Documentation search was aborted.");
    }

    return error instanceof Error ? error : new Error("Documentation search failed.");
}

export function registerSearchDocsTool(pi: ExtensionAPI) {
    registerTool(pi, {
        name: "search_docs",
        label: "Search Docs",
        description:
            "Search version-specific Laravel ecosystem documentation for this project and its packages. Use this before other approaches for Laravel, Inertia, Livewire, Pest, Filament, Tailwind, and related packages.",
        promptSnippet: "Search version-specific Laravel ecosystem documentation for this project",
        promptGuidelines: [
            "Use this tool before generic search whenever the task involves Laravel ecosystem APIs, upgrade guidance, or package-specific docs.",
        ],
        parameters: SearchDocsParams,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const queries = (params.queries ?? []).map((query) => query.trim()).filter((query) => query && query !== "*");
            if (queries.length === 0) {
                throw new Error("At least one non-empty query is required.");
            }

            const appPath = await resolveLaravelAppPath(ctx.cwd, params.app_path);
            const packages = toSearchDocPackages(await getProjectPackages(appPath), params.packages);
            const tokenLimit = Math.min(params.token_limit ?? 3000, 1_000_000);
            const apiUrl = "https://boost.laravel.com/api/docs";
            const request = createAbortSignal(SEARCH_DOCS_TIMEOUT_MS, signal);

            try {
                const response = await fetch(apiUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    signal: request.signal,
                    body: JSON.stringify({
                        queries,
                        packages,
                        token_limit: tokenLimit,
                        format: "markdown",
                    }),
                });

                const text = await response.text();
                if (!response.ok) {
                    throw new Error(`Documentation search failed: ${text}`);
                }

                return {
                    content: [{ type: "text", text }],
                    details: {
                        app_path: toRelativeAppPath(ctx.cwd, appPath),
                        queries,
                        packages,
                        token_limit: tokenLimit,
                        api_url: apiUrl,
                    },
                };
            } catch (error) {
                throw toSearchDocsError(error, request.didTimeout(), signal);
            } finally {
                request.cleanup();
            }
        },
    });
}
