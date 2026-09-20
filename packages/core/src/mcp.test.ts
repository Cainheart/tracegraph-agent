import { McpConfigSchema, type McpServerConfig, type McpToolCatalogEntry } from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import {
  McpManager,
  McpStdioClient,
  createMcpToolsExtension,
} from "./index.js";
import type { McpClientOptions, McpRemoteTool } from "./mcp/client.js";
import { ExtensionManager } from "./extension.js";
import { createCoreToolRegistry } from "./tool-registry.js";

const objectSchema = {
  type: "object" as const,
  properties: {
    path: { type: "string" as const, maxLength: 200 },
  },
  additionalProperties: false,
};

class FakeMcpClient extends McpStdioClient {
  #tools: readonly McpRemoteTool[];
  #onToolsChanged: (() => void | Promise<void>) | undefined;

  constructor(
    config: McpServerConfig,
    options: McpClientOptions,
    tools: readonly McpRemoteTool[],
  ) {
    super(config, options);
    this.#tools = tools;
    this.#onToolsChanged = options.onToolsChanged;
  }

  setTools(tools: readonly McpRemoteTool[]): void {
    this.#tools = tools;
  }

  notifyToolsChanged(): void {
    void this.#onToolsChanged?.();
  }

  override async start(): Promise<readonly McpRemoteTool[]> {
    return this.#tools;
  }

  override async listTools(): Promise<readonly McpRemoteTool[]> {
    return this.#tools;
  }

  override callTool(_name: string, _argumentsValue: Record<string, unknown>): Promise<unknown> {
    return Promise.resolve({
      content: [{ type: "text", text: "fake MCP result" }],
      structuredContent: { ok: true },
    });
  }

  override async stop(): Promise<void> {}
}

function config(servers: readonly McpServerConfig[]): ReturnType<typeof McpConfigSchema.parse> {
  return McpConfigSchema.parse({ config_version: "tracegraph.mcp.v1", servers });
}

function server(name: string, required = false): McpServerConfig {
  return {
    name,
    command: process.execPath,
    args: ["-e", "process.stderr.write('not used')"],
    env: {},
    required,
    transport: "stdio",
  };
}

describe("McpManager", () => {
  it("keeps an optional missing process degraded and records failure", async () => {
    const manager = new McpManager({
      config: config([{
        ...server("optional-missing"),
        command: "__tracegraph_missing_mcp_command__",
      }]),
      requestTimeoutMs: 100,
    });

    await expect(manager.start()).resolves.toMatchObject({
      servers: [{ name: "optional-missing", state: "degraded" }],
    });
    expect(manager.history().map((event) => event.type)).toContain("mcp.server_failed");
    expect(manager.listTools()).toHaveLength(0);
  });

  it("aborts startup for a required process and keeps stderr in the error", async () => {
    const manager = new McpManager({
      config: config([{
        ...server("required-failing", true),
        args: ["-e", "console.error('required-stderr-tail'); process.exit(2)"],
      }]),
      requestTimeoutMs: 100,
    });

    await expect(manager.start()).rejects.toThrow(/required-failing.*required-stderr-tail/u);
    expect(manager.snapshot().servers[0]?.state).toBe("degraded");
    expect(manager.history().at(-1)?.type).toBe("mcp.server_failed");
  });

  it("refreshes the extension catalog after tools/list_changed", async () => {
    let client: FakeMcpClient | undefined;
    const first: McpRemoteTool = {
      name: "read_file",
      description: "Read a file",
      inputSchema: objectSchema,
      readOnlyHint: true,
    };
    const second: McpRemoteTool = {
      name: "write_file",
      description: "Write a file",
      inputSchema: objectSchema,
      destructiveHint: true,
    };
    const manager = new McpManager({
      config: config([server("fixture")]),
      clientFactory: (serverConfig, options) => {
        client = new FakeMcpClient(serverConfig, options, [first]);
        return client;
      },
    });
    const extensions = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    await manager.start();
    await extensions.activate(createMcpToolsExtension(manager));
    expect(extensions.toolRegistry.get("mcp_fixture__read_file")?.sideEffect).toBe("read");

    client!.setTools([second]);
    client!.notifyToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(extensions.toolRegistry.get("mcp_fixture__read_file")).toBeUndefined();
    expect(extensions.toolRegistry.get("mcp_fixture__write_file")?.sideEffect).toBe("write");
    expect(manager.history().map((event) => event.type)).toContain("mcp.tools_changed");
  });

  it("maps a call to a bounded RawToolResult and emits the called fact", async () => {
    const tool: McpRemoteTool = {
      name: "read_file",
      description: "Read a file",
      inputSchema: objectSchema,
      readOnlyHint: true,
    };
    const manager = new McpManager({
      config: config([server("fixture")]),
      clientFactory: (serverConfig, options) => new FakeMcpClient(serverConfig, options, [tool]),
    });
    await manager.start();
    const entry = manager.listTools()[0] as McpToolCatalogEntry;
    const result = await manager.callTool(entry, { path: "README.md" });
    expect(result).toMatchObject({ status: "success", code: "mcp_tool_completed" });
    expect(result.content).toContain("fake MCP result");
    expect(manager.history().at(-1)?.type).toBe("mcp.tool_called");
  });

  it("speaks the bounded stdio JSON-RPC lifecycle with a real child process", async () => {
    const fixture = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
      "rl.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' } } });",
      "  else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { value: { type: 'string', maxLength: 64 } }, additionalProperties: false }, annotations: { readOnlyHint: true } }] } });",
      "  else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: String(request.params.arguments.value) }], structuredContent: { echoed: request.params.arguments.value } } });",
      "});",
    ].join("\n");
    const manager = new McpManager({
      config: config([{ ...server("stdio-fixture"), args: ["-e", fixture] }]),
      requestTimeoutMs: 2_000,
    });

    await expect(manager.start()).resolves.toMatchObject({
      servers: [{ name: "stdio-fixture", state: "ready", tool_count: 1 }],
    });
    const entry = manager.listTools()[0] as McpToolCatalogEntry;
    await expect(manager.callTool(entry, { value: "hello" })).resolves.toMatchObject({
      status: "success",
      content: expect.stringContaining("hello"),
    });
    await manager.stop();
    expect(manager.history().map((event) => event.type)).toEqual(expect.arrayContaining([
      "mcp.server_started",
      "mcp.tool_called",
      "mcp.server_stopped",
    ]));
  });

  it("moves a ready server to degraded when its process exits unexpectedly", async () => {
    const fixture = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
      "rl.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } });",
      "  else if (request.method === 'tools/list') { send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } }); setTimeout(() => process.exit(7), 30); }",
      "});",
    ].join("\n");
    const manager = new McpManager({
      config: config([{ ...server("crashing"), args: ["-e", fixture] }]),
      requestTimeoutMs: 2_000,
    });

    await expect(manager.start()).resolves.toMatchObject({
      servers: [{ name: "crashing", state: "ready", tool_count: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(manager.snapshot().servers[0]).toMatchObject({ name: "crashing", state: "degraded", tool_count: 0 });
    expect(manager.history().map((event) => event.type)).toEqual(expect.arrayContaining([
      "mcp.tools_changed",
      "mcp.server_failed",
    ]));
  });
});
