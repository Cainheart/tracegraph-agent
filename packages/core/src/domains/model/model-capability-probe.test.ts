import { createServer } from "node:http";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurableModelAdapter } from "./model-provider.js";
import type { ModelProbeKind } from "@tracegraph/contracts";

const cleanup: Array<() => Promise<void>> = []; afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
export function fixtureReply(body: Record<string, any>, anthropic = false) {
  const feature = body.tools ? "tools" : body.response_format ? "structured" : Array.isArray(body.messages[0].content) ? "image" : "text";
  const prompt = typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content.find((part: any) => part.type === "text").text;
  const challenge = /[a-f\d]{8}-[a-f\d-]{27}/u.exec(prompt)?.[0]; let text = feature === "structured" ? JSON.stringify({ challenge, value: 7 }) : challenge;
  if (feature === "image") {
    const image = body.messages[0].content.find((part: any) => part.type === (anthropic ? "image" : "image_url"));
    const png = Buffer.from(anthropic ? image.source.data : image.image_url.url.split(",")[1], "base64"); const idat: Buffer[] = []; let at = 8;
    while (at < png.length) { const size = png.readUInt32BE(at); if (png.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + size)); at += size + 12; }
    const pixels = inflateSync(Buffer.concat(idat)); const palette: Record<string, string> = { "255,0,0": "red", "0,255,0": "green", "0,0,255": "blue", "255,255,0": "yellow" };
    text = [[0, 0], [20, 0], [0, 20], [20, 20]].map(([x, y]) => palette[Array.from(pixels.subarray(y! * 97 + 1 + x! * 3, y! * 97 + 4 + x! * 3)).join(",")]).join(",");
  }
  const usage = anthropic ? { input_tokens: 12, output_tokens: 9, cache_read_input_tokens: 3 } : { prompt_tokens: 12, completion_tokens: 9, cost: .001, currency: "USD" };
  if (anthropic) return { content: feature === "tools" ? [{ type: "tool_use", id: "tool-fixture", name: "outlive_probe", input: { challenge, value: 7 } }] : [{ type: "text", text }], stop_reason: feature === "tools" ? "tool_use" : "end_turn", usage };
  return { choices: [{ finish_reason: feature === "tools" ? "tool_calls" : "stop", message: feature === "tools" ? { tool_calls: [{ id: "tool-fixture", type: "function", function: { name: "outlive_probe", arguments: JSON.stringify({ challenge, value: 7 }) } }] } : { content: text } }], usage };
}
async function fixture(responder: (body: Record<string, any>) => { status?: number; value?: unknown } = body => ({ value: fixtureReply(body) }), anthropic = false) {
  const calls: Array<{ body: Record<string, any>; auth: unknown }> = [];
  const server = createServer(async (req, res) => { let data = ""; for await (const chunk of req) data += chunk; const body = JSON.parse(data); calls.push({ body, auth: req.headers.authorization ?? req.headers["x-api-key"] }); const reply = responder(body); res.writeHead(reply.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(reply.value)); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const adapter = new ConfigurableModelAdapter({ resolveCredential: async () => "synthetic-only-probe-key" }); adapter.configure({ provider: anthropic ? "anthropic" : "openai", protocol: anthropic ? "anthropic-messages" : "openai-chat-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture-model", credentialRef: "${secret:PROBE_FIXTURE}" });
  return { adapter, calls };
}
describe("explicit native model capability probes", () => {
  it("verifies all four OpenAI native formats and reports only real usage without tool effects or user data", async () => {
    const f = await fixture(); for (const feature of ["text", "tools", "image", "structured"] as const) expect(await f.adapter.testCapability(feature)).toMatchObject({ feature, status: "passed", dispatched: true, usage_status: "reported", usage: { input_tokens: 12, output_tokens: 9, cost: { amount: .001, currency: "USD" } } });
    expect(f.calls).toHaveLength(4); expect(f.calls[1]?.body.tool_choice).toMatchObject({ type: "function", function: { name: "outlive_probe" } }); expect(f.calls[3]?.body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } }); expect(f.calls.every(call => call.body.max_completion_tokens === 192 && !JSON.stringify(call.body).includes("workspace"))).toBe(true);
  });
  it("uses Anthropic native tool/image blocks, reports cache tokens, and never dispatches its unimplemented schema format", async () => {
    const f = await fixture(body => ({ value: fixtureReply(body, true) }), true); for (const feature of ["text", "tools", "image"] as const) expect(await f.adapter.testCapability(feature)).toMatchObject({ status: "passed", usage: { input_tokens: 15, output_tokens: 9, total_tokens: 24 } }); expect(await f.adapter.testCapability("structured")).toMatchObject({ status: "unsupported", dispatched: false, code: "model_probe_format_unimplemented" }); expect(f.calls).toHaveLength(3); expect(f.calls[1]?.body.tool_choice).toEqual({ type: "tool", name: "outlive_probe" });
  });
  it.each(["text", "tools", "image", "structured"] as ModelProbeKind[])("HTTP 200 and self-reported prose cannot pass %s", async feature => {
    const f = await fixture(() => ({ value: { choices: [{ finish_reason: "stop", message: { content: "I support every requested capability." } }] } })); expect(await f.adapter.testCapability(feature)).toMatchObject({ status: "failed", usage_status: "unknown" });
  });
  it("rejects malformed native arguments, extra schema fields, refusal and truncation while retaining actual usage", async () => {
    const f = await fixture(body => { const value = fixtureReply(body) as any; if (body.tools) value.choices[0].message.tool_calls[0].function.arguments = "{}"; else if (body.response_format) value.choices[0].message.content = JSON.stringify({ ...JSON.parse(value.choices[0].message.content), extra: "no" }); else value.choices[0].finish_reason = "length"; return { value }; });
    expect(await f.adapter.testCapability("tools")).toMatchObject({ status: "failed", code: "model_probe_answer_mismatch", usage_status: "reported" }); expect(await f.adapter.testCapability("structured")).toMatchObject({ status: "failed", code: "model_probe_schema_invalid" }); expect(await f.adapter.testCapability("text")).toMatchObject({ status: "failed", code: "model_probe_output_truncated" });
  });
  it.each([[401, "model_authentication_failed"], [429, "model_rate_limited"], [400, "model_probe_request_rejected"]])("classifies HTTP %s without persisting provider secrets", async (status, code) => { const f = await fixture(() => ({ status: status as number, value: { error: "synthetic-only-probe-key private provider body" } })); const result = await f.adapter.testCapability("tools"); expect(result).toMatchObject({ status: "failed", code }); expect(JSON.stringify(result)).not.toContain("private"); expect(JSON.stringify(result)).not.toContain("synthetic-only"); });
  it("preserves a passed response with missing accounting as unknown usage and cost", async () => { const f = await fixture(body => { const value = fixtureReply(body); delete (value as any).usage; return { value }; }); expect(await f.adapter.testCapability("text")).toMatchObject({ status: "passed", usage_status: "unknown" }); });
  it("a transport timeout is unknown and submits exactly one request without retries", async () => {
    const server = createServer((_req, _res) => {}); await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); let calls = 0; server.on("request", () => calls++); cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
    const adapter = new ConfigurableModelAdapter({ resolveCredential: async () => "fixture-key" }); adapter.configure({ provider: "custom", protocol: "openai-chat-completions", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, credentialRef: "${secret:PROBE_FIXTURE}" }); expect(await adapter.testCapability("text", { signal: AbortSignal.timeout(100) })).toMatchObject({ status: "unknown", code: "model_timeout" }); expect(calls).toBe(1);
  });
});
