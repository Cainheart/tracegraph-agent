// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, PersonalProfileSnapshotSchema } from "@tracegraph/contracts";
import { App } from "./App";
import { DemoTraceGraphClient, type WorkbenchClient } from "./client";
import { createDemoSnapshot } from "./demo";
import type { WorkbenchSnapshot } from "./model";

let node: HTMLDivElement, root: Root;
const capability = HostCapabilitiesSchema.parse({ profile_id: "personal-profile", protocol_version: "test", capabilities: ["personal.read", "personal.write", "personal.reconcile", "settings.read"].map((operation) => ({ operation, state: "available", scope: "profile" })) });
const profile = (name: string, command: string | null = null, color: "blue" | "rose" = "blue") => PersonalProfileSnapshotSchema.parse({ schema_version: "outlive.personal-profile.v1", profile_id: "personal-profile", revision: command ? 2 : 1, updated_at: null, last_command_id: command, source: "local", model_transmission: false, values: { display_name: name, bio: "Never pass this private biography into a model", avatar_color: color } });
const fixture = () => { const client: WorkbenchClient = new DemoTraceGraphClient(); let snapshot: WorkbenchSnapshot = { ...createDemoSnapshot("empty"), dataSource: "live", connection: { state: "live", generation: 1, message: "Connected", lastSequence: 0 } }; const listeners = new Set<() => void>(); client.getSnapshot = () => snapshot; client.subscribe = (listener) => { const call = () => listener(snapshot); listeners.add(call); return () => listeners.delete(call); }; client.getCapabilities = vi.fn(async () => capability); client.getModelConfig = vi.fn(async () => ({ provider: "custom" as const, protocol: "openai-chat-completions" as const, model: "fixture", base_url: "http://127.0.0.1:18001/v1", configured: true, has_key: true })); return { client, publish: (patch: Partial<WorkbenchSnapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); } }; };
const trigger = () => node.querySelector<HTMLButtonElement>(".sidebar-account-trigger")!;
const click = async (label: string) => { const control = [...node.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.trim().startsWith(label) || value.getAttribute("aria-label") === label)!; expect(control).toBeDefined(); await act(async () => control.click()); };
const input = async (label: string, value: string) => { const control = node.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en"); node = document.createElement("div"); document.body.append(node); root = createRoot(node); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Saved personal identity in navigation", () => {
  it("refreshes a real saved name and avatar after closing settings without model submission", async () => {
    const { client } = fixture(); let saved = profile("Cain"); client.getPersonalProfile = vi.fn(async () => saved); client.updatePersonalProfile = vi.fn(async (request) => (saved = profile(request.values.display_name, request.command_id, request.values.avatar_color as "rose")));
    const run = vi.spyOn(client, "startRun"), chat = vi.spyOn(client, "startChat"), test = vi.spyOn(client, "testModel"); await act(async () => root.render(<App client={client} />)); expect(trigger().querySelector("strong")!.textContent).toBe("Cain"); expect(trigger().querySelector(".sidebar-account-avatar")!.textContent).toBe("C");
    await act(async () => trigger().click()); expect(node.querySelector(".sidebar-account-profile strong")!.textContent).toBe("Cain"); await click("Settings"); await click("Personal profile"); await input("Profile display name", "私有昵称"); await input("Profile avatar color", "rose"); await click("Save profile"); await click("Back to workbench");
    expect(trigger().querySelector("strong")!.textContent).toBe("私有昵称"); expect(trigger().querySelector(".sidebar-account-avatar")!.textContent).toBe("私"); expect((trigger().querySelector(".sidebar-account-avatar") as HTMLElement).style.backgroundColor).toBe("rgb(179, 92, 114)"); expect(node.textContent).not.toContain("Never pass this private biography"); expect(run).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled(); expect(test).not.toHaveBeenCalled();
  });

  it("rejects an older generation read and clears another client binding before its identity loads", async () => {
    const { client, publish } = fixture(); let old!: (value: ReturnType<typeof profile>) => void; client.getPersonalProfile = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { old = resolve; })).mockResolvedValue(profile("Current owner")); await act(async () => root.render(<App client={client} />)); expect(trigger().querySelector("strong")!.textContent).toBe("Outlive Agent");
    await act(async () => publish({ connection: { state: "live", generation: 2, message: "New owner", lastSequence: 0 } })); await act(async () => old(profile("Stale owner"))); expect(trigger().querySelector("strong")!.textContent).toBe("Current owner");
    const next = fixture(); next.client.getPersonalProfile = vi.fn(() => new Promise<ReturnType<typeof profile>>(() => undefined)); await act(async () => root.render(<App client={next.client} />)); expect(trigger().querySelector("strong")!.textContent).toBe("Outlive Agent"); expect(trigger().querySelector(".sidebar-account-avatar")!.textContent).toBe("O");
  });

  it("does not load private identity through Replay or an offline connection", async () => {
    const { client, publish } = fixture(); client.getPersonalProfile = vi.fn(async () => profile("Must not read")); publish({ replay: { state: "active", runId: "run:old", requestedSequence: 1, headSequence: 1, availableSequences: [1] } }); await act(async () => root.render(<App client={client} />)); expect(client.getPersonalProfile).not.toHaveBeenCalled(); expect(trigger().querySelector("strong")!.textContent).toBe("Outlive Agent");
    const offline = fixture(); offline.client.getPersonalProfile = vi.fn(async () => profile("Must not read offline")); offline.publish({ connection: { state: "offline", generation: 1, message: "Offline", lastSequence: 0 } }); await act(async () => root.render(<App client={offline.client} />)); expect(offline.client.getPersonalProfile).not.toHaveBeenCalled();
  });
});
