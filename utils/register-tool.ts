import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Workaround for pi 0.70.0 + TypeBox 1.x TS2589 type depth issue.
 * Use this instead of pi.registerTool() until pi ships a fix.
 */
export function registerTool<T>(pi: ExtensionAPI, tool: T): void {
	(pi as any).registerTool(tool);
}
