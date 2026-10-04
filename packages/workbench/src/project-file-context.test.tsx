// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, type ProjectFileSnapshot, type SessionRunOptions } from "@tracegraph/contracts";
import { App } from "./App";
import { Composer } from "./components/Composer";
import { ProjectFileContextPicker } from "./components/ProjectFileContextPicker";
import { ComposerModelMenu } from "./conversation-options";
import { DemoTraceGraphClient, type WorkbenchClient } from "./client";
import { useConversationDraft } from "./drafts";
import { createDemoSnapshot } from "./demo";

let container: HTMLDivElement, root: Root;
const hash = `sha256:${"a".repeat(64)}` as const;
const caps = HostCapabilitiesSchema.parse({ profile_id: "profile-one", protocol_version: "test", capabilities: ["files.list", "files.read", "files.context", "models.read", "model.configure"].map((operation) => ({ operation, state: "available", scope: "profile" })) });
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name)!;
const click = async (name: string) => { expect(button(name)).toBeDefined(); await act(async () => button(name).click()); };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
function fixture(file: ProjectFileSnapshot) { const client: WorkbenchClient = new DemoTraceGraphClient(); client.listProjectFiles = vi.fn(async () => ({ project_id: "p", path: "", entries: [{ path: file.path, name: file.path, kind: "file" as const }], truncated: false })); client.readProjectFile = vi.fn(async () => file); return client; }

