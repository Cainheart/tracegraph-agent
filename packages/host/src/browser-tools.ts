import { z } from "zod";
import { EXTENSION_API_VERSION, IdentifierSchema, RawToolResultSchema, BrowserCommandSchema } from "@tracegraph/contracts";
import type { TraceGraphExtension, AgentRuntime } from "@tracegraph/core";
import type { BrowserControl } from "./browser-control.js";

/** Trusted adapter binds scope/mode/operation identity; no grant or JS tool is exposed. */
export function browserTools(control: BrowserControl, runtime: () => AgentRuntime): TraceGraphExtension {
  const options = BrowserCommandSchema.options;
  const action = z.discriminatedUnion("type", [options[1].omit({ command_id: true }), options[2].omit({ command_id: true }), options[3].omit({ command_id: true }), options[4].omit({ command_id: true }), options[5].omit({ command_id: true })]);
  const registered: Array<{ dispose(): void | Promise<void> }> = [];
  return {
    name: "@tracegraph/browser-tools", api_version: EXTENSION_API_VERSION,
    activate(context) {
      registered.push(context.registerTool({
        name: "browser_observe", description: "Observe a user-authorized browser tab for this project; returns revision-scoped DOM references and a real screenshot Artifact. Ask the user to open and authorize a tab first.",
        inputSchema: z.object({ tab_id: IdentifierSchema }).strict(), outputSchema: RawToolResultSchema,
        capability: "read", sideEffect: "read", requiresApproval: false, concurrencySafe: false, timeoutMs: 15_000, maxResultBytes: 160 * 1024,
        presentation: { callLabel: "Observe authorized browser", resultLabel: "Browser observation" },
        async execute(input, ctx) {
          const observation = await control.observe((input as { tab_id: string }).tab_id, ctx.projectId);
          if (!ctx.publishArtifactBytes) throw new Error("Runtime Artifact publication is required for browser evidence");
          const artifact = await ctx.publishArtifactBytes({ mimeType: "image/png", bytes: await control.evidence(observation.evidence.evidence_id, ctx.projectId) });
          await control.registerRunEvidenceCopy(observation.evidence.evidence_id,artifact);
          return { status: "success", code: "browser_observed", summary: "Observed the authorized page", content: JSON.stringify({ ...observation, artifact }), facts: { tab_id: observation.tab.tab_id, revision: observation.tab.revision, artifact } };
        }, render(_input, output) { return output; },
      }));
      registered.push(context.registerTool({
        name: "browser_action", description: "Act on a user-authorized browser tab using the latest observation revision and exact DOM reference. Supports navigation, click, fill, keys and close. Never grants authority or returns human control.",
        inputSchema: action,
        // Model-facing schemas use the bounded object vocabulary. The executor
        // still validates the stricter discriminated operation union above.
        modelInputSchema: { type: "object", properties: {
          type: { type: "string", enum: ["navigate", "click", "fill", "key", "close"] },
          tab_id: { type: "string", minLength: 1, maxLength: 160 },
          expected_revision: { type: "integer", minimum: 0 },
          url: { type: "string", maxLength: 4_096 }, ref: { type: "string", maxLength: 160 },
          text: { type: "string", maxLength: 32_768 },
          key: { type: "string", enum: ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] },
        }, required: ["type", "tab_id"], additionalProperties: false },
        outputSchema: RawToolResultSchema, capability: "read", sideEffect: "write", requiresApproval: false, concurrencySafe: false, timeoutMs: 25_000, maxResultBytes: 32 * 1024,
        presentation: { callLabel: "Operate authorized browser", resultLabel: "Browser action result" },
        async execute(input, ctx) {
          const projection = await runtime().getProjection(ctx.runId);
          if (!ctx.operationId) throw new Error("Runtime operation identity is required");
          try {
            const result = await control.command(BrowserCommandSchema.parse({ ...(input as object), command_id: ctx.operationId }), { projectId: ctx.projectId, mode: projection.mode, ...(ctx.signal ? { signal: ctx.signal } : {}) });
            return { status: "success", code: "browser_action_completed", summary: "Browser confirmed the action", content: JSON.stringify(result), facts: result };
          } catch (error) {
            const code = String((error as { code?: string }).code ?? "browser_action_failed");
            return { status: code === "browser_effect_unknown" ? "unknown" : "failure", code, summary: error instanceof Error ? error.message : "Browser action failed" };
          }
        }, render(_input, output) { return output; },
      }));
    },
    async deactivate() { for (const registration of registered) await registration.dispose(); registered.length = 0; },
  };
}
