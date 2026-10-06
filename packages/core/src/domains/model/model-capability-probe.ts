import { randomInt, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ModelProbeResultSchema, ModelProbeUsageSchema, type ModelProbeKind, type ModelProbeResult } from "@tracegraph/contracts";
import type { ModelProvider } from "./model-provider.js";

interface Config { provider: ModelProvider; protocol: "openai-chat-completions" | "anthropic-messages"; baseUrl: string; model: string; apiKey: string }
type Transport = (config: Config, url: string, init: RequestInit) => Promise<Response>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** A probe never invokes a tool or imports any user/workspace context. */
export async function probeModelCapability(config: Config, feature: ModelProbeKind, transport: Transport, signal: AbortSignal): Promise<ModelProbeResult> {
  const started = Date.now(); let dispatched = false;
  const result = (status: ModelProbeResult["status"], code: string, extra: Partial<ModelProbeResult> = {}) => ModelProbeResultSchema.parse({ feature, status, code, duration_ms: Date.now() - started, dispatched, usage_status: "unknown", ...extra });
  const anthropic = config.protocol === "anthropic-messages";
  if (anthropic && feature === "structured") return result("unsupported", "model_probe_format_unimplemented");
  const challenge = randomUUID(), fixture = imageFixture();
  const schema = { type: "object", properties: { challenge: { type: "string", enum: [challenge] }, value: { type: "integer", enum: [7] } }, required: ["challenge", "value"], additionalProperties: false };
  const prompt = feature === "text" ? `Reply with exactly this text and nothing else: ${challenge}` : feature === "tools" ? `Call outlive_probe once with challenge ${challenge} and value 7. Do not write a text answer.` : feature === "image" ? "Read the image. Reply only with four lowercase color names separated by commas for top-left, top-right, bottom-left, bottom-right. Allowed names: red, green, blue, yellow. No other text." : `Return the schema-constrained object with challenge ${challenge} and value 7.`;
  const content = feature === "image" ? anthropic ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: fixture.base64 } }, { type: "text", text: prompt }] : [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${fixture.base64}`, detail: "low" } }] : prompt;
  const body = { model: config.model, ...(anthropic ? { max_tokens: 192 } : config.provider === "openai" ? { max_completion_tokens: 192 } : { max_tokens: 192 }), messages: [{ role: "user", content }], ...(feature === "tools" ? anthropic ? { tools: [{ name: "outlive_probe", description: "A harmless test declaration. Never executed.", input_schema: schema }], tool_choice: { type: "tool", name: "outlive_probe" } } : { tools: [{ type: "function", function: { name: "outlive_probe", description: "A harmless test declaration. Never executed.", parameters: schema } }], tool_choice: { type: "function", function: { name: "outlive_probe" } }, parallel_tool_calls: false } : feature === "structured" ? { response_format: { type: "json_schema", json_schema: { name: "outlive_probe", strict: true, schema } } } : {}) };
  try {
    dispatched = true;
    const response = await transport(config, `${config.baseUrl}/${anthropic ? "messages" : "chat/completions"}`, { method: "POST", headers: anthropic ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } : { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.ok) { await response.body?.cancel(); return result("failed", response.status === 401 || response.status === 403 ? "model_authentication_failed" : response.status === 404 ? "model_not_found" : response.status === 429 ? "model_rate_limited" : response.status === 400 || response.status === 422 ? "model_probe_request_rejected" : "model_provider_failed"); }
    const reader = response.body?.getReader(); if (!reader) return result("failed", "model_response_invalid");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 65_536) { await reader.cancel(); return result("failed", "model_probe_response_too_large"); } chunks.push(next.value); } } finally { reader.releaseLock(); }
    let payload: unknown; try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { return result("failed", "model_response_invalid"); }
    if (!object(payload)) return result("failed", "model_response_invalid");
    const usage = normalizeProbeUsage(payload.usage, anthropic);
    const accounting = usage ? { usage_status: "reported" as const, usage } : {};
    const choice = Array.isArray(payload.choices) && payload.choices.length === 1 && object(payload.choices[0]) ? payload.choices[0] : undefined;
    const message = choice && object(choice.message) ? choice.message : undefined;
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    const stop = anthropic ? payload.stop_reason : choice?.finish_reason;
    if (stop === "length" || stop === "max_tokens") return result("failed", "model_probe_output_truncated", accounting);
    if (stop === "refusal" || stop === "content_filter" || (message && typeof message.refusal === "string" && message.refusal.length > 0)) return result("failed", "model_probe_refused", accounting);
    if (feature === "tools") {
      const calls = anthropic ? blocks.filter(block => object(block) && block.type === "tool_use") : message?.tool_calls;
      if (!Array.isArray(calls) || calls.length !== 1 || !object(calls[0]) || stop !== (anthropic ? "tool_use" : "tool_calls")) return result("failed", "model_probe_native_tool_missing", accounting);
      const call = calls[0]; let input: unknown;
      if (anthropic) { if (call.name !== "outlive_probe" || typeof call.id !== "string" || !call.id) return result("failed", "model_probe_native_tool_invalid", accounting); input = call.input; }
      else { if (call.type !== "function" || typeof call.id !== "string" || !call.id || !object(call.function) || call.function.name !== "outlive_probe" || typeof call.function.arguments !== "string") return result("failed", "model_probe_native_tool_invalid", accounting); try { input = JSON.parse(call.function.arguments) as unknown; } catch { return result("failed", "model_probe_native_tool_invalid", accounting); } }
      return matches(input, challenge) ? result("passed", "model_probe_passed", { ...accounting, evidence: "native_tool_call" }) : result("failed", "model_probe_answer_mismatch", accounting);
    }
    if (stop !== (anthropic ? "end_turn" : "stop")) return result("failed", "model_response_invalid", accounting);
    const text = anthropic ? blocks.filter(block => object(block) && block.type === "text" && typeof block.text === "string").map(block => (block as { text: string }).text).join("") : message?.content;
    if (typeof text !== "string") return result("failed", "model_response_invalid", accounting);
    if (feature === "structured") { let parsed: unknown; try { parsed = JSON.parse(text) as unknown; } catch { return result("failed", "model_probe_schema_invalid", accounting); } return matches(parsed, challenge) ? result("passed", "model_probe_passed", { ...accounting, evidence: "native_json_schema" }) : result("failed", "model_probe_schema_invalid", accounting); }
    const correct = feature === "image" ? text.trim().toLowerCase().replace(/\s/gu, "") === fixture.colors.join(",") : text.trim() === challenge;
    return correct ? result("passed", "model_probe_passed", { ...accounting, evidence: feature === "image" ? "image_fixture_answer" : "exact_text" }) : result("failed", "model_probe_answer_mismatch", accounting);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return result(dispatched ? "unknown" : "failed", signal.aborted || code === "model_timeout" || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) ? "model_timeout" : code === "model_credential_missing" ? "model_credential_missing" : "model_transport_unknown");
  }
}

function matches(input: unknown, challenge: string) { return object(input) && Object.keys(input).length === 2 && input.challenge === challenge && input.value === 7; }
function normalizeProbeUsage(value: unknown, anthropic: boolean) {
  if (!object(value)) return undefined;
  const input = count(anthropic ? value.input_tokens : value.prompt_tokens ?? value.input_tokens), output = count(anthropic ? value.output_tokens : value.completion_tokens ?? value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const creation = anthropic ? count(value.cache_creation_input_tokens) ?? 0 : 0;
  const details = object(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const cached = count(anthropic ? value.cache_read_input_tokens : details?.cached_tokens ?? value.cached_input_tokens);
  const totalInput = input + creation + (anthropic ? cached ?? 0 : 0);
  const cost = typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 && typeof value.currency === "string" && /^[A-Z]{3}$/u.test(value.currency.toUpperCase()) ? { amount: value.cost, currency: value.currency.toUpperCase() } : undefined;
  const parsed = ModelProbeUsageSchema.safeParse({ input_tokens: totalInput, output_tokens: output, total_tokens: totalInput + output, ...(cached === undefined ? {} : { cached_input_tokens: cached }), ...(cost ? { cost } : {}) });
  return parsed.success ? parsed.data : undefined;
}

/** Generated four-quadrant PNG; colors are not present in the prompt or filename. */
export function imageFixture() {
  const colors = ["red", "green", "blue", "yellow"]; for (let i = 3; i > 0; i--) { const j = randomInt(i + 1); [colors[i], colors[j]] = [colors[j]!, colors[i]!]; }
  const palette: Record<string, number[]> = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0] };
  const rows: number[] = []; for (let y = 0; y < 32; y++) { rows.push(0); for (let x = 0; x < 32; x++) rows.push(...palette[colors[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)]!]!); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.from(rows))), pngChunk("IEND", Buffer.alloc(0))]);
  return { colors, base64: bytes.toString("base64") };
}
function pngChunk(type: string, data: Buffer) { const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); let crc = 0xffffffff; for (const byte of Buffer.concat([name, data])) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, name, data, sum]); }
