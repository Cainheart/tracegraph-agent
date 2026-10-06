import { join } from "node:path";
import { ModelCapabilityTestRequestSchema, ModelCapabilityTestResultSchema, ModelCapabilityTestReceiptSchema, type ModelCapabilityTestRequest, type ModelCapabilityTestResult, type ModelCapabilityTestReceipt } from "@tracegraph/contracts";
import type { ConfigurableModelAdapter, ModelAdapter } from "@tracegraph/core";
import { WorkbenchJournal } from "./workbench-journal.js";

export interface CapturedModelProbe { adapter: ConfigurableModelAdapter & ModelAdapter; provider: string; protocol: "openai-chat-completions" | "anthropic-messages"; revision: number }
interface Context { profileRoot: string; capture: (id: string, model: string, revision: number) => CapturedModelProbe; record?: (result:ModelCapabilityTestResult)=>Promise<void> }
/** Dedicated journal: probe receipts cannot be mistaken for task/tool success. */
export class ModelCapabilityControl {
  readonly #ctx: Context; readonly #journal: WorkbenchJournal; readonly #abort = new AbortController(); #pending = 0;
  private constructor(ctx: Context) { this.#ctx = ctx; this.#journal = new WorkbenchJournal(join(ctx.profileRoot, "model-capability-events")); }
  static async open(ctx: Context) { const control = new ModelCapabilityControl(ctx); await control.#journal.initialize(); return control; }
  get pending() { return this.#pending; }
  close() { this.#abort.abort(); }
  async test(connectionId: string, inputValue: ModelCapabilityTestRequest): Promise<ModelCapabilityTestResult> {
    const input = ModelCapabilityTestRequestSchema.parse(inputValue);
    this.#pending++;
    try{const result=await this.#journal.once(input.command_id, "models.capabilities.test", { connection_id: connectionId, ...input }, async () => {
      const captured = this.#ctx.capture(connectionId, input.model, input.expected_revision), started = Date.now();
      try {
        const results = [];
        for (const feature of input.features) {
          if (this.#abort.signal.aborted) { results.push({ feature, status: "unknown" as const, code: "model_probe_not_started", dispatched: false, duration_ms: 0, usage_status: "unknown" as const }); continue; }
          try { results.push(await captured.adapter.testCapability(feature, { signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]) })); }
          catch (error) { const code = String((error as { code?: unknown })?.code); results.push({ feature, status: "failed" as const, code: ["model_credential_missing","model_credential_unavailable","model_credential_invalid"].includes(code) ? code : "model_not_configured", dispatched: false, duration_ms: 0, usage_status: "unknown" as const }); }
        }
        return ModelCapabilityTestResultSchema.parse({ command_id: input.command_id, connection_id: connectionId, connection_revision: captured.revision, model: input.model, provider: captured.provider, protocol: captured.protocol, checked_at: new Date().toISOString(), duration_ms: Date.now() - started, results });
      } finally { captured.adapter.releaseRun?.(); }
    });try{await this.#ctx.record?.(result);}catch{throw Object.assign(new Error("The test receipt was recorded, but its settings summary could not be saved. Inspect the original command."),{code:"model_probe_projection_failed",statusCode:503});}return result;}finally{this.#pending--;}
  }
  async receipt(commandId: string): Promise<ModelCapabilityTestReceipt> {
    const receipt = await this.#journal.inspect(commandId);
    if (receipt.operation && receipt.operation !== "models.capabilities.test") return { command_id: commandId, state: "not_found" };
    return ModelCapabilityTestReceiptSchema.parse({ command_id: commandId, state: receipt.state, ...(receipt.code ? { code: receipt.code } : {}), ...(receipt.state === "completed" ? { result: ModelCapabilityTestResultSchema.parse(receipt.result) } : {}) });
  }
}
