// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, WorkbenchSettingsSnapshotSchema, WorkbenchResourcesSchema, ExtensionStatusSchema } from "@tracegraph/contracts";
import { type WorkbenchClient, DemoTraceGraphClient } from "./client";
import { createDemoSnapshot } from "./demo";
import { LanguageProvider } from "./i18n";
import { UnifiedSettings } from "./components/UnifiedSettings";
import { MigrationSettings } from "./components/MigrationSettings";
import { RollbackControls } from "./components/RollbackControls";
import { WorkspaceResources } from "./components/WorkspaceResources";
import { App } from "./App";
import { ChatView, NoProject } from "./components/WorkbenchStates";

let container: HTMLDivElement;
let root: Root;
const capabilities = (operations: string[]) => HostCapabilitiesSchema.parse({ profile_id: "isolated-profile", protocol_version: "test", capabilities: operations.map((operation) => ({ operation, state: "available", scope: "profile" })) });
const settings = () => WorkbenchSettingsSnapshotSchema.parse({ config_version: "outlive.workbench.v1", revision: 7, profile_id: "isolated-profile", settings: { general: { language: "en" } }, pending_restart: [], fields: [
  { path: "general.enter_behavior", source: "profile", scope: "profile", writable: true, effective: "immediate" },
  { path: "general.language", source: "environment", scope: "profile", writable: false, effective: "restart", reason: "Language is managed by environment" },
] });
const resources = () => WorkbenchResourcesSchema.parse({ runs: [], terminals: [], previews: [], schedules: [], archived_session_ids: [] });
const button = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
async function click(label: string) { await act(async () => button(label).click()); }
async function input(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe("unified settings authority and receipts", () => {
  it("labels known built-ins while preserving exact identifiers for enablement and reload", async () => {
    const client=new DemoTraceGraphClient(), name="@tracegraph/builtin-artifact-tools", other="trusted.custom-tool";
    client.getCapabilities=vi.fn(async()=>capabilities(["settings.read","settings.write","extensions.read","extensions.reload"]));
    client.getWorkbenchSettings=vi.fn(async()=>({...settings(),fields:[{path:"tools.disabled_extensions",source:"profile" as const,scope:"profile" as const,writable:true,effective:"new-run" as const}]}));
    client.listExtensions=vi.fn(async()=>[name,other].map(name=>ExtensionStatusSchema.parse({name,api_version:"tracegraph.extension.v1",state:"active",registration_count:1,generation:1,updated_at:"2026-10-05T00:00:00Z"})));
    client.updateWorkbenchSettings=vi.fn(async input=>({...settings(),revision:8,settings:{...settings().settings,tools:input.patch.tools!}}));client.reloadExtension=vi.fn(async name=>ExtensionStatusSchema.parse({name,api_version:"tracegraph.extension.v1",state:"active",registration_count:1,generation:2,updated_at:"2026-10-05T00:00:00Z"}));
    await act(async()=>root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()}/></LanguageProvider>));await click("Skills and extensions");
    const rows=container.querySelectorAll(".settings-extension-row");expect(rows[0]!.querySelector("label")!.textContent).toBe("Built-in artifact tools");expect(rows[0]!.querySelector("details code")!.textContent).toBe(name);expect(rows[1]!.querySelector("label")!.textContent).toBe(other);expect(rows[0]!.querySelector(":scope > small")!.textContent).toBe("Enabled");expect(rows[0]!.querySelector("details")!.hasAttribute("open")).toBe(false);expect(rows[0]!.querySelector("details")!.textContent).toContain("Generation: 1");expect([...container.querySelectorAll("h1,h2")].filter(value=>value.textContent==="Skills and extensions")).toHaveLength(1);
    await act(async()=>rows[0]!.querySelector<HTMLInputElement>("input")!.click());expect(client.updateWorkbenchSettings).toHaveBeenCalledWith(expect.objectContaining({patch:{tools:expect.objectContaining({disabled_extensions:[name]})}}));await act(async()=>rows[0]!.querySelector<HTMLButtonElement>("button")!.click());expect(client.reloadExtension).toHaveBeenCalledExactlyOnceWith(name);
  });
  it("treats restart_requested as acceptance and reports applied only after real reconnect plus fresh settings", async () => {
    const client = new DemoTraceGraphClient(); let restarted = false, release!: () => void;
    client.getCapabilities = vi.fn(async () => capabilities(["settings.read", "host.restart"]));
    client.getWorkbenchSettings = vi.fn(async () => ({ ...settings(), pending_restart: restarted ? [] : ["tools.mcp"] }));
    client.workbenchCommand = vi.fn(async (request) => ({ command_id: request.command_id, status: "succeeded" as const, code: "restart_requested", message: "Requested" }));
    client.reconnect = vi.fn(async () => { await new Promise<void>((done) => { release = done; }); restarted = true; }); vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>));
    await click("Restart to apply"); expect(client.workbenchCommand).toHaveBeenCalledWith({ type: "host.restart", command_id: expect.any(String) }); expect(container.textContent).toContain("Restart requested"); expect(container.textContent).not.toContain("Settings applied after restart");
    await act(async () => release()); expect(container.textContent).toContain("Settings applied after restart"); expect(client.workbenchCommand).toHaveBeenCalledOnce(); expect(client.reconnect).toHaveBeenCalledOnce();
  });
  it("keeps an actual restart_busy refusal available for explicit retry without cancelling tasks", async () => {
    const client = new DemoTraceGraphClient(); client.getCapabilities = vi.fn(async () => capabilities(["settings.read", "host.restart"])); client.getWorkbenchSettings = vi.fn(async () => ({ ...settings(), pending_restart: ["tools.lsp"] }));
    client.workbenchCommand = vi.fn(async () => { throw Object.assign(new Error("Finish active tasks first"), { body: { error: "restart_busy" } }); }); const stop = vi.spyOn(client, "stop"); const reconnect = vi.spyOn(client, "reconnect"); vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>)); await click("Restart to apply");
    expect(button("Restart to apply").disabled).toBe(false); expect(container.textContent).toContain("Finish active tasks first"); expect(stop).not.toHaveBeenCalled(); expect(reconnect).not.toHaveBeenCalled();
  });
  it("requires explicit scoped force confirmation and reports policy refusal without claiming restoration", async () => {
    const client = new DemoTraceGraphClient();
    client.rollbackAction = vi.fn(async (actionId) => ({ actionId, runId: "run:recorded", state: "refused" as const, eventId: "event:refused", sequence: 10, reason: "force_not_allowed" }));
    const action = { actionId: "action:recorded", projectId: "project:recorded", runId: "run:recorded", patchEventId: "event:applied", scope: ["src/add.ts"], workspaceKind: "managed_local" as const, state: "applied" as const };
    const render = (readOnly: boolean) => <LanguageProvider><RollbackControls client={client} actions={[action]} capabilities={capabilities(["rollback.write"])} status="completed" readOnly={readOnly} /></LanguageProvider>;
    await act(async () => root.render(render(true))); expect(button("Review rollback").disabled).toBe(true);
    await act(async () => root.render(render(false))); await click("Review rollback");
    expect(button("Confirm rollback").disabled).toBe(true); expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("project:recorded · run:recorded · action:recorded");
    expect(client.rollbackAction).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await click("Confirm rollback");
    expect(client.rollbackAction).toHaveBeenCalledWith("action:recorded", { force: true });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Rollback refused; files were not restored");
    expect(container.textContent).not.toContain("Rollback recorded");
  });
  it("inspects an unknown migration only on explicit request and never retries its commit", async () => {
    const client = new DemoTraceGraphClient();
    const inspect = vi.fn(async () => ({ state: "queued" as const, operation_id: "operation:uncertain-import" }));
    const commit = vi.fn(async () => ({ selected_source_id: "source:selected", copied_files: 0, quarantined_source_ids: [], backup_created: true as const }));
    const migrationClient = Object.assign(client, { getMigrationResult: inspect, commitMigration: commit });
    await act(async () => root.render(<LanguageProvider><MigrationSettings client={migrationClient} capabilities={capabilities(["migration.result"])} /></LanguageProvider>));
    expect(inspect).not.toHaveBeenCalled();
    await click("Inspect previous result");
    expect(container.textContent).toContain("queued · operation:uncertain-import"); expect(commit).not.toHaveBeenCalled();
  });
  it("shows unknown cost when the provider supplies tokens without a cost receipt", async () => {
    const client = new DemoTraceGraphClient();
    client.getCapabilities = vi.fn(async () => capabilities(["settings.read", "usage.read"]));
    client.getWorkbenchSettings = vi.fn(async () => settings());
    client.getUsage = vi.fn(async () => ({ schema_version: "tracegraph.usage.v1" as const, source: "ledger" as const, generated_at: "2026-10-03T00:00:00.000Z", run_count: 1, input_tokens: 10, output_tokens: 4, total_tokens: 14, cached_input_tokens: 0, reasoning_output_tokens: 0, costs: [] }));
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>));
    await click("Usage and diagnostics");
    expect(container.textContent).toContain("Reported costs: Unknown");
    expect(container.textContent).toContain("Total tokens: 14");
    expect(container.textContent).not.toContain("Reported costs: 0");
  });
  it("settles unavailable settings without treating existing callbacks as capability", async () => {
    const client = new DemoTraceGraphClient();
    client.getCapabilities = vi.fn(async () => capabilities([]));
    client.getWorkbenchSettings = vi.fn(async () => settings());
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>));
    expect(client.getWorkbenchSettings).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Loading settings…");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
  });
  it("honors source metadata and sends the full section with the displayed revision", async () => {
    const client = new DemoTraceGraphClient();
    client.getCapabilities = vi.fn(async () => capabilities(["settings.read", "settings.write"]));
    client.getWorkbenchSettings = vi.fn(async () => settings());
    client.updateWorkbenchSettings = vi.fn(async (request) => ({ ...settings(), revision: 8, settings: { ...settings().settings, general: request.patch.general! } }));
    const applied = vi.fn();
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={applied} /></LanguageProvider>));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Language"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("environment · profile · restart");
    await click("Keyboard shortcuts");
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Send shortcut"]')!, "mod-enter");
    expect(client.updateWorkbenchSettings).toHaveBeenCalledWith(expect.objectContaining({ expected_revision: 7, command_id: expect.any(String), patch: { general: { ...settings().settings.general, enter_behavior: "mod-enter" } } }));
    expect(applied).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 8 }));
  });
  it("separates saved-connection writes from actual provider tests and preserves failed drafts", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient();
    client.getCapabilities = vi.fn(async () => capabilities(["settings.read", "models.read", "models.write", "models.test"]));
    client.getWorkbenchSettings = vi.fn(async () => settings());
    const connection = { connection_id: "saved-one", label: "One", revision: 1, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1:18000/v1", model: "saved-model", models: ["saved-model"], has_key: true, source: "profile" as const, writable: true };
    client.getModelConnections = vi.fn(async () => ({ connections: [connection], default_connection_id: connection.connection_id }));
    client.saveModelConnection = vi.fn(async () => { throw new Error("MODEL_SAVE_REJECTED"); });
    client.testModelConnection = vi.fn(async () => ({ status: "failed" as const, code: "provider_unreachable", message: "Connection refused", checked_at: "2026-10-03T00:00:00.000Z", model: connection.model, duration_ms: 5 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>));
    await click("Models"); await click("Edit connection");
    const key = container.querySelector<HTMLInputElement>('[aria-label="Connection API key"]')!;
    await input(key, "test-only-placeholder"); await click("Save connection");
    expect(client.testModelConnection).not.toHaveBeenCalled(); expect(key.value).toBe("test-only-placeholder");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("MODEL_SAVE_REJECTED");
    await click("Test model connection"); expect(client.testModelConnection).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("provider_unreachable"); expect(container.textContent).not.toContain("test-only-placeholder");
  });
});

