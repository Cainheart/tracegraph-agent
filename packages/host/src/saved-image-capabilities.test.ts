import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {JsonlEventLedger, PrivateFileCredentialStore} from "@tracegraph/core";
import {RunProjectionSchema, type ModelConnectionSaveRequest, type RunProjection} from "@tracegraph/contracts";
import {createHostComposition} from "./composition/host-composition.js";

const origin = "http://127.0.0.1:4310";
// A complete, one-pixel PNG, rather than an image magic-header stand-in.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7GkAAAAASUVORK5CYII=", "base64");
const pngHash = `sha256:${createHash("sha256").update(png).digest("hex")}`;
const fixtureKey = "isolated-image-fixture-key";
const replacementKey = "isolated-image-replacement-key";
interface ProviderCall {
  model: string;
  credentialVersion: "initial" | "replacement" | "unexpected";
  images: Array<{mediaType: string; sha256: string; bytes: number}>;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "outlive-saved-image-capability-"));
  const calls: ProviderCall[] = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as {model: string; messages?: Array<{content?: unknown}>};
    const images: ProviderCall["images"] = [];
    for (const message of input.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "image_url") continue;
        const match = /^data:([^;,]+);base64,(.+)$/u.exec(String(block.image_url?.url));
        if (!match) continue;
        const bytes = Buffer.from(match[2]!, "base64");
        images.push({mediaType: match[1]!, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length});
      }
    }
    // Keep even the synthetic credential value out of durable test diagnostics.
    const credentialVersion = request.headers.authorization === `Bearer ${fixtureKey}` ? "initial"
      : request.headers.authorization === `Bearer ${replacementKey}` ? "replacement" : "unexpected";
    calls.push({model: input.model, credentialVersion, images});
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify({choices: [{message: {content: JSON.stringify({
      decision_id: `image-fixture-finish-${calls.length}`, kind: "finish", public_reason: "Fixture request observed",
      evidence_refs: [], risk: "none", final_answer: "Attachment request received",
    })}}]}));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as {port: number};
  const store = new PrivateFileCredentialStore(join(root, "credentials.json"));
  const options = {
    profileRoot: root, dataDir: join(root, "data"), sessionDir: join(root, "sessions"),
    permissionConfigPath: join(root, "permission.json"), credentialStore: store,
    environment: {}, useEnvironmentModel: false, nativePicker: false, admission: "workspace" as const,
  };
  let composition = await createHostComposition(options);
  let token = "";
  const bootstrap = async () => {
    const result = await composition.host.app.inject({method: "GET", url: "/api/bootstrap", headers: {origin}});
    expect(result.statusCode).toBe(200);
    token = result.json().token;
  };
  await bootstrap();
  const post = (url: string, input: {command_id: string}) => composition.host.app.inject({
    method: "POST", url, headers: {origin, authorization: `Bearer ${token}`, "x-tracegraph-command-id": input.command_id}, payload: input,
  });
  return {
    root, calls, store, post,
    get composition() { return composition; },
    saveInput(input: Partial<ModelConnectionSaveRequest> = {}): ModelConnectionSaveRequest {
      return {command_id: "image-save", connection_id: "image-service", label: "Image fixture",
        provider: "custom", protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture-vision", models: ["fixture-vision", "fixture-text"], api_key: fixtureKey, ...input};
    },
    async upload(commandId: string) {
      const query = new URLSearchParams({command_id: commandId, target: "chat", declared_media_type: "image/png", delivery: "inline"});
      const result = await composition.host.app.inject({method: "POST", url: `/api/attachments?${query}`, headers: {
        origin, authorization: `Bearer ${token}`, "x-tracegraph-command-id": commandId, "content-type": "application/octet-stream",
      }, payload: png});
      expect(result.statusCode).toBe(201);
      expect(result.json()).toMatchObject({status: "accepted", delivery: "inline", bytes: png.length});
      return result.json().upload_id as string;
    },
    async start(commandId: string, uploadId: string, model = "fixture-vision") {
      const result = await post("/api/chat/runs", {
        command_id: commandId, task: "Inspect this fixture image", attachment_upload_ids: [uploadId],
        run_options: {connection_id: "image-service", model, mode: "execute", reasoning_effort: "default", permission_preset: "workspace-write"},
      } as Parameters<typeof post>[1]);
      expect(result.statusCode).toBe(200);
      return RunProjectionSchema.parse(result.json());
    },
    async restart() {
      await composition.close();
      composition = await createHostComposition(options);
      await bootstrap();
    },
    async close() {
      try { await composition.close(); }
      finally {
        provider.closeAllConnections();
        await new Promise<void>(resolve => provider.close(() => resolve()));
        await rm(root, {recursive: true, force: true});
      }
    },
  };
}

async function completed(f: Awaited<ReturnType<typeof fixture>>, runId: string): Promise<RunProjection> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await f.composition.runtime.getProjection(runId);
    if (["completed", "failed", "cancelled"].includes(projection.status)) return projection;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Isolated image capability Run did not settle");
}

