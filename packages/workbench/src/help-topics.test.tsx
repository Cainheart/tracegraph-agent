// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema } from "@tracegraph/contracts";
import { LanguageProvider } from "./i18n";
import { WorkbenchHelp, helpTopics } from "./components/WorkbenchHelp";

let node: HTMLDivElement, root: Root;
const caps = HostCapabilitiesSchema.parse({ profile_id: "help-profile", protocol_version: "test", capabilities: [{ operation: "computer.read", state: "available", scope: "profile" }, { operation: "computer.action", state: "policy-denied", scope: "project", reason: "Human input control is not granted" }, { operation: "goals.read", state: "readonly", scope: "project" }, { operation: "usage.daily", state: "available", scope: "profile" }] });
const find = (label: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label)!;
const click = async (label: string) => { expect(find(label)).toBeDefined(); await act(async () => find(label).click()); };
const search = async (value: string) => { const input = node.querySelector<HTMLInputElement>("input")!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); window.localStorage.setItem("tracegraph.language", "en"); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });

describe("Help guides real local capabilities without performing actions", () => {
  it("points project selection to the sidebar and Browser permission to the real Workspace controls", async () => {
    const settings = vi.fn(); await act(async () => root.render(<LanguageProvider><WorkbenchHelp capabilities={caps} online onClose={vi.fn()} onSettings={settings} /></LanguageProvider>));
    expect(node.querySelector("article ol")!.textContent).toContain("Select a project in the sidebar");
    await click("Use an isolated browser");
    expect(node.querySelector("article ol")!.textContent).toContain("Workspace tools → Browser → Browser permissions");
    expect(node.querySelector("article")!.textContent).toContain("does not open a visible browser window");
    expect(node.querySelector("article")!.textContent).not.toContain("open Browser settings and request permission");
    expect(settings).not.toHaveBeenCalled(); await click("Open related settings"); expect(settings).toHaveBeenCalledExactlyOnceWith("browser");
  });
  it("explains real Skills and screenshot commands while related actions navigate without dispatching", async () => {
    const settings=vi.fn();await act(async()=>root.render(<LanguageProvider><WorkbenchHelp capabilities={caps} online onClose={vi.fn()} onSettings={settings}/></LanguageProvider>));
    await click("Retain and clean screenshots");expect(node.querySelectorAll("article dd")).toHaveLength(6);expect(node.querySelector("article")!.textContent).toContain("Opening this page only reads records");expect(settings).not.toHaveBeenCalled();await click("Open related settings");expect(settings).toHaveBeenLastCalledWith("memory");
    await click("Manage local Skills");expect(node.querySelector("article")!.textContent).toContain("Removal keeps the local file");await click("Open related settings");expect(settings).toHaveBeenLastCalledWith("skills");expect(helpTopics.find(topic=>topic.id==="skills")!.operations).toEqual(["skills.manage.read","skills.manage.write","skills.manage.validate","skills.manage.reconcile"]);
  });
  it("distinguishes read availability from denied input and routes only explicit navigation to Computer settings", async () => {
    const settings = vi.fn(); await act(async () => root.render(<LanguageProvider><WorkbenchHelp capabilities={caps} online onClose={vi.fn()} onSettings={settings} /></LanguageProvider>)); await click("Control a native application");
    const details = node.querySelector("article")!.textContent!; expect(details).toContain("computer.readavailable"); expect(details).toContain("computer.actionpolicy-denied"); expect(details).toContain("Human input control is not granted"); expect(details).toContain("Posted input only confirms delivery, not business success."); expect(settings).not.toHaveBeenCalled(); await click("Open related settings"); expect(settings).toHaveBeenCalledExactlyOnceWith("computer");
  });

  it("never labels stale available capabilities as connected while offline", async () => {
    await act(async () => root.render(<LanguageProvider><WorkbenchHelp capabilities={caps} online={false} onClose={vi.fn()} onSettings={vi.fn()} /></LanguageProvider>)); await click("Control a native application"); expect(node.querySelectorAll("article dd")).toHaveLength(6); expect([...node.querySelectorAll("article dd")].every((value) => value.textContent?.startsWith("Connection unavailable"))).toBe(true);
  });

  it("supports English technical searches in Chinese and keeps Goal/settings/public-data recovery limits discoverable", async () => {
    window.localStorage.setItem("tracegraph.language", "zh-CN"); const settings = vi.fn(); await act(async () => root.render(<LanguageProvider><WorkbenchHelp capabilities={caps} online onClose={vi.fn()} onSettings={settings} /></LanguageProvider>)); await search("computer"); expect(node.querySelector('.help-content nav button')).not.toBeNull();
    await search("run_project_command"); expect(node.querySelector("article")!.textContent).toContain("run_project_command"); await act(async () => node.querySelector<HTMLButtonElement>("article > button")!.click()); expect(settings).toHaveBeenLastCalledWith("developer");
    for (const [id, operations, category] of [["goals", ["goals.read", "goals.write"], "tasks"], ["profile", ["personal.read", "personal.write", "personal.reconcile"], "profile"], ["search", ["search.public"], "archive"], ["usage", ["usage.daily", "usage.read"], "usage"], ["settings", ["project.defaults.read", "session.options.read", "settings.history", "settings.restore"], "general"]] as const) { const topic = helpTopics.find((value) => value.id === id)!; expect(topic.operations).toEqual(operations); expect(topic.category).toBe(category); }
    expect(helpTopics.find((value) => value.id === "usage")!.limit).toContain("Missing days are unknown"); expect(helpTopics.find((value) => value.id === "goals")!.limit).toContain("opening this page never resumes work"); expect(helpTopics.find((value) => value.id === "settings")!.limit).toContain("does not restore old credentials or Full grants");
  });
});
