import { describe, expect, it, vi } from "vitest";
import { WorkspaceHandleSchema } from "@tracegraph/contracts";
import { ExtensionManager } from "../../domains/extensions/index.js";
import { createCoreToolRegistry } from "../../domains/tools/index.js";
import { createLspToolsExtension } from "./tool-extension.js";
import type { LspRuntimePort } from "./ports.js";

describe("Core LSP Tool adapter", () => {
  it("routes diagnostics through the Run bridge and stops the provider on deactivation", async () => {
    const stop = vi.fn(async () => undefined);
    const manager: LspRuntimePort = {
      onEvent: () => ({ dispose() {} }),
      stop,
      async diagnostics() {
        throw new Error("the Run-scoped bridge must own diagnostic event attribution");
      },
    };
    const toolRegistry = createCoreToolRegistry();
    const extensions = new ExtensionManager({ toolRegistry });
    await extensions.activate(createLspToolsExtension(manager));
    const definition = toolRegistry.get("get_diagnostics");
    expect(definition).toBeDefined();

    const bridge = vi.fn(async () => ({ status: "unknown" as const, code: "lsp_unavailable", summary: "not configured" }));
    const workspace = WorkspaceHandleSchema.parse({
      handle_id: "workspace:lsp-adapter",
      project_id: "project:lsp-adapter",
      real_root: process.cwd(),
      workspace_kind: "readonly_local",
      capabilities: { index: true, read: true, search: true, run_command: false, preview_patch: false, commit_patch: false, test: false },
      created_at: new Date().toISOString(),
    });
    const result = await definition!.execute(
      { paths: ["src/index.ts"], max_items: 10, severity: "all" },
      { projectId: workspace.project_id, runId: "run:lsp-adapter", workspace, lsp: { getDiagnostics: bridge } },
    );
    expect(result).toMatchObject({ status: "unknown", code: "lsp_unavailable" });
    expect(bridge).toHaveBeenCalledOnce();

    await extensions.deactivate(createLspToolsExtension(manager).name);
    expect(stop).toHaveBeenCalledOnce();
  });
});
