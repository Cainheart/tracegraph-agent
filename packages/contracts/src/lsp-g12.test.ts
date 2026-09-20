import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  LspConfigSchema,
  LspDiagnosticsReceivedDataSchema,
  LspDiagnosticsResultSchema,
  LspDiagnosticsSummarySchema,
  LspServerStatusSchema,
} from "./index.js";

describe("G12 LSP contracts", () => {
  it("keeps server configuration bounded and maps extensions uniquely", () => {
    expect(LspConfigSchema.parse({
      config_version: "tracegraph.lsp.v1",
      servers: [{
        name: "typescript",
        command: "typescript-language-server",
        args: ["--stdio"],
        language_ids: ["typescript"],
        file_extensions: [".ts"],
      }],
    }).servers[0]?.name).toBe("typescript");
    expect(() => LspConfigSchema.parse({
      config_version: "tracegraph.lsp.v1",
      servers: [
        { name: "one", command: "one", language_ids: ["x"], file_extensions: [".ts"] },
        { name: "two", command: "two", language_ids: ["x"], file_extensions: [".ts"] },
      ],
    })).toThrow();
  });

  it("bounds diagnostics summaries and appends the two canonical LSP events", () => {
    const diagnostic = {
      path: "src/index.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: "error" as const,
      message: "Type mismatch",
    };
    const summary = LspDiagnosticsSummarySchema.parse({
      server_name: "typescript",
      files_scanned: 1,
      diagnostic_count: 1,
      error_count: 1,
      warning_count: 0,
      information_count: 0,
      hint_count: 0,
      truncated: false,
      sample: [diagnostic],
      diagnostics_hash: `sha256:${"a".repeat(64)}`,
    });
    expect(LspDiagnosticsReceivedDataSchema.parse({ project_id: "project:test", ...summary })).toMatchObject({
      project_id: "project:test",
      diagnostic_count: 1,
    });
    expect(EventTypeSchema.options.slice(-4, -2)).toEqual([
      "lsp.diagnostics_received",
      "lsp.server_unavailable",
    ]);
  });

  it("rejects ambiguous ownership and half-declared LSP failures", () => {
    const server = (overrides: Record<string, unknown>) => ({
      name: "typescript",
      command: "typescript-language-server",
      language_ids: ["typescript"],
      file_extensions: [".ts"],
      ...overrides,
    });
    expect(() => LspConfigSchema.parse({
      config_version: "tracegraph.lsp.v1",
      servers: [server({}), server({})],
    })).toThrow(/LSP server names must be unique/u);
    expect(() => LspConfigSchema.parse({
      config_version: "tracegraph.lsp.v1",
      servers: [server({ language_ids: ["typescript", "typescript"] })],
    })).toThrow(/language_ids must be unique/u);
    expect(() => LspConfigSchema.parse({
      config_version: "tracegraph.lsp.v1",
      servers: [server({ file_extensions: [".ts", ".ts"] })],
    })).toThrow(/file_extensions must be unique/u);
  });

  it("pairs LSP degradation state with its error and nothing else", () => {
    const status = (overrides: Record<string, unknown>) => ({
      name: "typescript",
      state: "ready",
      language_ids: ["typescript"],
      file_extensions: [".ts"],
      diagnostics_count: 0,
      updated_at: "2026-09-19T12:00:00.000Z",
      ...overrides,
    });
    expect(LspServerStatusSchema.parse(status({})).state).toBe("ready");
    expect(() => LspServerStatusSchema.parse(status({ state: "degraded" })))
      .toThrow(/degraded\/unavailable status requires an error/u);
    expect(() => LspServerStatusSchema.parse(status({ error_code: "lsp_timeout" })))
      .toThrow(/degraded\/unavailable status requires an error/u);
    expect(() => LspServerStatusSchema.parse(status({ state: "unavailable", error_code: "lsp_timeout" })))
      .toThrow(/error fields must appear together/u);
  });

  it("keeps diagnostic summaries and results internally consistent", () => {
    const diagnostic = (message: string) => ({
      path: "src/index.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: "error" as const,
      message,
    });
    const summary = {
      server_name: "typescript",
      files_scanned: 1,
      diagnostic_count: 1,
      error_count: 1,
      warning_count: 0,
      information_count: 0,
      hint_count: 0,
      truncated: false,
      sample: [],
      diagnostics_hash: `sha256:${"a".repeat(64)}`,
    };
    expect(() => LspDiagnosticsSummarySchema.parse({ ...summary, diagnostic_count: 0 }))
      .toThrow(/diagnostic_count must cover all severities/u);
    expect(() => LspDiagnosticsSummarySchema.parse({
      ...summary,
      sample: [diagnostic("first"), diagnostic("second")],
    })).toThrow(/sample cannot exceed diagnostic_count/u);
    expect(() => LspDiagnosticsResultSchema.parse({ status: "available", diagnostics: [] }))
      .toThrow(/available diagnostics require a summary/u);
    expect(() => LspDiagnosticsResultSchema.parse({ status: "unavailable", diagnostics: [] }))
      .toThrow(/unavailable diagnostics require a message/u);
  });
});