describe("project file context", () => {
  it("reads the selected existing text file and retains only scoped path/hash/size metadata", async () => {
    const client = fixture({ project_id: "p", path: "answer.ts", sha256: hash, kind: "text", byte_length: 20, content: "export const n = 1;\n" }); const change = vi.fn();
    await act(async () => root.render(<ProjectFileContextPicker client={client} projectId="p" selected={[]} onChange={change} onClose={vi.fn()} online readOnly={false} capabilities={caps} />)); await click("answer.ts");
    expect(client.listProjectFiles).toHaveBeenCalledWith("p", {}); expect(client.readProjectFile).toHaveBeenCalledWith("p", { path: "answer.ts" }); expect(change).toHaveBeenCalledWith([{ path: "answer.ts", expected_sha256: hash, byte_length: 20 }]); expect(JSON.stringify(change.mock.calls)).not.toContain("export const");
  });
  it.each([
    [{ project_id: "p", path: "binary.dat", sha256: hash, kind: "binary", byte_length: 3 }, "Only existing UTF-8 text files"],
    [{ project_id: "p", path: "large.txt", sha256: hash, kind: "text", byte_length: 65537, content: "x".repeat(65537) }, "64 KiB or smaller"],
    [{ project_id: "other-project", path: "outside.txt", sha256: hash, kind: "text", byte_length: 2, content: "hi" }, "could not be verified"],
  ] as const)("does not add unsupported, oversized or foreign project data", async (file, message) => {
    const client = fixture(file); const change = vi.fn(); await act(async () => root.render(<ProjectFileContextPicker client={client} projectId="p" selected={[]} onChange={change} onClose={vi.fn()} online readOnly={false} capabilities={caps} />)); await click(file.path); expect(container.textContent).toContain(message); expect(change).not.toHaveBeenCalled();
  });
  it("does not exceed the aggregate context budget", async () => {
    const client = fixture({ project_id: "p", path: "next.txt", sha256: hash, kind: "text", byte_length: 1, content: "x" }); const change = vi.fn(); const selected = ["one.txt", "two.txt"].map((path) => ({ path, expected_sha256: hash, byte_length: 65536 }));
    await act(async () => root.render(<ProjectFileContextPicker client={client} projectId="p" selected={selected} onChange={change} onClose={vi.fn()} online readOnly={false} capabilities={caps} />)); await click("next.txt"); expect(container.textContent).toContain("128 KiB or less"); expect(change).not.toHaveBeenCalled();
  });
  it.each([{ online: false, readOnly: false }, { online: true, readOnly: true }])("does not browse or stage context offline or during replay: %j", async (state) => {
    const client = fixture({ project_id: "p", path: "a.txt", sha256: hash, kind: "text", byte_length: 1, content: "x" });
    await act(async () => root.render(<ProjectFileContextPicker client={client} projectId="p" selected={[]} onChange={vi.fn()} onClose={vi.fn()} {...state} capabilities={caps} />)); expect(client.listProjectFiles).not.toHaveBeenCalled(); expect(client.readProjectFile).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("Loading…"); expect(button("Refresh files").disabled).toBe(true);
  });
  it("does not infer context admission support from an older Host's file browsing capability", async () => {
    const client = fixture({ project_id: "p", path: "a.txt", sha256: hash, kind: "text", byte_length: 1, content: "x" }); const oldCapabilities = { ...caps, capabilities: caps.capabilities.filter((item) => item.operation !== "files.context") };
    await act(async () => root.render(<ProjectFileContextPicker client={client} projectId="p" selected={[]} onChange={vi.fn()} onClose={vi.fn()} online readOnly={false} capabilities={oldCapabilities} />)); expect(client.listProjectFiles).not.toHaveBeenCalled(); expect(client.readProjectFile).not.toHaveBeenCalled(); expect(button("Refresh files").disabled).toBe(true); expect(container.textContent).toContain("Project file context is unavailable with the current permissions.");
    const snapshot = { ...createDemoSnapshot("ready"), dataSource: "live" as const, run: null, selectedSessionId: null }; client.getSnapshot = () => snapshot; client.getCapabilities = vi.fn(async () => oldCapabilities); client.getModelConnections = vi.fn(async () => ({ default_connection_id: "one", connections: [{ connection_id: "one", label: "Provider", revision: 1, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "model", models: ["model"], has_key: true, source: "profile" as const, writable: true }] }));
    await act(async () => root.render(<App client={client} />)); await click("Add to message"); expect(button("Add project file context").disabled).toBe(true); expect(client.listProjectFiles).not.toHaveBeenCalled(); expect(client.readProjectFile).not.toHaveBeenCalled();
  });
  it("keeps file references with each conversation draft through scope changes and disconnection", async () => {
    function Harness({ scope, offline = false }: { scope: string; offline?: boolean }) { const state = useConversationDraft(scope); return <><button onClick={() => state.setFileContexts([{ path: "answer.ts", expected_sha256: hash, byte_length: 20 }])}>Select context</button><Composer value={state.draft.text} onChange={state.setText} onSubmit={vi.fn()} mode="execute" onModeChange={vi.fn()} attachments={state.draft.attachments} onAttachmentsChange={state.setAttachments} fileContexts={state.draft.fileContexts} onFileContextsChange={state.setFileContexts} disabledReason={offline ? "Repair connection" : null} /></>; }
    await act(async () => root.render(<Harness scope="one" />)); await click("Select context"); expect(button("Remove file context: answer.ts")).toBeDefined(); await act(async () => root.render(<Harness scope="two" />)); expect(button("Remove file context: answer.ts")).toBeUndefined(); await act(async () => root.render(<Harness scope="one" offline />)); expect(button("Remove file context: answer.ts").disabled).toBe(true); await act(async () => root.render(<Harness scope="one" />)); expect(button("Remove file context: answer.ts").disabled).toBe(false);
  });
  it("sends exact file references separately from task text and preserves the draft when admission rejects a changed file", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const original = createDemoSnapshot("ready"); const snapshot = { ...original, dataSource: "live" as const, run: null, selectedSessionId: null }; const projectId = snapshot.project!.id; client.getSnapshot = () => snapshot; client.getCapabilities = vi.fn(async () => caps);
    client.getModelConnections = vi.fn(async () => ({ default_connection_id: "one", connections: [{ connection_id: "one", label: "Provider", revision: 1, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "model", models: ["model"], has_key: true, source: "profile" as const, writable: true }] }));
    client.listProjectFiles = vi.fn(async () => ({ project_id: projectId, path: "", entries: [{ path: "answer.ts", name: "answer.ts", kind: "file" as const }], truncated: false })); client.readProjectFile = vi.fn(async () => ({ project_id: projectId, path: "answer.ts", sha256: hash, kind: "text" as const, byte_length: 20, content: "export const n = 1;\n" })); client.startRun = vi.fn(async () => { throw new Error("The selected file changed before the task started."); });
    await act(async () => root.render(<App client={client} />)); await click("Add to message"); await click("Add project file context"); await click("answer.ts"); await click("Done"); const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Task"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Inspect the selected file"); textarea.dispatchEvent(new Event("input", { bubbles: true })); }); await click("Send message");
    expect(client.startRun).toHaveBeenCalledWith("Inspect the selected file", "execute", "default", [], expect.objectContaining({ connection_id: "one", model: "model" }), [{ path: "answer.ts", expected_sha256: hash }]); expect(client.startRun).toHaveBeenCalledOnce(); expect(textarea.value).toBe("Inspect the selected file"); expect(button("Remove file context: answer.ts")).toBeDefined(); expect(container.textContent).toContain("selected file changed"); expect(container.textContent).not.toContain("export const n = 1;");
  });
  it("shows the configured nondefault reasoning effort next to the current model", async () => {
    const options: SessionRunOptions = { connection_id: "one", model: "model", reasoning_effort: "high", mode: "execute", permission_preset: "workspace-write" }; await act(async () => root.render(<ComposerModelMenu connections={null} options={options} onChange={vi.fn()} onSettings={vi.fn()} disabled={false} active={false} />)); expect(button("Choose model").textContent).toContain("model· High");
  });
  it("does not offer project-file context in a plain conversation even when the Host supports project reads", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const snapshot = { ...createDemoSnapshot("ready"), dataSource: "live" as const, project: null, run: null, selectedSessionId: null }; client.getSnapshot = () => snapshot; client.getCapabilities = vi.fn(async () => caps);
    client.getModelConnections = vi.fn(async () => ({ default_connection_id: "one", connections: [{ connection_id: "one", label: "Provider", revision: 1, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "model", models: ["model"], has_key: true, source: "profile" as const, writable: true }] })); client.listProjectFiles = vi.fn(); client.readProjectFile = vi.fn();
    await act(async () => root.render(<App client={client} />)); await click("Add to message"); expect(button("Add project file context")).toBeUndefined(); expect(client.listProjectFiles).not.toHaveBeenCalled(); expect(client.readProjectFile).not.toHaveBeenCalled();
  });
});
