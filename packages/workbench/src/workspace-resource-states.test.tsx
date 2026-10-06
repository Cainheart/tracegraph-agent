// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, WorkbenchResourcesSchema, type HostCapabilities } from "@tracegraph/contracts";
import { DemoTraceGraphClient } from "./client";
import { createDemoSnapshot } from "./demo";
import { LanguageProvider } from "./i18n";
import type { WorkbenchSnapshot } from "./model";
import { WorkspaceResources } from "./components/WorkspaceResources";

let container: HTMLDivElement;
let root: Root;
const caps = (state: HostCapabilities["capabilities"][number]["state"] = "available", reason?: string) => HostCapabilitiesSchema.parse({
  profile_id: "profile:isolated", protocol_version: "test", capabilities: [
    { operation: "resources.read", state: "available", scope: "profile" },
    { operation: "terminal.create", state, scope: "project", ...(reason ? { reason } : {}) },
    { operation: "preview.start", state, scope: "project", ...(reason ? { reason } : {}) },
    { operation: "preview.register", state, scope: "project", ...(reason ? { reason } : {}) },
  ],
});
const resources = () => WorkbenchResourcesSchema.parse({ runs: [], terminals: [], previews: [], schedules: [], archived_session_ids: [] });
const button = (name: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name);
  if (!element) throw new Error(`Missing button: ${name}`);
  return element;
};
const liveSnapshot = (): WorkbenchSnapshot => ({ ...createDemoSnapshot("ready"), dataSource: "live" });
function clientFixture() {
  const client = new DemoTraceGraphClient();
  client.getCapabilities = vi.fn(async () => caps());
  client.getWorkbenchResources = vi.fn(async () => resources());
  client.workbenchCommand = vi.fn(async (input) => ({ command_id: input.command_id, status: "succeeded" as const, code: "accepted", message: "Verified receipt" }));
  return client;
}
async function render(client: DemoTraceGraphClient, snapshot: WorkbenchSnapshot, tab: "terminal" | "preview" = "terminal") {
  await act(async () => root.render(<LanguageProvider><WorkspaceResources client={client} snapshot={snapshot} initialTab={tab} embedded onClose={vi.fn()} onOpenSession={vi.fn()} /></LanguageProvider>));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe("workspace resource guidance follows scope and verified authority", () => {
  it("asks a plain conversation to select a project despite advertised terminal and preview support", async () => {
    const client = clientFixture(), snapshot = { ...liveSnapshot(), project: null };
    await render(client, snapshot);
    expect(button("New terminal").title).toBe("Choose a project first");
    expect(container.querySelector(".resource-availability")?.textContent).toBe("Choose a project first");
    await act(async () => button("New terminal").click());
    // Remount to switch the embedded tab exactly as the parent panel does.
    await act(async () => root.render(<LanguageProvider><WorkspaceResources key="preview" client={client} snapshot={snapshot} initialTab="preview" embedded onClose={vi.fn()} onOpenSession={vi.fn()} /></LanguageProvider>));
    expect(button("Connect existing service").title).toBe("Choose a project first");
    await act(async () => button("Connect existing service").click());
    expect(client.workbenchCommand).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("does not advertise");
  });
  it("reports a pending capability read and only submits once the selected project is verified", async () => {
    const client = clientFixture(); let release!: (value: HostCapabilities) => void;
    client.getCapabilities = vi.fn(() => new Promise<HostCapabilities>((resolve) => { release = resolve; }));
    const snapshot = liveSnapshot(); await render(client, snapshot);
    expect(button("New terminal").title).toBe("Loading workspace resources…");
    await act(async () => button("New terminal").click()); expect(client.workbenchCommand).not.toHaveBeenCalled();
    await act(async () => release(caps()));
    expect(button("New terminal").disabled).toBe(false);
    await act(async () => button("New terminal").click());
    expect(client.workbenchCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "terminal.create", project_id: snapshot.project!.id }));
  });
  it("does not keep stale capabilities actionable after the connection is lost", async () => {
    const client = clientFixture(), snapshot = liveSnapshot(); await render(client, snapshot);
    expect(button("New terminal").disabled).toBe(false);
    const before = vi.mocked(client.getCapabilities).mock.calls.length;
    await render(client, { ...snapshot, connection: { ...snapshot.connection, state: "offline" } });
    expect(button("New terminal").disabled).toBe(true);
    expect(button("New terminal").title).toBe("Reconnect to manage workspace resources.");
    await act(async () => button("New terminal").click());
    expect(client.getCapabilities).toHaveBeenCalledTimes(before); expect(client.workbenchCommand).not.toHaveBeenCalled();
    await render(client, { ...snapshot, connection: { ...snapshot.connection, state: "reconnecting" } });
    expect(button("New terminal").title).toBe("Reconnecting…");
  });
  it.each([
    ["policy-denied", "Current permissions do not allow this workspace action."],
    ["unconfigured", "Configure this feature in Settings before using it."],
    ["unavailable", "This feature is unavailable on this installation."],
  ] as const)("separates %s from missing project scope", async (state, guidance) => {
    const client = clientFixture(); client.getCapabilities = vi.fn(async () => caps(state));
    await render(client, liveSnapshot());
    expect(button("New terminal").disabled).toBe(true); expect(button("New terminal").title).toBe(guidance);
    expect(container.querySelector(".resource-availability")?.textContent).toBe(guidance);
    await act(async () => button("New terminal").click()); expect(client.workbenchCommand).not.toHaveBeenCalled();
  });
  it("preserves a concrete permission explanation returned by the controller", async () => {
    const client = clientFixture(); client.getCapabilities = vi.fn(async () => caps("policy-denied", "Project policy denies command execution"));
    await render(client, liveSnapshot());
    expect(button("New terminal").title).toBe("Project policy denies command execution");
    expect(client.workbenchCommand).not.toHaveBeenCalled();
  });
  it("treats a failed authority read as unverified rather than claiming the installation lacks support", async () => {
    const client = clientFixture(); client.getCapabilities = vi.fn(async () => { throw new Error("Connection expired"); });
    await render(client, liveSnapshot());
    expect(button("New terminal").title).toBe("Workspace resources could not be verified. Refresh or repair the connection before trying again.");
    expect(button("New terminal").disabled).toBe(true); expect(container.textContent).toContain("Connection expired");
    expect(container.textContent).not.toContain("unavailable on this installation");
    expect(client.workbenchCommand).not.toHaveBeenCalled();
  });
  it("uses read-only Replay guidance without starting a resource read or a command", async () => {
    const client = clientFixture(), snapshot = liveSnapshot();
    await render(client, { ...snapshot, replay: { state: "active", runId: "run:past", requestedSequence: 1, headSequence: 2, availableSequences: [1, 2] } });
    expect(button("New terminal").title).toBe("Replay is read-only. Return to now to make changes.");
    await act(async () => button("New terminal").click());
    expect(client.getCapabilities).not.toHaveBeenCalled(); expect(client.workbenchCommand).not.toHaveBeenCalled();
  });
});
