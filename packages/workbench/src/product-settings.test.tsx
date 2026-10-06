// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, WorkbenchSettingsSnapshotSchema, type ProjectRunDefaultsSnapshot, type WorkbenchSettingsHistory } from "@tracegraph/contracts";
import { DemoTraceGraphClient, type WorkbenchClient } from "./client";
import { LanguageProvider } from "./i18n";
import { SettingsHistory, settingsHistoryDiff } from "./components/SettingsHistory";
import { McpConnectionForm } from "./components/McpConnectionForm";
import { ProjectDefaultsSettings } from "./components/ProjectDefaultsSettings";
import { UnifiedSettings } from "./components/UnifiedSettings";
import { Sidebar } from "./components/Sidebar";
import { createDemoSnapshot } from "./demo";
import { translate } from "@tracegraph/sdk/client";
import { useRunMessage } from "./run-messages";

let node: HTMLDivElement, root: Root;
const caps = (operations: string[]) => HostCapabilitiesSchema.parse({ profile_id: "isolated-profile", protocol_version: "test", capabilities: operations.map((operation) => ({ operation, state: "available", scope: "profile" })) });
const current = () => WorkbenchSettingsSnapshotSchema.parse({ config_version: "outlive.workbench.v1", profile_id: "isolated-profile", revision: 8, settings: {}, fields: [], pending_restart: [] });
const history: WorkbenchSettingsHistory = { profile_id: "isolated-profile", current_revision: 8, has_more: false, entries: [{ revision: 2, command_id: "c-two", operation: "update", occurred_at: "2026-10-05T01:00:00Z", redacted_paths: ["tools.secret_token"], settings: { appearance: { theme: "dark" }, model: { reasoning_effort: "high", credential: "DO_NOT_SHOW_KEY" }, tools: { secret_token: "DO_NOT_SHOW_SECRET" } } }] };
const find = (label: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label)!;
const click = async (label: string) => { expect(find(label)).toBeDefined(); await act(async () => find(label).click()); };
const input = async (label: string, value: string) => { const element = node.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; expect(element).not.toBeNull(); await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en"); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });

describe("Product settings safety and functional controls", () => {
  it("opens existing Browser controls explicitly without requesting permission or running a browser command", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const openBrowser = vi.fn();
    client.getCapabilities = vi.fn(async () => caps(["settings.read", "browser.read", "browser.observe"])); client.getWorkbenchSettings = vi.fn(async () => current());
    client.requestBrowserGrant = vi.fn(); client.browserCommand = vi.fn();
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open initialCategory="browser" onBrowser={openBrowser} onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>));
    expect(node.textContent).toContain("Workspace tools → Browser"); expect(openBrowser).not.toHaveBeenCalled();
    await click("Open browser controls"); expect(openBrowser).toHaveBeenCalledOnce();
    expect(client.requestBrowserGrant).not.toHaveBeenCalled(); expect(client.browserCommand).not.toHaveBeenCalled();
  });
  it("shows all nineteen categories without advertising transport failures as unsupported", async () => {
    const client = new DemoTraceGraphClient(); client.getCapabilities = vi.fn(async () => { throw new Error("Connection reset"); });
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>));
    expect(node.querySelectorAll('nav[aria-label="Settings sections"] button')).toHaveLength(19);
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Connection reset");
    expect(node.textContent).not.toContain("unsupported");
  });

  it("previews safe differences and restores exactly the selected revision with displayed CAS, preserving secrets", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); client.getWorkbenchSettingsHistory = vi.fn(async () => history);
    const applied = vi.fn(); client.restoreWorkbenchSettings = vi.fn(async () => ({ snapshot: { ...current(), revision: 9 }, restored_from_revision: 2, preserved_sections: ["model" as const] })); vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<LanguageProvider><SettingsHistory client={client} capabilities={caps(["settings.history", "settings.restore"])} snapshot={current()} online onApplied={applied} /></LanguageProvider>));
    expect(client.getWorkbenchSettingsHistory).not.toHaveBeenCalled(); await click("Load settings history"); await act(async () => node.querySelector<HTMLButtonElement>(".settings-revision-list button")!.click());
    expect(node.textContent).toContain("appearance.theme"); expect(node.textContent).not.toContain("DO_NOT_SHOW");
    await click("Restore this revision"); expect(client.restoreWorkbenchSettings).toHaveBeenCalledExactlyOnceWith({ command_id: expect.any(String), expected_revision: 8, target_revision: 2 });
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ revision: 9 })); expect(node.textContent).toContain("Preserved current sections: model");
    expect(settingsHistoryDiff({ model: { api_key: "secret", reasoning_effort: "high" } }, { model: { api_key: "other", reasoning_effort: "low" } })).toEqual([{ path: "model.reasoning_effort", before: "high", after: "low" }]);
  });

  it("keeps a refused history restore explicit and never retries or replaces current settings", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); client.getWorkbenchSettingsHistory = vi.fn(async () => history); client.restoreWorkbenchSettings = vi.fn(async () => { throw new Error("settings_revision_conflict"); }); const applied = vi.fn(); vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<LanguageProvider><SettingsHistory client={client} capabilities={caps(["settings.history", "settings.restore"])} snapshot={current()} online onApplied={applied} /></LanguageProvider>)); await click("Load settings history"); await act(async () => node.querySelector<HTMLButtonElement>(".settings-revision-list button")!.click()); await click("Restore this revision");
    expect(applied).not.toHaveBeenCalled(); expect(client.restoreWorkbenchSettings).toHaveBeenCalledOnce(); expect(node.textContent).toContain("settings_revision_conflict"); expect(find("Restore this revision").disabled).toBe(false);
  });

  it("validates remote MCP safely and submits an explicit empty allow list instead of enabling every discovered tool", async () => {
    const save = vi.fn(async () => undefined);
    await act(async () => root.render(<LanguageProvider><McpConnectionForm value={{ config_version: "tracegraph.mcp.v1", servers: [] }} disabled={false} onSave={save} /></LanguageProvider>)); await click("Add MCP server"); await input("MCP server name", "trusted-server"); await input("MCP address", "http://example.com/mcp");
    await act(async () => node.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); expect(save).not.toHaveBeenCalled(); expect(node.querySelector('[role="alert"]')).not.toBeNull();
    await input("MCP address", "https://example.com/mcp"); await input("MCP credential reference", "${secret:MCP_TOKEN}"); await act(async () => node.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledExactlyOnceWith({ config_version: "tracegraph.mcp.v1", servers: [{ name: "trusted-server", transport: "streamable-http", url: "https://example.com/mcp", authorization_ref: "${secret:MCP_TOKEN}", required: false, tool_policy: { allow: [] } }] });
  });

  it("saves only project overrides and preserves an unsaved choice across reconnect", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const initial = client.getSnapshot(); client.getSnapshot = () => ({ ...initial, project: null }); let revision = 3;
    const snapshot = (): ProjectRunDefaultsSnapshot => ({ project_id: "chat:local", revision, overrides: {}, options: { mode: "execute", permission_preset: "workspace-write", reasoning_effort: "default" }, fields: [{ path: "mode", source: "profile", effective: "new-run" }] });
    client.getProjectRunDefaults = vi.fn(async () => snapshot()); client.updateProjectRunDefaults = vi.fn(async (_id, request) => ({ ...snapshot(), revision: ++revision, overrides: request.overrides, options: { ...snapshot().options, ...request.overrides } }));
    const capability = caps(["project.defaults.read", "project.defaults.write"]); const draw = (online: boolean) => <LanguageProvider><ProjectDefaultsSettings client={client} capabilities={capability} online={online} /></LanguageProvider>;
    await act(async () => root.render(draw(true))); await input("Project default: Mode", "plan"); await act(async () => root.render(draw(false))); expect(node.textContent).toContain("Reconnect to inspect project defaults."); await act(async () => root.render(draw(true))); expect(node.querySelector<HTMLSelectElement>('[aria-label="Project default: Mode"]')?.value).toBe("plan");
    await click("Save project defaults"); expect(client.updateProjectRunDefaults).toHaveBeenCalledWith("chat:local", { command_id: expect.any(String), expected_revision: 3, overrides: { mode: "plan" } });
  });

  it("does not transfer late Todo failures from a previous Run onto the current chat", async () => {
    let previous!: (error: string | null) => void;
    function Harness({ run }: { run: string }) { const [message, setMessage] = useRunMessage(run); if (run === "old") previous = setMessage; return <output>{message ?? "No errors"}</output>; }
    await act(async () => root.render(<Harness run="old" />)); await act(async () => root.render(<Harness run="new" />)); await act(async () => previous("Old Todo failed")); expect(node.textContent).toBe("No errors"); await act(async () => root.render(<Harness run="old" />)); expect(node.textContent).toBe("Old Todo failed");
  });
});


