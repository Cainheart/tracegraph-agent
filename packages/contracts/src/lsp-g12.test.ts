import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  LspConfigSchema,
  LspDiagnosticsReceivedDataSchema,
  LspDiagnosticsSummarySchema,
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
    expect(EventTypeSchema.options.slice(-2)).toEqual([
      "lsp.diagnostics_received",
      "lsp.server_unavailable",
    ]);
  });
});