describe("saved per-model image declarations through the Host", () => {
  it("admits real inline PNG bytes through public routes and persists the declaration without an environment flag", async () => {
    const f = await fixture();
    try {
      const saved = await f.post("/api/workbench/models", f.saveInput({image_input_models: ["fixture-vision"]}));
      expect(saved.statusCode).toBe(200);
      expect(saved.json().connections[0]).toMatchObject({image_input_models: ["fixture-vision"]});
      const registry = await readFile(join(f.root, "model-connections.json"), "utf8");
      expect(JSON.parse(registry).entries[0]).toMatchObject({image_input_models: ["fixture-vision"]});
      expect(registry).not.toContain(fixtureKey);
      await f.restart();
      expect(f.composition.conversationControl.snapshot().connections[0]?.image_input_models).toEqual(["fixture-vision"]);
      const uploadId = await f.upload("image-upload-persisted");
      const started = await f.start("image-run-persisted", uploadId);
      const projection = await completed(f, started.run_id);
      expect(projection.status).toBe("completed");
      expect(projection.attachments.items[0]).toMatchObject({status: "added", delivery: "inline"});
      expect(f.calls.find(call => call.images.length !== 0)).toEqual({model: "fixture-vision", credentialVersion: "initial", images: [{mediaType: "image/png", sha256: pngHash, bytes: png.length}]});
      const events = await new JsonlEventLedger(join(f.root, "data", "events")).list(started.run_id);
      const added = events.findIndex(event => event.type === "attachment.added");
      expect(added).toBeGreaterThan(events.findIndex(event => event.type === "run.created"));
      expect(added).toBeLessThan(events.findIndex(event => event.type === "run.started"));
      expect(events.find(event => event.type === "run.created")?.data.model_binding).toMatchObject({model: "fixture-vision", image_input: true});
      expect(JSON.stringify(events)).not.toContain(png.toString("base64"));
    } finally { await f.close(); }
  });

  it("rejects inline delivery for an undeclared selected model rather than inferring known model support", async () => {
    const f = await fixture();
    try {
      expect((await f.post("/api/workbench/models", f.saveInput({model: "gpt-4.1-mini", models: ["gpt-4.1-mini", "fixture-vision"], image_input_models: ["fixture-vision"]}))).statusCode).toBe(200);
      const started = await f.start("image-run-undeclared", await f.upload("image-upload-undeclared"), "gpt-4.1-mini");
      const projection = await completed(f, started.run_id);
      expect(projection.status).toBe("completed");
      expect(projection.attachments.items[0]).toMatchObject({status: "rejected", code: "model_image_unsupported"});
      expect(f.calls.every(call => call.images.length === 0)).toBe(true);
      expect(f.calls[0]?.model).toBe("gpt-4.1-mini");
      const events = await new JsonlEventLedger(join(f.root, "data", "events")).list(started.run_id);
      expect(events.find(event => event.type === "attachment.rejected")?.data.code).toBe("model_image_unsupported");
      expect(events.find(event => event.type === "run.created")?.data.model_binding).toMatchObject({model: "gpt-4.1-mini", image_input: false});
    } finally { await f.close(); }
  });

  it("keeps an admitted capability and credential frozen when the saved declaration and key change", async () => {
    const f = await fixture();
    try {
      expect((await f.post("/api/workbench/models", f.saveInput({image_input_models: ["fixture-vision"]}))).statusCode).toBe(200);
      const uploadId = await f.upload("image-upload-frozen");
      const workspace = await f.composition.resolveWorkspace("chat:local");
      const input = {command_id: "image-run-frozen", project_id: workspace.project_id, task: "Inspect frozen image", mode: "execute" as const, attachment_upload_ids: [uploadId]};
      const admitted = await f.composition.conversationControl.prepare(input, workspace);
      const updated = await f.post("/api/workbench/models", f.saveInput({command_id: "image-save-replaced", expected_revision: 0, image_input_models: [], api_key: replacementKey}));
      expect(updated.statusCode).toBe(200);
      expect(updated.json().connections[0]).toMatchObject({revision: 1, image_input_models: []});
      const started = await f.composition.host.runSessions.startRun(input, admitted);
      const projection = await completed(f, started.run_id);
      expect(projection.status).toBe("completed");
      expect(projection.attachments.items[0]).toMatchObject({status: "added", delivery: "inline"});
      expect(f.calls[0]).toEqual({model: "fixture-vision", credentialVersion: "initial", images: [{mediaType: "image/png", sha256: pngHash, bytes: png.length}]});
      expect(projection.timeline.find(event => event.type === "run.created")?.data.model_binding).toMatchObject({revision: 0, image_input: true});
      const next = await f.start("image-run-after-change", await f.upload("image-upload-after-change"));
      const nextProjection = await completed(f, next.run_id);
      expect(nextProjection.attachments.items[0]).toMatchObject({status: "rejected", code: "model_image_unsupported"});
      expect(f.calls.some(call => call.credentialVersion === "replacement" && call.images.length === 0)).toBe(true);
    } finally { await f.close(); }
  });

  it("rejects a mismatched model subset before any credential or model configuration write", async () => {
    const f = await fixture();
    const write = vi.spyOn(f.store, "set");
    try {
      const result = await f.post("/api/workbench/models", f.saveInput({image_input_models: ["not-a-configured-model"]}));
      expect(result.statusCode).toBe(400);
      expect(result.json().error).toBe("model_image_declaration_invalid");
      expect(write).not.toHaveBeenCalled();
      expect(f.composition.conversationControl.snapshot().connections).toEqual([]);
      await expect(readFile(join(f.root, "model-connections", "image-service.json"))).rejects.toMatchObject({code: "ENOENT"});
      expect(f.calls).toEqual([]);
    } finally { write.mockRestore(); await f.close(); }
  });
});