describe("workspace controls", () => {
  it("allows a resource holder to stop while an unrelated Git mutation awaits its lease", async () => {
    const client = new DemoTraceGraphClient(), snapshot = createDemoSnapshot("ready");
    const preview = { preview_id: "preview-holder", project_id: snapshot.project!.id, url: "http://127.0.0.1:4315/", state: "ready" as const, owned_process: true };
    client.getCapabilities = vi.fn(async () => capabilities(["resources.read", "git.status", "git.stage", "preview.stop"]));
    client.getWorkbenchResources = vi.fn(async () => ({ ...resources(), previews: [preview] }));
    let release!: () => void; const lease = new Promise<void>((resolve) => { release = resolve; });
    client.workbenchCommand = vi.fn(async (request) => {
      if (request.type === "git.stage") await lease;
      return { command_id: request.command_id, status: "succeeded" as const, code: request.type, message: "Acknowledged", ...(request.type === "git.status" ? { git: { project_id: snapshot.project!.id, branch: "main", files: [{ path: "file.txt", index_status: " ", worktree_status: "M" }], worktrees: [] } } : {}) };
    });
    await act(async () => root.render(<LanguageProvider><WorkspaceResources client={client} snapshot={snapshot} onClose={vi.fn()} onOpenSession={vi.fn()} /></LanguageProvider>));
    await click("Git and worktrees"); await click("Refresh Git status"); await click("Stage");
    await click("Preview services"); expect(button("Stop preview").disabled).toBe(false);
    await click("Stop preview");
    expect(client.workbenchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "preview.stop", preview_id: preview.preview_id }));
    await act(async () => release());
  });
  it("uses scoped Git commands and retains a command failure after resource polling succeeds", async () => {
    const client = new DemoTraceGraphClient();
    client.getCapabilities = vi.fn(async () => capabilities(["resources.read", "git.status", "git.stage"]));
    client.getWorkbenchResources = vi.fn(async () => resources());
    client.workbenchCommand = vi.fn(async (request) => {
      if (request.type === "git.stage") throw new Error("git_workspace_busy");
      return { command_id: request.command_id, status: "succeeded" as const, code: "git_status", message: "Git status read", git: { project_id: createDemoSnapshot("ready").project!.id, branch: "main", files: [{ path: "src/index.ts", index_status: " ", worktree_status: "M" }], worktrees: [] } };
    });
    await act(async () => root.render(<LanguageProvider><WorkspaceResources client={client} snapshot={createDemoSnapshot("ready")} onClose={vi.fn()} onOpenSession={vi.fn()} /></LanguageProvider>));
    await click("Git and worktrees"); await click("Refresh Git status"); await click("Stage");
    expect(client.workbenchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "git.stage", project_id: createDemoSnapshot("ready").project!.id, paths: ["src/index.ts"] }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("git_workspace_busy");
  });
  it("keeps unavailable terminal and preview mutations disabled despite real client methods", async () => {
    const client = new DemoTraceGraphClient(); client.getCapabilities = vi.fn(async () => capabilities(["resources.read"])); client.getWorkbenchResources = vi.fn(async () => resources());
    const command = vi.spyOn(client, "workbenchCommand");
    await act(async () => root.render(<LanguageProvider><WorkspaceResources client={client} snapshot={createDemoSnapshot("ready")} onClose={vi.fn()} onOpenSession={vi.fn()} /></LanguageProvider>));
    await click("Terminal"); expect(button("New terminal").disabled).toBe(true);
    await click("Preview services"); expect(button("Connect existing service").disabled).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });
  it("requires the selected file diff before discarding and binds confirmation to the reviewed Git head", async () => {
    const client = new DemoTraceGraphClient();
    const snapshot = createDemoSnapshot("ready");
    client.getCapabilities = vi.fn(async () => capabilities(["resources.read", "git.status", "git.diff", "git.discard"]));
    client.getWorkbenchResources = vi.fn(async () => resources());
    const git = { project_id: snapshot.project!.id, branch: "main", head: "abc123", files: [{ path: "src/index.ts", index_status: " ", worktree_status: "M" }], worktrees: [] };
    client.workbenchCommand = vi.fn(async (request) => ({ command_id: request.command_id, status: "succeeded" as const, code: request.type, message: "Reviewed", git: { ...git, ...(request.type === "git.diff" ? { diff: "--- a/src/index.ts\n+++ b/src/index.ts\n-old\n+new" } : {}) } }));
    await act(async () => root.render(<LanguageProvider><WorkspaceResources client={client} snapshot={snapshot} onClose={vi.fn()} onOpenSession={vi.fn()} /></LanguageProvider>));
    await click("Git and worktrees"); await click("Refresh Git status"); await click("Discard");
    expect(client.workbenchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "git.diff", paths: ["src/index.ts"], scope: "workspace" }));
    expect(container.querySelector('[aria-label="Confirm Git discard"]')?.textContent).toContain("+new");
    expect(vi.mocked(client.workbenchCommand).mock.calls.some(([request]) => request.type === "git.discard")).toBe(false);
    await click("Confirm discard");
    expect(client.workbenchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "git.discard", paths: ["src/index.ts"], expected_head: "abc123" }));
  });
  it("cancels a queued holder without treating its synthetic queue id as an actual Run", async () => {
    const client = new DemoTraceGraphClient();
    client.getCapabilities = vi.fn(async () => capabilities(["resources.read", "queue.cancel", "run.cancel"]));
    const pending = { ...resources(), runs: [{ run_id: "queued:original-command", project_id: "project:test", task: "Waiting for workspace", status: "queued" }] };
    client.getWorkbenchResources = vi.fn(async () => pending);
    client.workbenchCommand = vi.fn(async (request) => ({ command_id: request.command_id, status: "succeeded" as const, code: "queue_cancelled", message: "Queued holder cancelled" }));
    const stop = vi.spyOn(client, "stopRun");
    await act(async () => root.render(<LanguageProvider><WorkspaceResources client={client} snapshot={createDemoSnapshot("ready")} onClose={vi.fn()} onOpenSession={vi.fn()} /></LanguageProvider>));
    await click("Cancel queued task");
    expect(client.workbenchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "queue.cancel", holder_id: "original-command" }));
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("conversation disclosure", () => {
  it("shows one friendly current line and one actual operation while transport details remain collapsed", async () => {
    const fixture = createDemoSnapshot("running"), summary = "Requesting a decision from synthetic-provider with provider-default reasoning";
    const event = { ...fixture.run!.events[0]!, kind: "decision" as const, state: "running" as const, sourceType: "model.request_started", operationId: "call:observed", summary, title: "Model request started" };
    HTMLElement.prototype.scrollIntoView = vi.fn();
    await act(async () => root.render(<LanguageProvider><ChatView changedFiles={[]} conversation={[]} events={[event]} task="Inspect" status="running" dataSource="live" evidence={fixture.evidence} currentStep={summary} /></LanguageProvider>));
    expect(container.querySelector(".chat-operation-waiting")?.textContent).toBe("Working…");
    expect(container.textContent).not.toContain("synthetic-provider");
    expect(container.querySelector(".public-progress-item")).toBeNull();
  });
  it("keeps approval success in the conversation until Review is explicitly opened", async () => {
    const client = new DemoTraceGraphClient(), snapshot = createDemoSnapshot("needs_approval");
    client.getSnapshot = vi.fn(() => snapshot);
    client.approve = vi.fn(async () => undefined);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    await act(async () => root.render(<App client={client} />));
    expect(container.querySelector(".developer-side-panel")).toBeNull();
    await click("Allow once");
    expect(client.approve).toHaveBeenCalledWith(snapshot.run!.approval!.id);
    expect(container.querySelector(".developer-side-panel")).toBeNull();
    await click("Review changes");
    expect(container.querySelector(".developer-side-panel")).not.toBeNull();
  });
  it("does not force a reader to the tail when history is open or new events arrive", async () => {
    const fixture = createDemoSnapshot("running");
    const scroll = vi.fn(); HTMLElement.prototype.scrollIntoView = scroll;
    const render = (events = fixture.run!.events) => <LanguageProvider><ChatView changedFiles={[]} conversation={[]} events={events} task="Inspect" status="running" dataSource="live" evidence={fixture.evidence} /></LanguageProvider>;
    await act(async () => root.render(render()));
    const view = container.querySelector<HTMLElement>(".chat-view")!;
    Object.defineProperties(view, { scrollHeight: { configurable: true, value: 1_000 }, clientHeight: { configurable: true, value: 200 } });
    await act(async () => view.dispatchEvent(new Event("scroll", { bubbles: true })));
    scroll.mockClear();
    const details = container.querySelector<HTMLDetailsElement>(".chat-operation-group")!;
    expect(details.open).toBe(false);
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    await act(async () => root.render(render([...fixture.run!.events, { ...fixture.run!.events[0]!, id: "new-event", sequence: 100, summary: "A new actual operation" }])));
    expect(scroll).not.toHaveBeenCalled();
    expect(details.open).toBe(true);
  });
  it("honors the shared send shortcut and preserves Shift+Enter and IME", async () => {
    const start = vi.fn(async () => undefined);
    await act(async () => root.render(<LanguageProvider><NoProject connection={{ state: "live", message: "Ready", lastSequence: 0 }} onStartChat={start} reasoningEffort="low" onReasoningEffortChange={vi.fn()} enterBehavior="mod-enter" /></LanguageProvider>));
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Plain chat message"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Test shortcut"); editor.dispatchEvent(new Event("input", { bubbles: true })); });
    for (const options of [{}, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, isComposing: true }]) await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...options })));
    expect(start).not.toHaveBeenCalled();
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ctrlKey: true })));
    expect(start).toHaveBeenCalledWith("Test shortcut", "low", []);
  });
});
