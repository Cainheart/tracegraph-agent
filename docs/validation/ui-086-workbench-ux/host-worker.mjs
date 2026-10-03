/** Isolated real HTTP Host child for the UX-086 process-death journey. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurableModelAdapter, DurableSessionController, JsonlSessionStore, createAgentRuntime, createSecretReference } from "../../../packages/core/dist/index.js";
import { createTraceGraphHost } from "../../../packages/host/dist/index.js";
import { analyzeCodeGraph, diffGraphSnapshots } from "../../../packages/codegraph/dist/index.js";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const model = new ConfigurableModelAdapter({ resolveCredential: async () => "synthetic-ux086-key" });
model.configure({ provider: "custom", protocol: "openai-chat-completions", baseUrl: input.modelBase, model: "synthetic-ux086-local", credentialRef: createSecretReference("UX086_SYNTHETIC") });
const store = new JsonlSessionStore(join(input.dataDir, "sessions"));
const codeGraph = {
  async createSnapshot({ projectId, workspaceRoot, signal }) { return (await analyzeCodeGraph({ project_id: projectId, workspace_root: workspaceRoot, signal })).snapshot; },
  async createDelta({ base, result, patchEventId }) { return diffGraphSnapshots(base, result, { ...(patchEventId ? { patch_event_id: patchEventId } : {}) }); },
};
const runtime = await createAgentRuntime({ dataDir: input.dataDir, sessionStore: store, model, codeGraph, sandboxMode: "danger-full-access" });
const host = await createTraceGraphHost({
  runtime,
  sessions: new DurableSessionController({ store, runtime, workspaceResolver: (id) => id === input.fixture.project_id ? input.fixture : id === input.chatWorkspace.project_id ? input.chatWorkspace : undefined }),
  projects: [{ label: "UX-086 fixture project", workspace: input.fixture }],
  chatProject: { label: "Plain chat", workspace: input.chatWorkspace },
  allowedOrigins: [input.staticAddress],
  modelSettings: { get: () => ({ provider: "custom", protocol: "openai-chat-completions", configured: true, base_url: input.modelBase, model: "synthetic-ux086-local", has_key: true }), configure() { throw new Error("Synthetic acceptance provider is fixed"); } },
});
process.send({ address: await host.listen({ port: 0 }) });
process.once("message", async (message) => {
  if (message?.type === "close") { await host.close(); await runtime.shutdownBackgroundWork?.(); process.exit(0); }
});
