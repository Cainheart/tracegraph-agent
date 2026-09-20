import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  McpConfigSchema,
  McpServerStatusSchema,
  McpToolCalledDataSchema,
} from "./index.js";

const baseServer = {
  name: "filesystem",
  command: "node",
  args: ["server.mjs"],
  required: false,
  transport: "stdio" as const,
};

describe("G11 MCP contracts", () => {
  it("requires secret references for secret-looking environment keys", () => {
    expect(() => McpConfigSchema.parse({
      config_version: "tracegraph.mcp.v1",
      servers: [{ ...baseServer, env: { API_TOKEN: "plaintext" } }],
    })).toThrow();
    expect(() => McpConfigSchema.parse({
      config_version: "tracegraph.mcp.v1",
      servers: [{ ...baseServer, env: { api_token: "plaintext" } }],
    })).toThrow();
    expect(McpConfigSchema.parse({
      config_version: "tracegraph.mcp.v1",
      servers: [{ ...baseServer, env: { API_TOKEN: "\${secret:FILESYSTEM_TOKEN}" } }],
    }).servers[0]?.env.API_TOKEN).toBe("\${secret:FILESYSTEM_TOKEN}");
  });

  it("keeps server status bounded and rejects inconsistent tool counts", () => {
    expect(() => McpServerStatusSchema.parse({
      ...baseServer,
      state: "ready",
      tool_count: 1,
      tools: [],
      updated_at: "2026-09-20T00:00:00.000Z",
    })).toThrow();
    expect(McpServerStatusSchema.parse({
      name: baseServer.name,
      required: baseServer.required,
      transport: baseServer.transport,
      state: "degraded",
      tool_count: 0,
      tools: [],
      updated_at: "2026-09-20T00:00:00.000Z",
      error_code: "mcp_spawn_failed",
      error_message: "server unavailable",
    }).state).toBe("degraded");
  });

  it("appends the five MCP canonical event types with strict call facts", () => {
    expect(EventTypeSchema.options).toEqual(expect.arrayContaining([
      "mcp.server_started",
      "mcp.server_failed",
      "mcp.server_stopped",
      "mcp.tools_changed",
      "mcp.tool_called",
    ]));
    expect(McpToolCalledDataSchema.parse({
      server_name: "filesystem",
      tool_name: "read_file",
      qualified_name: "mcp_filesystem__read_file",
      arguments_hash: "sha256:" + "a".repeat(64),
      duration_ms: 2,
      result_bytes: 42,
      status: "success",
      code: "mcp_tool_completed",
    }).result_bytes).toBe(42);
  });
});
