// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, type SessionRunOptions, type ProjectFileSaveRequest } from "@tracegraph/contracts";
import { type WorkbenchClient, DemoTraceGraphClient } from "./client";
import { Composer } from "./components/Composer";
import { ModelConnectionsSettings } from "./components/ModelConnectionsSettings";
import { App } from "./App";
import { ChatView } from "./components/WorkbenchStates";
import { ProjectFiles } from "./components/ProjectFiles";
import { MessageActions } from "./components/MessageActions";
import { MemoryControlPanel } from "./components/MemoryControlPanel";
import { UnifiedSettings } from "./components/UnifiedSettings";
import { ComposerModelMenu, ComposerPermissionMenu, useConversationOptions } from "./conversation-options";
import { useConversationDraft } from "./drafts";
import { createDemoSnapshot } from "./demo";
import { LanguageProvider } from "./i18n";

let root: Root, container: HTMLDivElement;
const caps = (operations: string[]) => HostCapabilitiesSchema.parse({ profile_id: "profile-one", protocol_version: "test", capabilities: operations.map((operation) => ({ operation, state: "available", scope: "profile" })) });
const hash = `sha256:${"a".repeat(64)}` as const;
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name)!;
const click = async (name: string) => { expect(button(name)).toBeDefined(); await act(async () => button(name).click()); };
async function type(node: HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function DraftHarness({ scope, offline = false }: { scope: string; offline?: boolean }) { const draft = useConversationDraft(scope); return <Composer value={draft.draft.text} onChange={draft.setText} onSubmit={vi.fn()} mode="execute" onModeChange={vi.fn()} attachments={draft.draft.attachments} onAttachmentsChange={draft.setAttachments} disabledReason={offline ? "Repair connection" : null} />; }

describe("current conversation workbench", () => {
  it("keeps different conversation drafts and retains the original draft across disconnection", async () => {
    await act(async () => root.render(<DraftHarness scope="session-a" />)); await type(container.querySelector("textarea")!, "Draft A");
    await act(async () => root.render(<DraftHarness scope="session-b" />)); expect(container.querySelector("textarea")!.value).toBe(""); await type(container.querySelector("textarea")!, "Draft B");
    await act(async () => root.render(<DraftHarness scope="session-a" offline />)); expect(container.querySelector("textarea")!.value).toBe("Draft A"); expect(container.querySelector("textarea")!.disabled).toBe(true);
    await act(async () => root.render(<DraftHarness scope="session-a" />)); expect(container.querySelector("textarea")!.value).toBe("Draft A");
  });
  it("pastes images through the normal attachment validator without submitting a task", async () => {
    const change = vi.fn(), submit = vi.fn();
    await act(async () => root.render(<Composer value="" onChange={vi.fn()} onSubmit={submit} mode="execute" onModeChange={vi.fn()} attachments={[]} onAttachmentsChange={change} attachmentsAvailable />));
    const png = new File([new Uint8Array([1, 2])], "pasted.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(paste, "clipboardData", { value: { files: [png] } });
    await act(async () => container.querySelector("textarea")!.dispatchEvent(paste)); expect(paste.defaultPrevented).toBe(true); expect(change.mock.calls[0]![0][0].file).toBe(png); expect(submit).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[aria-label="Stop"]')).toHaveLength(0);
  });
  it("requires explicit selected-model image support and preserves inline intent when a model no longer allows it", async () => {
    const file = new File([new Uint8Array([1, 2])], "picture.png", { type: "image/png" }); const submit = vi.fn(), configure = vi.fn();
    function AttachmentHarness({ allowed }: { allowed: boolean }) { const [attachments, setAttachments] = useState<readonly import("./model").PendingAttachment[]>([{ id: "draft-image", label: file.name, file, declaredMediaType: "image/png", delivery: "offload" }]); return <Composer value="Inspect this image" onChange={vi.fn()} onSubmit={() => submit(attachments)} mode="execute" onModeChange={vi.fn()} attachments={attachments} onAttachmentsChange={setAttachments} attachmentsAvailable imageInputAvailable={allowed} onConfigureImageInput={configure} />; }
    await act(async () => root.render(<AttachmentHarness allowed={false} />));
    const visibleCheckbox = () => container.querySelector<HTMLInputElement>('.unified-composer > .attachment-composer input[type="checkbox"]')!;
    expect(visibleCheckbox().disabled).toBe(true); expect(visibleCheckbox().checked).toBe(false); expect(container.textContent).toContain("Image input is not enabled for this model."); await click("Model image settings"); expect(configure).toHaveBeenCalledOnce();
    await act(async () => root.render(<AttachmentHarness allowed />)); expect(visibleCheckbox().disabled).toBe(false); await act(async () => visibleCheckbox().click()); expect(visibleCheckbox().checked).toBe(true); await click("Send message"); expect(submit).toHaveBeenCalledWith([expect.objectContaining({ file, delivery: "inline" })]);
    await act(async () => root.render(<AttachmentHarness allowed={false} />)); expect(visibleCheckbox().checked).toBe(true); expect(visibleCheckbox().disabled).toBe(true); expect(button("Send message").disabled).toBe(true); expect(submit).toHaveBeenCalledOnce();
    await click("Use as file attachment"); expect(visibleCheckbox().checked).toBe(false); expect(button("Send message").disabled).toBe(false); await click("Send message"); expect(submit).toHaveBeenLastCalledWith([expect.objectContaining({ file, delivery: "offload" })]);
  });
  it("saves only explicitly declared image-capable models in the configured model set, without treating a passed connection test as image proof", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const connection = { connection_id: "one", label: "Provider", revision: 4, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "gpt-4.1-mini", models: ["gpt-4.1-mini", "text-only"], has_key: true, source: "profile" as const, writable: true, test: { status: "passed" as const, code: "connection_ok", message: "Connected", model: "gpt-4.1-mini", checked_at: "2026-10-03T00:00:00.000Z", duration_ms: 1 } };
    client.getModelConnections = vi.fn(async () => ({ default_connection_id: "one", connections: [connection] })); client.saveModelConnection = vi.fn(async (_input) => ({ default_connection_id: "one", connections: [connection] })); client.testModelConnection = vi.fn();
    await act(async () => root.render(<ModelConnectionsSettings client={client} capabilities={caps(["models.read", "models.write", "models.test"])} online />)); await click("Edit connection");
    const checkbox = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Enable image input for ${name}"]`)!;
    expect(checkbox("gpt-4.1-mini").checked).toBe(false); expect(container.textContent).toContain("A connection test does not validate image support.");
    await act(async () => { checkbox("gpt-4.1-mini").click(); checkbox("text-only").click(); }); await type(container.querySelector<HTMLTextAreaElement>('[aria-label="Connection model list"]')!, "gpt-4.1-mini"); await click("Save connection");
    expect(client.saveModelConnection).toHaveBeenCalledWith(expect.objectContaining({ connection_id: "one", expected_revision: 4, models: ["gpt-4.1-mini"], image_input_models: ["gpt-4.1-mini"] })); expect(client.testModelConnection).not.toHaveBeenCalled();
  });
  it("does not advertise unsupported reasoning levels or prematurely label a pending grant Full", async () => {
    const options: SessionRunOptions = { mode: "execute", permission_preset: "full-write", reasoning_effort: "default", connection_id: "one", model: "unknown" };
    const connections = { default_connection_id: "one", connections: [{ connection_id: "one", label: "Custom", revision: 0, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "unknown", models: ["unknown"], has_key: true, source: "profile" as const, writable: true, reasoning_by_model: { unknown: ["default" as const] } }] };
    await act(async () => root.render(<><ComposerModelMenu connections={connections} options={options} disabled={false} active onChange={vi.fn()} onSettings={vi.fn()} /><ComposerPermissionMenu options={options} permission={null} grant={{ enabled: true, can_grant: true, ceiling: "workspace-write", source: "profile", pending_restart: true }} disabled={false} active onChange={vi.fn()} onGrant={vi.fn()} /></>));
    expect(button("Choose permissions").textContent).toContain("Workspace access"); await click("Choose model"); await click("Reasoning effort"); expect([...container.querySelectorAll('[role="option"]')].map((node) => node.textContent)).toEqual(["Default"]); expect(container.textContent).not.toContain("Maximum");
  });
  it("normalizes reasoning when selecting a different model and closes the popover with focus restored", async () => {
    const change = vi.fn();
    const options: SessionRunOptions = { mode: "execute", permission_preset: "workspace-write", reasoning_effort: "max", connection_id: "one", model: "strong" };
    const connections = { default_connection_id: "one", connections: [{ connection_id: "one", label: "Provider", revision: 1, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "strong", models: ["strong", "basic"], has_key: true, source: "profile" as const, writable: true, reasoning_by_model: { strong: ["default" as const, "max" as const], basic: ["default" as const] } }] };
    await act(async () => root.render(<ComposerModelMenu connections={connections} options={options} disabled={false} active onChange={change} onSettings={vi.fn()} />));
    await click("Choose model"); await click("basic"); expect(change).toHaveBeenCalledWith({ connection_id: "one", model: "basic", reasoning_effort: "default" });
    await click("Choose model"); await act(async () => button("strong").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); expect(button("Choose model").getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(button("Choose model"));
  });
  it("uses the first saved provider for an empty conversation without reopening legacy setup", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const original = createDemoSnapshot("ready"); const snapshot = { ...original, dataSource: "live" as const, run: null, project: null, selectedSessionId: null }; client.getSnapshot = () => snapshot;
    const capability = caps(["models.read", "model.configure"]); client.getCapabilities = vi.fn(async () => capability);
    client.getModelConnections = vi.fn<NonNullable<WorkbenchClient["getModelConnections"]>>(async () => ({ default_connection_id: "saved-one", connections: [{ connection_id: "saved-one", label: "Saved provider", revision: 1, provider: "custom", protocol: "openai-chat-completions", base_url: "http://127.0.0.1/v1", model: "saved-model", models: ["saved-model"], has_key: true, source: "profile", writable: true }] }));
    await act(async () => root.render(<App client={client} />));
    expect(button("Choose model").textContent).toContain("saved-model"); expect(container.querySelector('[aria-label="Set up Outlive Agent"]')).toBeNull();
    await type(container.querySelector('[aria-label="Plain chat message"]')!, "Start with this saved connection"); expect(button("Send message").disabled).toBe(false);
  });
  it.each([false, true])("connects the selected saved model's image declaration to the common composer and exact new-chat payload: %s", async (declared) => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const snapshot = { ...createDemoSnapshot("ready"), dataSource: "live" as const, run: null, project: null, selectedSessionId: null }; client.getSnapshot = () => snapshot;
    client.getCapabilities = vi.fn(async () => caps(["models.read", "model.configure", "attachments.upload"]));
    client.getModelConnections = vi.fn(async () => ({ default_connection_id: "saved-one", connections: [{ connection_id: "saved-one", label: "Provider", revision: 1, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "selected-model", models: ["selected-model"], has_key: true, source: "profile" as const, writable: true, ...(declared ? { image_input_models: ["selected-model"] } : {}) }] })); client.startChat = vi.fn(async () => undefined);
    await act(async () => root.render(<App client={client} />));
    const file = new File([new Uint8Array([1, 2])], "picture.png", { type: "image/png" }); const input = container.querySelector<HTMLInputElement>('[data-composer-surface="unified"] input[type="file"]')!; Object.defineProperty(input, "files", { configurable: true, value: [file] }); await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const checkbox = container.querySelector<HTMLInputElement>('.unified-composer > .attachment-composer input[type="checkbox"]')!; expect(checkbox.disabled).toBe(!declared); if (declared) await act(async () => checkbox.click());
    await type(container.querySelector('[aria-label="Plain chat message"]')!, "Inspect this supplied file"); await click("Send message"); expect(client.startChat).toHaveBeenCalledWith("Inspect this supplied file", "default", [expect.objectContaining({ file, delivery: declared ? "inline" : "offload" })], expect.objectContaining({ connection_id: "saved-one", model: "selected-model" }));
  });
  it("clears only the selected saved credential while preserving its model metadata", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const connection = { connection_id: "one", label: "Private", revision: 4, provider: "custom" as const, protocol: "openai-chat-completions" as const, base_url: "http://127.0.0.1/v1", model: "model", models: ["model"], image_input_models: ["model"], has_key: true, source: "profile" as const, writable: true };
    client.getModelConnections = vi.fn<NonNullable<WorkbenchClient["getModelConnections"]>>(async () => ({ default_connection_id: "one", connections: [connection] }));
    client.saveModelConnection = vi.fn<NonNullable<WorkbenchClient["saveModelConnection"]>>(async () => ({ default_connection_id: "one", connections: [{ ...connection, revision: 5, has_key: false }] })); client.testModelConnection = vi.fn(); vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<ModelConnectionsSettings client={client} capabilities={caps(["models.read", "models.write", "models.test"])} online />)); expect(button("Test model connection").disabled).toBe(false);
    await click("Clear API key"); expect(client.saveModelConnection).toHaveBeenCalledWith({ command_id: expect.any(String), connection_id: "one", expected_revision: 4, label: "Private", provider: "custom", protocol: "openai-chat-completions", base_url: "http://127.0.0.1/v1", model: "model", models: ["model"], image_input_models: ["model"], clear_key: true }); expect(button("Test model connection").disabled).toBe(true); expect(client.testModelConnection).not.toHaveBeenCalled(); expect(container.textContent).toContain("API key cleared.");
  });
  it("saves next-run options for the exact session while leaving the running snapshot unchanged", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const original = client.getSnapshot().run!;
    client.getSessionRunOptions = vi.fn<NonNullable<WorkbenchClient["getSessionRunOptions"]>>(async () => ({ session_id: "s-one", revision: 8, options: { mode: "execute", reasoning_effort: "default", permission_preset: "workspace-write" } }));
    client.updateSessionRunOptions = vi.fn<NonNullable<WorkbenchClient["updateSessionRunOptions"]>>(async (_id, input) => ({ session_id: "s-one", revision: 9, options: input.options }));
    function OptionsHarness() { const state = useConversationOptions({ client, scope: "s-one", sessionId: "s-one", online: true, capabilities: capability, refreshKey: 0 }); return <button onClick={() => void state.update({ mode: "plan" })}>{state.options.mode}</button>; }
    const capability = caps(["session.options.read", "session.options.write"]);
    await act(async () => root.render(<OptionsHarness />)); await click("execute");
    expect(client.updateSessionRunOptions).toHaveBeenCalledWith("s-one", expect.objectContaining({ expected_revision: 8, options: { mode: "plan", permission_preset: "workspace-write", reasoning_effort: "default" } })); expect(container.textContent).toBe("plan"); expect(client.getSnapshot().run).toBe(original);
  });
  it("does not query or offer final-answer feedback at an approval gate", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); client.getAnswerFeedback = vi.fn(); const snapshot = createDemoSnapshot("needs_approval");
    await act(async () => root.render(<ChatView client={client} runId="pending-run" feedbackReadable feedbackWritable dataSource="live" conversation={[]} events={snapshot.run!.events} task={snapshot.run!.task} status="needs_approval" changedFiles={[]} evidence={snapshot.evidence} />));
    expect(client.getAnswerFeedback).not.toHaveBeenCalled(); expect(button("Helpful answer")).toBeUndefined(); expect(container.querySelector(".turn-changed-files")).toBeNull();
  });
  it("records feedback against the canonical final answer and uses a real copy callback", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); client.copyText = vi.fn<NonNullable<WorkbenchClient["copyText"]>>(async () => undefined); client.getAnswerFeedback = vi.fn<NonNullable<WorkbenchClient["getAnswerFeedback"]>>(async () => ({ run_id: "run-one", answer_event_id: "final-event", value: "clear" })); client.setAnswerFeedback = vi.fn<NonNullable<WorkbenchClient["setAnswerFeedback"]>>(async (runId, input) => ({ run_id: runId, answer_event_id: input.answer_event_id, value: input.value, receipt_event_id: "feedback-receipt" }));
    await act(async () => root.render(<MessageActions text="Public final answer" runId="run-one" client={client} feedbackReadable feedbackWritable />)); await click("Helpful answer"); expect(client.setAnswerFeedback).toHaveBeenCalledWith("run-one", { command_id: expect.any(String), answer_event_id: "final-event", value: "like" });
    await click("Helpful answer"); expect(client.setAnswerFeedback).toHaveBeenLastCalledWith("run-one", expect.objectContaining({ value: "clear", answer_event_id: "final-event" })); expect(container.textContent).toContain("Feedback saved on this device."); await click("Copy message"); expect(client.copyText).toHaveBeenCalledWith("Public final answer"); expect(container.textContent).toContain("Copied");
  });
  it("does not call an offline settings transport unsupported or replace it with empty Memory", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const snapshot = { ...createDemoSnapshot("ready"), connection: { state: "offline" as const, message: "Disconnected", lastSequence: 3 } }; client.getSnapshot = () => snapshot; client.getCapabilities = vi.fn(async () => { throw new Error("CONNECTION_OFFLINE"); });
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} initialCategory="model" /></LanguageProvider>));
    expect(container.textContent).toContain("Reconnect to load your settings."); expect(container.textContent).not.toContain("This feature is unavailable on this installation."); expect(button("Repair connection").disabled).toBe(false);
  });
  it("does not show permanent loading or an empty record list when Memory access is unavailable", async () => {
    const list = vi.fn();
    await act(async () => root.render(<MemoryControlPanel readable={false} onClose={vi.fn()} onList={list} onCreate={vi.fn()} onReview={vi.fn()} onCorrect={vi.fn()} onRevoke={vi.fn()} onDelete={vi.fn()} onListExperiences={vi.fn()} onReviewExperience={vi.fn()} />));
    expect(list).not.toHaveBeenCalled(); expect(container.textContent).toContain("Memory access is unavailable with the current permissions."); expect(container.textContent).not.toContain("Loading…"); expect(container.textContent).not.toContain("No V2 Memory records yet.");
  });
  it("shows a failed Memory read as a recoverable failure, never an empty list or unsupported jobs", async () => {
    const list = vi.fn(async () => { throw new Error("MEMORY_READ_FAILED"); });
    await act(async () => root.render(<MemoryControlPanel onClose={vi.fn()} onList={list} onCreate={vi.fn()} onReview={vi.fn()} onCorrect={vi.fn()} onRevoke={vi.fn()} onDelete={vi.fn()} onListExperiences={vi.fn()} onReviewExperience={vi.fn()} />));
    expect(container.textContent).toContain("Your memories could not be loaded. Try again."); expect(container.textContent).not.toContain("No V2 Memory records yet.");
    await click("Background consolidation"); expect(container.textContent).toContain("Background jobs could not be loaded. Try again."); expect(container.textContent).not.toContain("This Host does not provide job status.");
    expect(list).toHaveBeenCalledOnce();
  });
  it("reviews CAS save approval and reconciles an uncertain write using its original command", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const file = { project_id: "p", path: "a.ts", sha256: hash, kind: "text" as const, byte_length: 3, content: "old" };
    client.listProjectFiles = vi.fn<NonNullable<WorkbenchClient["listProjectFiles"]>>(async () => ({ project_id: "p", path: "", entries: [{ path: "a.ts", name: "a.ts", kind: "file" }], truncated: false })); client.readProjectFile = vi.fn<NonNullable<WorkbenchClient["readProjectFile"]>>(async () => file);
    let intent: ProjectFileSaveRequest | undefined; client.saveProjectFile = vi.fn<NonNullable<WorkbenchClient["saveProjectFile"]>>(async (_id, input) => { intent = input; return { command_id: input.command_id, project_id: "p", path: input.path, status: input.approval ? "unknown" : "awaiting_approval", code: "save-receipt", expected_sha256: hash, content_sha256: hash, approval_id: "approval-one" }; }); client.reconcileProjectFileSave = vi.fn<NonNullable<WorkbenchClient["reconcileProjectFileSave"]>>(async (_id, input) => ({ command_id: input.command_id, project_id: "p", path: "a.ts", status: "succeeded", code: "save-completed", expected_sha256: hash, content_sha256: hash, receipt_event_id: "file-saved" }));
    await act(async () => root.render(<ProjectFiles client={client} projectId="p" sessionId="s" capabilities={caps(["files.list", "files.read", "files.save", "files.reconcile"])} readOnly={false} online />)); await click("a.ts");
    const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!; await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "new" } })); await click("Save"); const first = intent!;
    expect(client.saveProjectFile).toHaveBeenCalledOnce(); expect(first).toMatchObject({ path: "a.ts", expected_sha256: hash, content: "new", session_id: "s" }); expect(container.textContent).toContain("Approve saving exactly this edited content"); await click("Approve save"); expect(client.saveProjectFile).toHaveBeenLastCalledWith("p", { ...first, approval: { approval_id: "approval-one", decision: "approve" } });
    await click("Inspect save result"); expect(client.reconcileProjectFileSave).toHaveBeenCalledWith("p", { command_id: first.command_id }); expect(client.saveProjectFile).toHaveBeenCalledTimes(2); expect(container.textContent).toContain("file-saved");
  });
  it.each([
    { admission: "rejected", status: 401, body: { error: "capability_invalid" } },
    { admission: "rejected", code: "mutation_preflight_failed", commandDispatched: false },
  ])("preserves a definitively rejected save and requires connection repair plus an explicit same-intent retry: %j", async (failure) => {
    const client: WorkbenchClient = new DemoTraceGraphClient();
    const file = { project_id: "p", path: "a.ts", sha256: hash, kind: "text" as const, byte_length: 3, content: "old" };
    client.listProjectFiles = vi.fn(async () => ({ project_id: "p", path: "", entries: [{ path: "a.ts", name: "a.ts", kind: "file" as const }], truncated: false }));
    let saved = false;
    client.readProjectFile = vi.fn(async () => saved ? { ...file, content: "new" } : file);
    client.reconnect = vi.fn(async () => undefined);
    client.reconcileProjectFileSave = vi.fn();
    client.saveProjectFile = vi.fn<NonNullable<WorkbenchClient["saveProjectFile"]>>().mockRejectedValueOnce(Object.assign(new Error("Connection rejected"), failure)).mockImplementationOnce(async (_id, input) => { saved = true; return { command_id: input.command_id, project_id: "p", path: input.path, status: "succeeded", code: "saved", expected_sha256: hash, content_sha256: hash, receipt_event_id: "save-receipt" }; });
    await act(async () => root.render(<ProjectFiles client={client} projectId="p" sessionId="s" capabilities={caps(["files.list", "files.read", "files.save", "files.reconcile"])} readOnly={false} online />)); await click("a.ts");
    const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
    await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "new" } })); await click("Save");
    const original = vi.mocked(client.saveProjectFile).mock.calls[0]![1];
    expect(editor.state.doc.toString()).toBe("new"); expect(container.textContent).toContain("The save was not accepted."); expect(container.textContent).not.toContain("The save outcome is unknown"); expect(button("Inspect save result")).toBeUndefined(); expect(button("Retry save").disabled).toBe(true); expect(client.saveProjectFile).toHaveBeenCalledOnce();
    await click("Repair connection"); expect(client.reconnect).toHaveBeenCalledOnce(); expect(client.readProjectFile).toHaveBeenCalledTimes(2); expect(client.saveProjectFile).toHaveBeenCalledOnce(); expect(client.reconcileProjectFileSave).not.toHaveBeenCalled(); expect(button("Retry save").disabled).toBe(false);
    await click("Retry save"); expect(client.saveProjectFile).toHaveBeenLastCalledWith("p", original); expect(client.saveProjectFile).toHaveBeenCalledTimes(2); expect(editor.state.doc.toString()).toBe("new"); expect(container.textContent).toContain("save-receipt");
  });
  it.each([
    new Error("Response lost after the write was admitted"),
    Object.assign(new Error("Unauthorized without admission evidence"), { status: 401, body: { error: "capability_invalid" } }),
    Object.assign(new Error("An unrelated 401"), { admission: "rejected", status: 401, body: { error: "provider_authentication_failed" } }),
    Object.assign(new Error("A server error"), { admission: "rejected", status: 500, body: { error: "capability_invalid" } }),
  ])("never permits a normal retry for an opaque or unrelated save failure: %s", async (failure) => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const file = { project_id: "p", path: "a.ts", sha256: hash, kind: "text" as const, byte_length: 3, content: "old" };
    client.listProjectFiles = vi.fn(async () => ({ project_id: "p", path: "", entries: [{ path: "a.ts", name: "a.ts", kind: "file" as const }], truncated: false })); client.readProjectFile = vi.fn(async () => file); client.saveProjectFile = vi.fn(async () => { throw failure; }); client.reconnect = vi.fn();
    await act(async () => root.render(<ProjectFiles client={client} projectId="p" capabilities={caps(["files.list", "files.read", "files.save", "files.reconcile"])} readOnly={false} online />)); await click("a.ts");
    const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!; await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "new" } })); await click("Save");
    expect(editor.state.doc.toString()).toBe("new"); expect(container.textContent).toContain("The save outcome is unknown"); expect(button("Inspect save result")).toBeDefined(); expect(button("Retry save")).toBeUndefined(); expect(button("Save").disabled).toBe(true); expect(client.saveProjectFile).toHaveBeenCalledOnce(); expect(client.reconnect).not.toHaveBeenCalled();
  });
  it("keeps a successful save receipt authoritative when only the following file refresh is rejected", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const file = { project_id: "p", path: "a.ts", sha256: hash, kind: "text" as const, byte_length: 3, content: "old" };
    client.listProjectFiles = vi.fn(async () => ({ project_id: "p", path: "", entries: [{ path: "a.ts", name: "a.ts", kind: "file" as const }], truncated: false }));
    client.readProjectFile = vi.fn<NonNullable<WorkbenchClient["readProjectFile"]>>().mockResolvedValueOnce(file).mockRejectedValueOnce(Object.assign(new Error("Refresh rejected"), { admission: "rejected", status: 401, body: { error: "capability_invalid" } })).mockResolvedValueOnce({ ...file, content: "new" });
    client.saveProjectFile = vi.fn(async (_id, input) => ({ command_id: input.command_id, project_id: "p", path: input.path, status: "succeeded" as const, code: "saved", expected_sha256: hash, content_sha256: hash, receipt_event_id: "save-receipt" }));
    await act(async () => root.render(<ProjectFiles client={client} projectId="p" capabilities={caps(["files.list", "files.read", "files.save", "files.reconcile"])} readOnly={false} online />)); await click("a.ts");
    const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!; await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "new" } })); await click("Save");
    expect(container.textContent).toContain("save-receipt"); expect(container.textContent).not.toContain("The save outcome is unknown"); expect(button("Retry save")).toBeUndefined(); expect(button("Save").disabled).toBe(true); expect(editor.state.doc.toString()).toBe("new");
    await click("Reload file"); expect(client.saveProjectFile).toHaveBeenCalledOnce(); expect(editor.state.doc.toString()).toBe("new"); expect(button("Save").disabled).toBe(true);
  });
});
