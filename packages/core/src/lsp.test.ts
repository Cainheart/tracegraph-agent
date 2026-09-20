import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LspConfigSchema } from "@tracegraph/contracts";
import { LspManager } from "./lsp/index.js";

function config(command: string, args: readonly string[], diagnosticsWaitMs = 30) {
  return LspConfigSchema.parse({
    config_version: "tracegraph.lsp.v1",
    servers: [{
      name: "fixture",
      command,
      args,
      language_ids: ["typescript"],
      file_extensions: [".ts"],
      request_timeout_ms: 2_000,
      diagnostics_wait_ms: diagnosticsWaitMs,
    }],
  });
}

const fixture = [
  "let buffer = Buffer.alloc(0);",
  "const send = (message) => { const body = Buffer.from(JSON.stringify(message)); process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n'); process.stdout.write(body); };",
  "process.stdin.on('data', (chunk) => {",
  "  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);",
  "  while (true) { const marker = buffer.indexOf('\\r\\n\\r\\n'); if (marker < 0) return; const header = buffer.subarray(0, marker).toString(); const length = Number(header.match(/Content-Length: (\\d+)/i)[1]); if (buffer.length < marker + 4 + length) return; const request = JSON.parse(buffer.subarray(marker + 4, marker + 4 + length).toString()); buffer = buffer.subarray(marker + 4 + length);",
  "    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { capabilities: { textDocumentSync: 1 }, serverInfo: { name: 'fixture', version: '1' } } });",
  "    else if (request.method === 'textDocument/didOpen') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: request.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, code: 2322, source: 'fixture-ts', message: 'Type string is not assignable to number' }] } });",
  "    else if (request.method === 'textDocument/definition') send({ jsonrpc: '2.0', id: request.id, result: [{ uri: request.params.textDocument.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }] });",
  "    else if (request.method === 'textDocument/references') send({ jsonrpc: '2.0', id: request.id, result: [{ uri: request.params.textDocument.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }] });",
    "    else if (request.method === 'shutdown') send({ jsonrpc: '2.0', id: request.id, result: null });",
    "    else if (request.method === 'exit') process.exit(0);",
  "  }",
  "});",
].join("\n");

describe("G12 LspManager", () => {
  it("returns unavailable and emits a canonical fact when no server can start", async () => {
    const manager = new LspManager({
      config: config("__tracegraph_missing_lsp_command__", []),
    });
    const result = await manager.diagnostics({
      projectId: "project:lsp-missing",
      workspaceRoot: "/tmp",
      request: { paths: ["index.ts"], max_items: 10, severity: "all" },
    });
    expect(result).toMatchObject({ status: "unavailable" });
    expect(manager.history().map((event) => event.type)).toContain("lsp.server_unavailable");
  });

  it("speaks real Content-Length JSON-RPC and returns bounded semantic diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-g12-lsp-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src/index.ts"), "const value: number = 'bad';\n", "utf8");
      const manager = new LspManager({
        config: config(process.execPath, ["-e", fixture]),
      });
      const result = await manager.diagnostics({
        projectId: "project:lsp-fixture",
        workspaceRoot: root,
        request: { paths: ["src/index.ts"], max_items: 10, severity: "all" },
      });
      expect(result).toMatchObject({
        status: "available",
        summary: { server_name: "fixture", diagnostic_count: 1, error_count: 1 },
        diagnostics: [expect.objectContaining({ path: "src/index.ts", severity: "error", code: 2322 })],
      });
      await expect(manager.definition({
        projectId: "project:lsp-fixture",
        workspaceRoot: root,
        path: "src/index.ts",
        line: 0,
        character: 6,
      })).resolves.toEqual([{ path: "src/index.ts", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }]);
      await expect(manager.references({
        projectId: "project:lsp-fixture",
        workspaceRoot: root,
        path: "src/index.ts",
        line: 0,
        character: 6,
      })).resolves.toEqual([{ path: "src/index.ts", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }]);
      expect(manager.history().map((event) => event.type)).toContain("lsp.diagnostics_received");
      await manager.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