describe("Settings section headings",()=>{
 it("shows a category title once but retains section headings for multi-category search",async()=>{
  const client:WorkbenchClient=new DemoTraceGraphClient();client.getCapabilities=vi.fn(async()=>caps(["settings.read"]));client.getWorkbenchSettings=vi.fn(async()=>current());
  await act(async()=>root.render(<LanguageProvider><UnifiedSettings client={client} open initialCategory="general" onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()}/></LanguageProvider>));
  expect([...node.querySelectorAll("h1,h2")].filter(value=>value.textContent==="General")).toHaveLength(1);
  await input("Search settings","settings");expect(node.querySelector(".settings-main h1")!.textContent).toBe("Search results");expect([...node.querySelectorAll(".settings-group > h2")].some(value=>value.textContent==="General")).toBe(true);
 });
});


describe("UI locale date formatting",()=>{
 it("uses selected Chinese for both session and revision dates even when the browser language is English",async()=>{
  window.localStorage.setItem("tracegraph.language","zh-CN");vi.spyOn(window.navigator,"language","get").mockReturnValue("en-US");const dates=vi.spyOn(Date.prototype,"toLocaleString");
  const base=createDemoSnapshot("completed"),snapshot={...base,sessions:[{session_id:"session:locale",project_id:base.project!.id,title:"Date locale fixture",created_at:"2026-10-05T01:41:00Z",updated_at:"2026-10-05T01:41:00Z",run_ids:["run:locale"],entry_count:1}]};
  const client:WorkbenchClient=new DemoTraceGraphClient();client.getWorkbenchSettingsHistory=vi.fn(async()=>history);
  await act(async()=>root.render(<LanguageProvider><Sidebar snapshot={snapshot} onChooseProject={vi.fn()} onSelectProject={vi.fn()} onRemoveProject={vi.fn()} onSearchSessions={vi.fn()} onSelectSession={vi.fn()} onDeleteSession={vi.fn()} onResumeSession={vi.fn()} onReturnHome={vi.fn()} onPreviewState={vi.fn()}/><SettingsHistory client={client} capabilities={caps(["settings.history"])} snapshot={current()} online onApplied={vi.fn()}/></LanguageProvider>));
  expect(node.querySelector(".session-row small")?.textContent).toContain("10月");await click(translate("zh-CN","Load settings history"));expect(node.querySelector(".settings-revision-list span")?.textContent).toMatch(/2026/u);
  expect(dates.mock.calls.length).toBeGreaterThanOrEqual(2);expect(dates.mock.calls.every(call=>call[0]==="zh-CN")).toBe(true);
  expect(client.getWorkbenchSettingsHistory).toHaveBeenCalledOnce();expect(window.navigator.language).toBe("en-US");
 });
});
