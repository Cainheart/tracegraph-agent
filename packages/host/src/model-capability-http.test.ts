import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PrivateFileCredentialStore } from "@tracegraph/core";
import { TraceGraphClient } from "@tracegraph/sdk";
import { createHostComposition } from "./composition/host-composition.js";
import { ModelCapabilityControl } from "./model-capability-control.js";
import { createWorkbenchControl } from "./workbench-control.js";
import { registerWorkbenchRoutes } from "./workbench-routes.js";

async function fixture(options: { environment?: boolean; hold?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "outlive-capability-http-")); const calls: Array<{ model: string; key: string; body: Record<string, any> }> = [];
  let release = () => {}; const held = new Promise<void>(done => { release = done; });
  const server = createServer(async (req, res) => { let text = ""; for await (const chunk of req) text += chunk; const body = JSON.parse(text); calls.push({ model: body.model, key: String(req.headers.authorization), body }); if (options.hold && calls.length === 1) await held; const prompt = body.messages[0].content, challenge = /[a-f\d]{8}-[a-f\d-]{27}/u.exec(prompt)?.[0]; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: body.tools ? "tool_calls" : "stop", message: body.tools ? { tool_calls: [{ id: "tool-fixture", type: "function", function: { name: "outlive_probe", arguments: JSON.stringify({ challenge, value: 7 }) } }] } : { content: body.response_format ? JSON.stringify({ challenge, value: 7 }) : challenge } }], usage: { prompt_tokens: 10, completion_tokens: 4 } })); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const env = options.environment ? { TRACEGRAPH_MODEL_PROVIDER: "custom", TRACEGRAPH_MODEL_PROTOCOL: "openai-chat-completions", TRACEGRAPH_MODEL_BASE_URL: url, TRACEGRAPH_MODEL: "fixture-env", TRACEGRAPH_MODEL_API_KEY: "synthetic-only-environment-key" } : {};
  const compositionOptions = { profileRoot: root, dataDir: join(root, "data"), sessionDir: join(root, "sessions"), permissionConfigPath: join(root, "permission.json"), credentialStore: new PrivateFileCredentialStore(join(root, "credentials.json")), environment: env, useEnvironmentModel: Boolean(options.environment), nativePicker: false, admission: "workspace" as const }; const composition = await createHostComposition(compositionOptions);
  const control=await createWorkbenchControl({...composition,profileRoot:root,profileId:"profile:probe-fixture",startRun:input=>composition.host.runSessions.startRun(input),readSession:id=>composition.host.runSessions.getSession(id)});registerWorkbenchRoutes(composition.host.app,control);
  const address = await composition.host.listen({ port: 0 }); const client = new TraceGraphClient({ baseUrl: address }); await client.bootstrap();
  if (!options.environment) await client.saveModelConnection({ command_id: "fixture-save", connection_id: "fixture-service", label: "Fixture service", provider: "custom", protocol: "openai-chat-completions", base_url: url, model: "fixture-a", models: ["fixture-a", "fixture-b"], api_key: "synthetic-only-old-key" });
  return { root, url, composition, compositionOptions, client, calls, release, async close() { release(); await control.close(); await composition.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); } };
}
const request = { command_id: "probe-http", expected_revision: 0, model: "fixture-b", features: ["text", "tools", "structured"] as const, confirmed: true as const };
describe("actual shared model-capability HTTP control", () => {
  it("uses the selected model, persists the exact safe receipt and never repeats a completed command after reconnect", async () => {
    const f = await fixture(); try {
      const input = { ...request, features: [...request.features] }; const result = await f.client.testModelCapabilities("fixture-service", input); expect(result.results.map(item => item.status)).toEqual(["passed", "passed", "passed"]); expect(f.calls.map(call => call.model)).toEqual(["fixture-b", "fixture-b", "fixture-b"]); expect(result.results.every(item => item.usage?.total_tokens === 14 && !item.usage.cost)).toBe(true);
      expect(await f.client.testModelCapabilities("fixture-service", input)).toEqual(result); expect(f.calls).toHaveLength(3);expect((await f.client.getModelConnections()).connections[0]?.capability_test).toEqual(result); await expect(f.client.testModelCapabilities("fixture-service", { ...input, features: ["tools"] })).rejects.toMatchObject({ status: 409 }); expect(f.calls).toHaveLength(3);
      const restartedControl = await ModelCapabilityControl.open({ profileRoot: f.root, capture: () => { throw new Error("Readback must never dispatch"); } }); expect(await restartedControl.receipt(input.command_id)).toEqual({ command_id: input.command_id, state: "completed", result }); restartedControl.close();
      expect(JSON.stringify(await f.client.getModelCapabilityTestReceipt(input.command_id))).not.toContain("synthetic-only"); expect(JSON.stringify(result)).not.toContain("fixture challenge"); const caps = await f.client.getCapabilities(); for (const operation of ["models.capabilities.test", "models.capabilities.read"]) expect(caps.capabilities.find(cap => cap.operation === operation)?.state).toBe("available");
    } finally { await f.close(); }
  });
  it("reopens the current-revision settings summary and invalidates it after credential replacement",async()=>{const f=await fixture();let reopened:Awaited<ReturnType<typeof createHostComposition>>|undefined;try{const result=await f.client.testModelCapabilities("fixture-service",{...request,features:["text"]});await f.composition.close();reopened=await createHostComposition(f.compositionOptions);expect(reopened.conversationControl.snapshot().connections[0]?.capability_test).toEqual(result);await reopened.conversationControl.save({command_id:"replace-reopened-key",connection_id:"fixture-service",expected_revision:0,label:"Reopened",provider:"custom",protocol:"openai-chat-completions",base_url:f.url,model:"fixture-a",models:["fixture-a","fixture-b"],api_key:"synthetic-only-reopened-key"});expect(reopened.conversationControl.snapshot().connections[0]?.capability_test).toBeUndefined();expect(await reopened.modelCapabilities!.receipt(request.command_id)).toMatchObject({state:"completed",result});expect(f.calls).toHaveLength(1);}finally{await reopened?.close();await f.close();}});
  it("rejects changed revisions and undeclared models before any provider request with a durable failed receipt", async () => {
    const f = await fixture(); try { await expect(f.client.testModelCapabilities("fixture-service", { ...request, features: ["text"], expected_revision: 10 })).rejects.toMatchObject({ status: 409 }); expect(f.calls).toHaveLength(0); expect(await f.client.getModelCapabilityTestReceipt(request.command_id)).toMatchObject({ state: "failed", code: "model_connection_revision_conflict" }); await expect(f.client.testModelCapabilities("fixture-service", { ...request, command_id: "probe-unconfigured", features: ["text"], model: "invented-model" })).rejects.toMatchObject({ status: 400 }); expect(f.calls).toHaveLength(0); } finally { await f.close(); }
  });
  it("read-only environment connections remain explicitly testable without storing their key", async () => {
    const f = await fixture({ environment: true }); try { const connection = (await f.client.getModelConnections()).connections[0]!; expect(connection).toMatchObject({ writable: false, source: "environment", has_key: true }); const result = await f.client.testModelCapabilities(connection.connection_id, { ...request, model: connection.model, expected_revision: connection.revision, features: ["text"] }); expect(result.results[0]?.status).toBe("passed");expect((await f.client.getModelConnections()).connections[0]?.capability_test).toEqual(result); expect(f.calls).toHaveLength(1); expect(await readFile(join(f.root, "model-connections.json"), "utf8").catch(() => "")).not.toContain("synthetic-only-environment-key"); } finally { await f.close(); }
  });
  it("does not reuse an environment summary after a credential change outside the registry", async () => {
    const f = await fixture({ environment: true });
    let reopened: Awaited<ReturnType<typeof createHostComposition>> | undefined;
    try {
      const connection = (await f.client.getModelConnections()).connections[0]!;
      const result = await f.client.testModelCapabilities(connection.connection_id, { ...request, model: connection.model, expected_revision: connection.revision, features: ["text"] });
      await f.composition.close();
      reopened = await createHostComposition({ ...f.compositionOptions, environment: { ...f.compositionOptions.environment, TRACEGRAPH_MODEL_API_KEY: "synthetic-only-replaced-environment-key" } });
      expect(reopened.conversationControl.snapshot().connections[0]?.capability_test).toBeUndefined();
      expect(await reopened.modelCapabilities!.receipt(request.command_id)).toMatchObject({ state: "completed", result });
      expect(f.calls).toHaveLength(1);
      await reopened.modelCapabilities!.test(connection.connection_id, { ...request, command_id: "probe-new-environment", model: connection.model, expected_revision: connection.revision, features: ["text"] });
      expect(f.calls[1]?.key).toBe("Bearer synthetic-only-replaced-environment-key");
    } finally { await reopened?.close(); await f.close(); }
  });
  it("a held probe keeps its exact leased model/key through rotation, exposes busy, and releases after its receipt", async () => {
    const f = await fixture({ hold: true }); try { const input={...request,features:["text","tools"] as Array<"text"|"tools">};const running = f.client.testModelCapabilities("fixture-service", input); for (let count = 0; !f.calls.length && count < 100; count++) await new Promise(done => setTimeout(done, 10)); expect(f.calls).toHaveLength(1); expect(f.composition.modelCapabilities?.pending).toBe(1);expect(await f.client.getModelCapabilityTestReceipt(input.command_id)).toMatchObject({state:"unknown"});const duplicate=f.client.testModelCapabilities("fixture-service",input);await f.client.saveModelConnection({ command_id: "fixture-rotate", connection_id: "fixture-service", expected_revision: 0, label: "New service", provider: "custom", protocol: "openai-chat-completions", base_url: f.url, model: "fixture-a", models: ["fixture-a", "fixture-b"], api_key: "synthetic-only-new-key" }); f.release(); const result = await running;expect(await duplicate).toEqual(result); expect(result.connection_revision).toBe(0); expect(f.calls.map(call => call.key)).toEqual(["Bearer synthetic-only-old-key", "Bearer synthetic-only-old-key"]); expect(f.composition.modelCapabilities?.pending).toBe(0); expect((await f.client.getModelConnections()).connections[0]?.revision).toBe(1);expect((await f.client.getModelConnections()).connections[0]?.capability_test).toBeUndefined(); } finally { await f.close(); }
  });
});
