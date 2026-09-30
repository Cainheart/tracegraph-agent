import { describe, expect, it } from "vitest";
import { McpToolCatalogEntrySchema, type McpManagerEvent } from "@tracegraph/contracts";
import { ExtensionManager } from "../../domains/extensions/index.js";
import { createCoreToolRegistry } from "../../domains/tools/index.js";
import { createMcpToolsExtension } from "./tool-extension.js";
import type { McpRuntimePort } from "./ports.js";

const first = McpToolCatalogEntrySchema.parse({
  server_name: "fixture",
  name: "read_file",
  qualified_name: "mcp_fixture__read_file",
  description: "Read a file",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  side_effect: "read",
});
const replacement = McpToolCatalogEntrySchema.parse({
  server_name: "fixture",
  name: "write_file",
  qualified_name: "mcp_fixture__write_file",
  description: "Write a file",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  side_effect: "write",
});

describe("Core MCP Tool adapter", () => {
  it("registers and atomically refreshes tools through the provider port", async () => {
    let tools = [first];
    const listeners = new Set<(event: McpManagerEvent) => void | Promise<void>>();
    const manager: McpRuntimePort = {
      toolTimeoutMs: 2_000,
      listTools: () => tools,
      history: () => [],
      onEvent(listener) {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
      async callTool() {
        return { status: "success", code: "done", summary: "completed" };
      },
    };
    const toolRegistry = createCoreToolRegistry();
    const extensions = new ExtensionManager({ toolRegistry });
    await extensions.activate(createMcpToolsExtension(manager));

    expect(toolRegistry.get(first.qualified_name)?.sideEffect).toBe("read");
    tools = [replacement];
    const event: McpManagerEvent = {
      type: "mcp.tools_changed",
      occurred_at: new Date().toISOString(),
      data: { server_name: "fixture", added: [replacement.qualified_name], removed: [first.qualified_name], tool_count: 1 },
    };
    await Promise.all([...listeners].map((listener) => listener(event)));

    expect(toolRegistry.get(first.qualified_name)).toBeUndefined();
    expect(toolRegistry.get(replacement.qualified_name)?.sideEffect).toBe("write");
  });
});
