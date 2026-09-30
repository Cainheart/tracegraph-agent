import {
  EXTENSION_API_VERSION,
  RawToolResultSchema,
  type McpToolCatalogEntry,
} from "@tracegraph/contracts";
import { z } from "zod";
import type { Disposable, ToolExtension } from "../../kernel/registration.js";
import type { McpToolBridge, ToolDefinition } from "../../kernel/tool/definition.js";
import type { McpRuntimePort } from "./ports.js";

export const MCP_EXTENSION_NAME = "@tracegraph/mcp-stdio" as const;
export const MCP_EXTENSION_API_VERSION = EXTENSION_API_VERSION;

export function createMcpToolsExtension(manager: McpRuntimePort): ToolExtension {
  const registrations = new Map<string, Disposable>();
  let context: Parameters<ToolExtension["activate"]>[0] | undefined;
  let listener: Disposable | undefined;
  const sync = async (): Promise<void> => {
    if (context === undefined) return;
    const next = new Map(manager.listTools().map((entry) => [entry.qualified_name, entry]));
    for (const [name, disposable] of [...registrations]) {
      if (next.has(name)) continue;
      try { await disposable.dispose(); } catch { return; }
      registrations.delete(name);
    }
    for (const [name, entry] of next) {
      if (registrations.has(name)) continue;
      try { registrations.set(name, context.registerTool(mcpToolDefinition(manager, entry))); }
      catch { /* active Run leases defer the next refresh/restart */ }
    }
  };
  return {
    name: MCP_EXTENSION_NAME,
    api_version: MCP_EXTENSION_API_VERSION,
    async activate(nextContext) {
      context = nextContext;
      await sync();
      listener = manager.onEvent((event) => event.type === "mcp.tools_changed" ? sync() : undefined);
    },
    async deactivate() {
      listener?.dispose();
      listener = undefined;
      for (const registration of registrations.values()) await Promise.resolve(registration.dispose()).catch(() => undefined);
      registrations.clear();
      context = undefined;
    },
  };
}

function mcpToolDefinition(manager: McpRuntimePort, entry: McpToolCatalogEntry): ToolDefinition {
  return {
    name: entry.qualified_name,
    description: `MCP ${entry.server_name} tool: ${entry.description}`,
    inputSchema: z.record(z.string(), z.unknown()),
    modelInputSchema: entry.input_schema,
    outputSchema: RawToolResultSchema,
    capability: "read",
    requiresApproval: false,
    timeoutMs: manager.toolTimeoutMs,
    concurrencySafe: entry.side_effect === "none" || entry.side_effect === "read",
    sideEffect: entry.side_effect,
    maxResultBytes: 128 * 1024,
    presentation: {
      callLabel: `MCP ${entry.server_name}/${entry.name}`,
      resultLabel: `MCP ${entry.name} result`,
    },
    async execute(input, context) {
      const bridge = context.mcp as McpToolBridge | undefined;
      return bridge === undefined
        ? manager.callTool(entry, input as Record<string, unknown>, context.signal)
        : bridge.call(entry, input as Record<string, unknown>, context.signal);
    },
    render(_input, output) { return output; },
  };
}
