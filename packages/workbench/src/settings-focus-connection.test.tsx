// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchSettingsSnapshotSchema, HostCapabilitiesSchema } from "@tracegraph/contracts";
import { App } from "./App";
import { DemoTraceGraphClient, type WorkbenchClient } from "./client";
import { createDemoSnapshot } from "./demo";
import { LanguageProvider } from "./i18n";
import { UnifiedSettings } from "./components/UnifiedSettings";
import type { WorkbenchSnapshot } from "./model";

let node: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); localStorage.setItem("tracegraph.language", "en");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    let visible = !this.closest("[hidden]");
    for (let ancestor = this.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(":scope > summary")?.contains(this)) visible = false;
    }
    return (visible ? [new DOMRect(0, 0, 100, 20)] : []) as unknown as DOMRectList;
  });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });
const button = (name: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name)!;
async function key(target: EventTarget, key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event)); return event;
}
function fixture(initial: WorkbenchSnapshot) {
  let current = initial; const listeners = new Set<() => void>(); const client: WorkbenchClient = new DemoTraceGraphClient();
  client.getSnapshot = () => current;
  client.subscribe = (listener) => { const update = () => listener(current); listeners.add(update); return () => listeners.delete(update); };
  client.getCapabilities = vi.fn(async () => HostCapabilitiesSchema.parse({ profile_id: "test", protocol_version: "test", capabilities: [{ operation: "settings.read", scope: "profile", state: "available" }] }));
  client.getModelConfig = vi.fn(async () => ({ provider: "custom" as const, protocol: "openai-chat-completions" as const, model: "fixture-model", base_url: "http://127.0.0.1:18001/v1", configured: true, has_key: true }));
  client.getWorkbenchSettings = vi.fn(async () => WorkbenchSettingsSnapshotSchema.parse({ config_version: "outlive.workbench.v1", profile_id: "test", revision: 0, settings: { general: { language: "en" } }, fields: [], pending_restart: [] }));
  const publish = async (snapshot: WorkbenchSnapshot) => { await act(async () => { current = snapshot; for (const listener of listeners) listener(); }); };
  return { client, publish };
}

describe("settings modal isolation", () => {
  it("makes the underlying workbench inert, contains escaped focus and restores the untouched draft on close", async () => {
    const { client } = fixture({ ...createDemoSnapshot("empty"), dataSource: "live" });
    await act(async () => root.render(<App client={client} />));
    const composer = node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Plain chat message"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Keep this draft");
      composer.dispatchEvent(new Event("input", { bubbles: true })); composer.focus();
    });
    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })));
    const dialog = node.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]')!;
    expect(node.querySelector(".desktop-app")?.hasAttribute("inert")).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Workspace tools"]')!.focus(); });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, "Escape");
    expect(node.querySelector(".desktop-app")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(composer); expect(composer.value).toBe("Keep this draft");
  });

  it("includes visible disclosure summaries in Tab order and restores an external opener", async () => {
    const { client } = fixture({ ...createDemoSnapshot("empty"), dataSource: "live" });
    const background = createRef<HTMLDivElement>();
    const draw = (open: boolean) => <LanguageProvider><div ref={background}><button id="settings-opener">Open settings</button></div><UnifiedSettings client={client} open={open} background={background} initialCategory="about" onClose={vi.fn()} onMemory={vi.fn()} onApplied={vi.fn()} /></LanguageProvider>;
    await act(async () => root.render(draw(false))); const opener = node.querySelector<HTMLButtonElement>("#settings-opener")!; opener.focus();
    await act(async () => root.render(draw(true)));
    const summary = node.querySelector<HTMLElement>(".installation-diagnostics > summary")!; summary.focus();
    const next = await key(summary, "Tab"); expect(next.defaultPrevented).toBe(true); expect(document.activeElement).toBe(button("Back to workbench"));
    const previous = await key(document.activeElement!, "Tab", true); expect(previous.defaultPrevented).toBe(true); expect(document.activeElement).toBe(summary);
    await act(async () => root.render(draw(false))); expect(document.activeElement).toBe(opener); expect(background.current?.hasAttribute("inert")).toBe(false);
  });
});

describe("initial connection presentation", () => {
  it.each(["empty", "ready"] as const)("shows pending %s connection as loading, then exposes a genuine failed connection", async (state) => {
    const initial = { ...createDemoSnapshot(state), dataSource: "live" as const, connection: { state: "connecting" as const, message: "Health request pending", lastSequence: 0 } };
    const { client, publish } = fixture(initial);
    await act(async () => root.render(<App client={client} />));
    const notice = node.querySelector(".connection-recovery")!;
    expect(notice.getAttribute("role")).toBe("status"); expect(notice.textContent).toContain("Connecting to Outlive Agent…");
    expect(node.textContent).not.toContain("Let's get you connected"); expect(node.querySelector('.connection-recovery button')).toBeNull();
    expect(node.querySelector("textarea")?.placeholder).toBe("Connecting to Outlive Agent…");
    await publish({ ...initial, connection: { state: "offline", message: "Health request failed", lastSequence: 0 } });
    expect(node.querySelector(".connection-recovery")?.getAttribute("role")).toBe("alert");
    expect(node.textContent).toContain("Health request failed"); expect(button("Repair connection").disabled).toBe(false);
  });
});
