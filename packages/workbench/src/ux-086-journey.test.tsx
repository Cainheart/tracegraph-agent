// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { HostCapabilitiesSchema } from "@tracegraph/contracts";
import { DemoTraceGraphClient, type WorkbenchClient } from "./client";
import { createDemoSnapshot } from "./demo";
import type { WorkbenchSnapshot } from "./model";

let container: HTMLDivElement;
let root: Root;

function journeyClient(initial: WorkbenchSnapshot) {
  let current = initial;
  const listeners = new Set<(snapshot: WorkbenchSnapshot) => void>();
  const client: WorkbenchClient = new DemoTraceGraphClient();
  client.getCapabilities = vi.fn(async () => HostCapabilitiesSchema.parse({ profile_id: "test", protocol_version: "test", capabilities: [{ operation: "project.defaults.read", state: "available", scope: "project" }] }));
  client.getProjectRunDefaults = vi.fn<NonNullable<WorkbenchClient["getProjectRunDefaults"]>>(async (projectId) => ({ project_id: projectId, revision: 0, overrides: {}, options: { mode: "execute", reasoning_effort: "default", permission_preset: "workspace-write" }, fields: [] }));
  const publish = (snapshot: WorkbenchSnapshot) => {
    current = snapshot;
    for (const listener of listeners) listener(snapshot);
  };
  client.getSnapshot = () => current;
  client.getModelConfig = vi.fn(async () => ({ provider: "custom" as const, protocol: "openai-chat-completions" as const, model: "fixture-model", base_url: "http://127.0.0.1:18001/v1", configured: true, has_key: true }));
  client.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  client.startChat = vi.fn(async (task) => publish({ ...createDemoSnapshot("running"), dataSource: "live", project: null, run: { ...createDemoSnapshot("running").run!, task } }));
  client.startRun = vi.fn(async (task) => publish({ ...createDemoSnapshot("running"), dataSource: "live", run: { ...createDemoSnapshot("running").run!, task } }));
  client.chooseProjectById = vi.fn(async () => publish({ ...createDemoSnapshot("ready"), dataSource: "live" }));
  client.submitUserInput = vi.fn(async (kind, body) => publish({ ...current, run: { ...current.run!, inputQueue: { pending: [{ input_id: "input-guidance", run_id: current.run!.id, kind, body, actor: "user", submitted_at: "2026-10-03T00:00:00.000Z" }] } } }));
  client.stop = vi.fn(async () => publish({ ...current, run: { ...current.run!, status: "cancelled", currentStep: "Cancellation settled" } }));
  client.openSession = vi.fn(async (id) => publish({ ...createDemoSnapshot("completed"), dataSource: "live", sessions: current.sessions, selectedSessionId: id, sessionViewState: "restored" }));
  client.searchSessions = vi.fn(async () => undefined);
  client.returnHome = vi.fn(async () => publish({ ...createDemoSnapshot("empty"), dataSource: "live" }));
  return { client, publish };
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function type(label: string, text: string) {
  const editor = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  expect(editor).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return editor;
}
async function key(target: EventTarget, input: KeyboardEventInit) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...input })));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  window.localStorage.setItem("tracegraph.language", "en");
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("UX-086 shared Workbench journeys", () => {
  it("submits a plain conversation, queues guidance, cancels, and exposes a failed follow-up for retry", async () => {
    const { client } = journeyClient({ ...createDemoSnapshot("empty"), dataSource: "live" });
    await act(async () => root.render(<App client={client} />));
    expect(container.textContent).toContain("Start using Outlive");
    expect(container.textContent).not.toContain("No project filesystem or command access");
    expect(container.querySelector(".entry-suggestions")).toBeNull();
    expect(container.textContent).not.toContain("effort.low");
    await click(button("Choose model"));
    await click(button("Reasoning effort"));
    expect([...container.querySelectorAll(".model-reasoning-levels button")].map((node) => node.textContent?.trim())).toContain("Default");
    await key(container.querySelector(".composer-model-menu")!, { key: "Escape" });
    expect(button("Choose model").getAttribute("aria-expanded")).toBe("false");
    const editor = await type("Plain chat message", "Explain safe retries");
    await key(editor, { key: "Enter", shiftKey: true });
    await key(editor, { key: "Enter", isComposing: true });
    expect(client.startChat).not.toHaveBeenCalled();
    await key(editor, { key: "Enter" });
    expect(client.startChat).toHaveBeenCalledWith("Explain safe retries", undefined, [], {});
    expect(container.querySelector(".chat-view")).not.toBeNull();
    expect(container.querySelector('[aria-label="Workbench views"]')).toBeNull();
    const guidance = await type("Steer this run", "Inspect cancellation next");
    await key(guidance, { key: "Enter" });
    expect(client.submitUserInput).toHaveBeenCalledWith("message", "Inspect cancellation next");
    expect(container.textContent).toContain("Inspect cancellation next");
    await click(button("Stop"));
    expect(client.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Cancellation settled");
    client.startChat = vi.fn(async () => { throw new Error("Provider unavailable; configure a model"); });
    const followup = await type("New task", "Try the task again");
    await key(followup, { key: "Enter" });
    expect([...container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(" ")).toContain("Provider unavailable");
    expect(followup.value).toBe("Try the task again");
    expect(button("Send message").disabled).toBe(false);
  });

  it("preserves existing sessions while removing pins, and inspects evidence without replay", async () => {
    const session = { session_id: "session-one", project_id: "project_fixture", created_at: "2026-10-03T00:00:00.000Z", updated_at: "2026-10-03T00:00:00.000Z", title: "Recover this investigation", run_ids: ["run-one"], entry_count: 3 };
    const { client, publish } = journeyClient({ ...createDemoSnapshot("empty"), dataSource: "live", sessions: [session] });
    await act(async () => root.render(<App client={client} />));
    expect(container.querySelector('[aria-label="Pinned sessions"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Pin session:"]')).toBeNull();
    const selected = container.querySelector<HTMLButtonElement>(".session-list .session-card")!;
    await click(selected);
    expect(client.openSession).toHaveBeenCalledWith("session-one");
    expect(container.textContent).not.toContain("Recovered session view");
    expect(container.querySelector(".chat-view")).not.toBeNull();
    expect(container.querySelector('[aria-label="Workbench views"]')).toBeNull();
    const process = container.querySelector<HTMLButtonElement>(".chat-process-toggle")!;
    expect(process.getAttribute("aria-expanded")).toBe("false");
    const enterReplay = vi.spyOn(client, "enterReplay");
    await click(process);
    const groupSummary = container.querySelector<HTMLElement>(".chat-operation-group > summary")!;
    await click(groupSummary);
    const activity = container.querySelector<HTMLElement>(".chat-operation")!;
    await click(activity.querySelector<HTMLButtonElement>(".chat-operation-toggle")!);
    await click(button("Open event details"));
    expect(enterReplay).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Event inspector"]')).not.toBeNull();
    await key(window, { key: "Escape" });
    expect(container.querySelector('[aria-label="Event inspector"]')).toBeNull();
    await key(window, { key: "b", ctrlKey: true });
    expect(container.querySelector(".desktop-app")?.classList.contains("navigation-closed")).toBe(true);
    await key(window, { key: "k", ctrlKey: true });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 5)); });
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Search commands and sessions"]'));
    await key(window, { key: "Escape" });
    await key(window, { key: ",", ctrlKey: true });
    expect(container.querySelector('[aria-label="Settings"]')).not.toBeNull();
    await key(window, { key: "Escape" });
    await act(async () => publish({ ...createDemoSnapshot("ready"), dataSource: "live" }));
    expect(container.textContent).toContain("Start using Outlive");
    const task = await type("Task", "Inspect the imports");
    await key(task, { key: "Enter" });
    expect(client.startRun).toHaveBeenCalledWith("Inspect the imports", "execute", undefined, [], { mode: "execute" });
  });

  it("lets a keyboard user select any changed file and inspect its linked diff and architecture evidence", async () => {
    const { client } = journeyClient({ ...createDemoSnapshot("completed"), dataSource: "live" });
    await act(async () => root.render(<App client={client} />));
    await click(button("Review changes"));
    const fileButtons = [...container.querySelectorAll<HTMLButtonElement>(".changed-file-list button")];
    expect(fileButtons.length).toBeGreaterThan(1);
    const path = client.getSnapshot().changedFiles[1]!.path;
    await click(fileButtons[1]!);
    expect(container.querySelector('.review-workspace')?.classList.contains("mobile-panel-diff")).toBe(true);
    expect(container.querySelector(".diff-header code")?.textContent).toBe(path);
    await click(button("Architecture"));
    expect(container.querySelector('.review-workspace')?.classList.contains("mobile-panel-graph")).toBe(true);
  });

  it("keeps a project task unavailable when its actual Host is offline", async () => {
    const snapshot = createDemoSnapshot("ready");
    const { client } = journeyClient({ ...snapshot, dataSource: "live", connection: { ...snapshot.connection, state: "offline", message: "Local Host is unavailable" } });
    await act(async () => root.render(<App client={client} />));
    expect(container.textContent).toContain("Let's get you connected");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Task"]')?.disabled).toBe(true);
    expect(button("Send message").disabled).toBe(true);
    expect(client.startRun).not.toHaveBeenCalled();
  });
});
