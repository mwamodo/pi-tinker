import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Workaround for TypeScript TS2589 type depth issue with TypeBox 1.x
 * schemas. Use this instead of pi.registerTool() when defining complex
 * tool parameter schemas that trigger excessively deep type instantiation.
 */
export function registerTool<T>(pi: ExtensionAPI, tool: T): void {
	(pi as any).registerTool(tool);
}
