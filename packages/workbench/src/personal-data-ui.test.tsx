// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, PersonalProfileSnapshotSchema, PersonalUsageSnapshotSchema, PublicSessionSearchResultSchema, WorkbenchSettingsSnapshotSchema, type DailyUsageBucket, type PublicSessionSearchHit } from "@tracegraph/contracts";
import { DemoTraceGraphClient, type WorkbenchClient } from "./client";
import { LanguageProvider } from "./i18n";
import { PersonalProfile } from "./components/PersonalProfile";
import { UsageOverview, usageActivitySummary } from "./components/UsageOverview";
import { PublicSessionSearch } from "./components/PublicSessionSearch";
import { UnifiedSettings } from "./components/UnifiedSettings";

let node: HTMLDivElement, root: Root;
const caps = HostCapabilitiesSchema.parse({ profile_id: "private-profile", protocol_version: "test", capabilities: ["personal.read", "personal.write", "personal.reconcile", "usage.daily", "search.public", "settings.read", "settings.write"].map((operation) => ({ operation, state: "available", scope: "profile" })) });
const find = (label: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label)!;
const click = async (label: string) => { expect(find(label)).toBeDefined(); await act(async () => find(label).click()); };
const input = async (label: string, value: string) => { const element = node.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; expect(element).not.toBeNull(); await act(async () => { const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); };
const profile = (revision = 1, name = "Cain", command: string | null = null) => PersonalProfileSnapshotSchema.parse({ schema_version: "outlive.personal-profile.v1", profile_id: "private-profile", revision, updated_at: null, last_command_id: command, source: "local", model_transmission: false, values: { display_name: name, bio: "Local notes", avatar_color: "blue" } });
const page = (next_cursor?: string) => ({ as_of: "2026-10-05T02:00:00Z", complete: !next_cursor, inventory_complete: true, scanned_runs: 1, total_scanned_runs: 1, skipped_runs: 0, skipped_events: 0, scan_limit_reached: false, ...(next_cursor ? { next_cursor } : {}) });
const bucket = (day: string, total_tokens = 10, run_count = 1): DailyUsageBucket => ({ day, run_count, completed_runs: run_count, failed_runs: 0, cancelled_runs: 0, interrupted_runs: 0, active_runs: 0, model_call_count: run_count, reported_request_count: run_count, unreported_model_call_count: 0, input_tokens: total_tokens, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens, cost_status: "unknown", costs: [] });
const usage = (tokens: number, next?: string) => { const { day: _day, ...totals } = bucket("2026-10-03", tokens); return PersonalUsageSnapshotSchema.parse({ schema_version: "outlive.personal-usage.v1", source: "ledger", timezone: "UTC", from_day: "2026-10-03", to_day: "2026-10-05", project_count: 1, session_count: 1, totals, days: [bucket("2026-10-03", tokens), bucket("2026-10-05", 0, 0)], page: page(next) }); };
const hit = (event_id: string): PublicSessionSearchHit => ({ project_id: "project-a", session_id: "session-a", run_id: "run-a", event_id, sequence: 1, source: "file", occurred_at: "2026-10-05T01:00:00Z", status: "completed", archived: true, title: "Project task", excerpt: "<img src=x onerror=alert(1)>", path: "src/main.ts" });
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en"); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });

describe("Local personal data surfaces", () => {
  it("saves a private profile with the loaded revision and verifies the original command receipt", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); client.getPersonalProfile = vi.fn(async () => profile());
    client.updatePersonalProfile = vi.fn(async (request) => ({ ...profile(2, request.values.display_name, request.command_id), values: request.values }));
    const run = vi.spyOn(client, "startRun"), provider = vi.spyOn(client, "testModel");
    await act(async () => root.render(<LanguageProvider><PersonalProfile client={client} capabilities={caps} online /></LanguageProvider>)); await input("Profile display name", "Updated Cain"); await click("Save profile");
    expect(client.updatePersonalProfile).toHaveBeenCalledExactlyOnceWith({ command_id: expect.any(String), expected_revision: 1, values: { display_name: "Updated Cain", bio: "Local notes", avatar_color: "blue" } });
    expect(node.textContent).toContain("Your local profile was saved. It is not sent to a model."); expect(find("Save profile").disabled).toBe(true); expect(run).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });

  it("keeps unknown profile updates locked and retains the intended draft even if saved values are observed", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); client.getPersonalProfile = vi.fn(async () => profile()); client.updatePersonalProfile = vi.fn(async () => { throw new Error("personal_profile_save_unknown"); });
    let original = ""; client.getPersonalProfileCommandReceipt = vi.fn(async (id) => { original = id; return { command_id: id, state: "unknown" as const, code: "receipt_missing_after_profile_write", observed_profile: profile(2, "Observed different name", id) }; });
    const draw = (online: boolean, generation: number) => <LanguageProvider><PersonalProfile client={client} capabilities={caps} online={online} generation={generation} /></LanguageProvider>;
    await act(async () => root.render(draw(true, 1))); await input("Profile display name", "Intended draft"); await click("Save profile"); await click("Inspect original profile update");
    expect((node.querySelector('[aria-label="Profile display name"]') as HTMLInputElement).value).toBe("Intended draft"); expect(find("Save profile").disabled).toBe(true); expect(node.textContent).toContain("Observed profile is not a completed receipt"); expect(node.textContent).not.toContain("Your local profile was saved");
    await act(async () => root.render(draw(false, 1))); await act(async () => root.render(draw(true, 2))); expect(client.updatePersonalProfile).toHaveBeenCalledTimes(1);
    client.getPersonalProfileCommandReceipt = vi.fn(async (id) => ({ command_id: id, state: "completed" as const, result: profile(2, "Intended draft", id) })); await click("Inspect original profile update");
    expect(client.getPersonalProfileCommandReceipt).toHaveBeenCalledExactlyOnceWith(original); expect(node.textContent).toContain("It was not repeated."); expect(node.textContent).not.toContain("unknown outcome"); expect(client.updatePersonalProfile).toHaveBeenCalledTimes(1);
  });

  it("preserves a refused CAS draft and requires explicit refresh and a new save", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); client.getPersonalProfile = vi.fn(async () => profile()); client.updatePersonalProfile = vi.fn(async () => { throw { status: 409, body: { error: "personal_profile_revision_conflict" } }; });
    await act(async () => root.render(<LanguageProvider><PersonalProfile client={client} capabilities={caps} online /></LanguageProvider>)); await input("Profile display name", "Keep my draft"); await click("Save profile"); expect(node.textContent).not.toContain("unknown outcome"); expect(find("Save profile").disabled).toBe(false);
    client.getPersonalProfile = vi.fn(async () => profile(3, "Other saved name")); await click("Refresh profile"); expect((node.querySelector('[aria-label="Profile display name"]') as HTMLInputElement).value).toBe("Keep my draft"); expect(client.updatePersonalProfile).toHaveBeenCalledTimes(1);
    client.updatePersonalProfile = vi.fn(async (request) => profile(4, request.values.display_name, request.command_id)); await click("Save profile"); expect(client.updatePersonalProfile).toHaveBeenCalledWith(expect.objectContaining({ expected_revision: 3, values: expect.objectContaining({ display_name: "Keep my draft" }) }));
  });

  it("replaces cumulative usage pages, distinguishes missing dates from zero and never infers missing cost", async () => {
    const cursor = "ce6aa2d4-682f-4d18-a71e-12347aa1cb84", client: WorkbenchClient = new DemoTraceGraphClient(); client.queryPersonalUsage = vi.fn(async (query) => query.cursor ? usage(20) : usage(10, cursor));
    await act(async () => root.render(<LanguageProvider><UsageOverview client={client} capabilities={caps} online /></LanguageProvider>)); await click("Continue usage scan");
    expect(node.querySelectorAll(".usage-overview-metrics strong")[3]?.textContent).toBe("20"); expect(node.querySelector('[title^="2026-10-04"]')?.getAttribute("data-known")).toBe("false"); expect(node.querySelector('[title^="2026-10-05"]')?.getAttribute("data-known")).toBe("true");
    await act(async () => (node.querySelector('[title^="2026-10-04"]') as HTMLButtonElement).click()); expect(node.textContent).toContain("It is not treated as zero usage."); expect(node.textContent).toContain("Reported costs: Unknown"); expect(client.queryPersonalUsage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor }));
    expect(usageActivitySummary([bucket("2026-10-01"), bucket("2026-10-02", 100), bucket("2026-10-04")])).toEqual({ longestActiveStreak: 2, peakTokenDay: "2026-10-02", peakTokens: 100 });
  });

  it("discards an older generation usage response without leaving the new view loading", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); let resolve!: (value: ReturnType<typeof usage>) => void; client.queryPersonalUsage = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue(usage(20));
    const draw = (generation: number) => <LanguageProvider><UsageOverview client={client} capabilities={caps} online generation={generation} /></LanguageProvider>;
    await act(async () => root.render(draw(1))); await act(async () => root.render(draw(2))); await act(async () => resolve(usage(999)));
    expect(node.querySelectorAll(".usage-overview-metrics strong")[3]?.textContent).toBe("20"); expect(node.textContent).not.toContain("Loading recorded usage…");
  });

  it("searches only on explicit submission, appends distinct hits and opens the exact recorded result without model execution", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(), cursor = "ce6aa2d4-682f-4d18-a71e-12347aa1cb84", open = vi.fn(async () => undefined), close = vi.fn();
    client.searchPublicSessions = vi.fn(async (query) => PublicSessionSearchResultSchema.parse({ schema_version: "outlive.public-search.v1", query: query.q, order: "inventory-page", hits: query.cursor ? [hit("event-a"), hit("event-b")] : [hit("event-a")], page: page(query.cursor ? undefined : cursor) })); const run = vi.spyOn(client, "startRun");
    await act(async () => root.render(<LanguageProvider><PublicSessionSearch client={client} capabilities={caps} online onClose={close} onOpenResult={open} /></LanguageProvider>)); expect(client.searchPublicSessions).not.toHaveBeenCalled(); await input("Public history query", "main.ts"); await input("History search archive", "all"); await input("History search status", "completed"); await click("Search"); await click("Continue history scan");
    expect(client.searchPublicSessions).toHaveBeenNthCalledWith(1, { q: "main.ts", archive: "all", limit: 20, status: "completed" }); expect(node.querySelectorAll(".public-search-hit")).toHaveLength(2); expect(node.querySelector("img")).toBeNull(); expect(node.textContent).toContain("<img src=x onerror=alert(1)>");
    await act(async () => (node.querySelector(".public-search-hit") as HTMLButtonElement).click()); expect(open).toHaveBeenCalledExactlyOnceWith(hit("event-a")); expect(close).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
  });

  it("retains search text and loaded hits offline and never opens or repeats the query automatically", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(), open = vi.fn(async () => undefined); client.searchPublicSessions = vi.fn(async (query) => PublicSessionSearchResultSchema.parse({ schema_version: "outlive.public-search.v1", query: query.q, order: "inventory-page", hits: [hit("event-a")], page: page() }));
    const draw = (online: boolean) => <LanguageProvider><PublicSessionSearch client={client} capabilities={caps} online={online} onClose={vi.fn()} onOpenResult={open} /></LanguageProvider>;
    await act(async () => root.render(draw(true))); await input("Public history query", "Keep query"); await click("Search"); await act(async () => root.render(draw(false)));
    expect((node.querySelector('[aria-label="Public history query"]') as HTMLInputElement).value).toBe("Keep query"); expect(node.querySelectorAll(".public-search-hit")).toHaveLength(1); expect((node.querySelector(".public-search-hit") as HTMLButtonElement).disabled).toBe(true); await act(async () => root.render(draw(true))); expect(client.searchPublicSessions).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
  });

  it("saves the opt-in active-task sleep preference through the actual settings CAS and preserves the general section", async () => {
    const client: WorkbenchClient = new DemoTraceGraphClient(); const settings = WorkbenchSettingsSnapshotSchema.parse({ config_version: "outlive.workbench.v1", profile_id: "private-profile", revision: 4, settings: { general: { language: "en", prevent_sleep_during_tasks: false } }, fields: [{ path: "general.prevent_sleep_during_tasks", source: "profile", scope: "profile", effective: "immediate", writable: true }], pending_restart: [] }); client.getCapabilities = vi.fn(async () => caps); client.getWorkbenchSettings = vi.fn(async () => settings); client.updateWorkbenchSettings = vi.fn(async (request) => WorkbenchSettingsSnapshotSchema.parse({ ...settings, revision: 5, settings: { ...settings.settings, general: { ...settings.settings.general, ...request.patch.general } } }));
    await act(async () => root.render(<LanguageProvider><UnifiedSettings client={client} open onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>)); const control = node.querySelector<HTMLInputElement>('[aria-label="Keep this computer awake during active tasks"]')!; expect(control.checked).toBe(false); expect(control.disabled).toBe(false); await act(async () => control.click()); expect(client.updateWorkbenchSettings).toHaveBeenCalledExactlyOnceWith({ command_id: expect.any(String), expected_revision: 4, patch: { general: { ...settings.settings.general, prevent_sleep_during_tasks: true } } });
    expect(node.textContent).toContain("It does not prevent screen locking, lid closure or manual sleep.");
  });

  it("shows one daily usage filter and reads legacy totals only as a compatibility fallback", async () => {
    const currentClient: WorkbenchClient = new DemoTraceGraphClient(); const usageCaps = HostCapabilitiesSchema.parse({ ...caps, capabilities: [...caps.capabilities, { operation: "usage.read", state: "available", scope: "profile" }] }); currentClient.getCapabilities = vi.fn(async () => usageCaps); currentClient.queryPersonalUsage = vi.fn(async () => usage(10)); const oldRead = vi.spyOn(currentClient, "getUsage");
    const draw = (client: WorkbenchClient) => <LanguageProvider><UnifiedSettings client={client} open initialCategory="usage" onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>;
    await act(async () => root.render(draw(currentClient))); expect(node.querySelectorAll(".usage-overview")).toHaveLength(1); expect(node.querySelector('[aria-label="Usage from"]')).toBeNull(); expect(node.querySelector('[aria-label="Usage overview from day"]')).not.toBeNull(); expect(oldRead).not.toHaveBeenCalled();
    const legacy: WorkbenchClient = new DemoTraceGraphClient(); legacy.getCapabilities = vi.fn(async () => ({ ...usageCaps, capabilities: usageCaps.capabilities.filter((value) => value.operation !== "usage.daily") })); const fallback = vi.spyOn(legacy, "getUsage"); await act(async () => root.render(draw(legacy))); expect(node.querySelector(".usage-overview")).toBeNull(); expect(node.querySelector('[aria-label="Usage from"]')).not.toBeNull(); expect(fallback).toHaveBeenCalled();
  });
});
