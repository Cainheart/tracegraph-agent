import {
  EXTENSION_API_VERSION,
  LspDiagnosticsRequestSchema,
  RawToolResultSchema,
  type LspDiagnosticsResult,
  type RawToolResult,
} from "@tracegraph/contracts";
import type { ToolExtension } from "../../kernel/registration.js";
import type { LspToolBridge, ToolDefinition } from "../../kernel/tool/definition.js";
import type { LspRuntimePort } from "./ports.js";

export const LSP_EXTENSION_NAME = "@tracegraph/lsp-stdio" as const;
export const LSP_EXTENSION_API_VERSION = EXTENSION_API_VERSION;

export function createLspToolsExtension(manager: LspRuntimePort): ToolExtension {
  return {
    name: LSP_EXTENSION_NAME,
    api_version: LSP_EXTENSION_API_VERSION,
    activate(context) { context.registerTool(lspToolDefinition(manager)); },
    async deactivate() { await manager.stop(); },
  };
}

function lspToolDefinition(manager: LspRuntimePort): ToolDefinition {
  return {
    name: "get_diagnostics",
    description: "Read bounded semantic diagnostics from the configured Language Server for selected workspace files.",
    inputSchema: LspDiagnosticsRequestSchema,
    outputSchema: RawToolResultSchema,
    capability: "read",
    requiresApproval: false,
    timeoutMs: 30_000,
    concurrencySafe: true,
    sideEffect: "read",
    maxResultBytes: 128 * 1024,
    presentation: { callLabel: "Get LSP diagnostics", resultLabel: "LSP diagnostics" },
    async execute(input, context) {
      if (context.lsp !== undefined) return context.lsp.getDiagnostics(input, context.signal);
      const result = await manager.diagnostics({
        projectId: context.projectId,
        workspaceRoot: context.workspace.real_root,
        request: LspDiagnosticsRequestSchema.parse(input),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return lspResultToRaw(result);
    },
    render(_input, output) { return output; },
  };
}

export function lspResultToRaw(result: LspDiagnosticsResult): RawToolResult {
  if (result.status === "unavailable") {
    return { status: "unknown", code: "lsp_unavailable", summary: result.message ?? "LSP server is unavailable", facts: { status: result.status } };
  }
  return {
    status: "success",
    code: "lsp_diagnostics_received",
    summary: result.summary === undefined
      ? "LSP diagnostics received"
      : `${result.summary.diagnostic_count} semantic diagnostic(s) received`,
    content: JSON.stringify(result.diagnostics, null, 2),
    mimeType: "application/json",
    facts: { summary: result.summary, diagnostics: result.diagnostics },
  };
}
