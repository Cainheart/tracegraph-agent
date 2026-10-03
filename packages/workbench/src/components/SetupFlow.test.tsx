// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema } from "@tracegraph/contracts";
import { DemoTraceGraphClient, type ModelConfigSnapshot } from "../client";
import { LanguageProvider } from "../i18n";
import { SetupFlow } from "./SetupFlow";
import { NoProject } from "./WorkbenchStates";
import { App } from "../App";
import { createDemoSnapshot } from "../demo";
const configuration: ModelConfigSnapshot = { provider: "custom", protocol: "openai-chat-completions", base_url: "http://127.0.0.1:18000/v1", model: "isolated-model", configured: false, has_key: false };
const caps = (operations = ["model.configure", "model.test"]) => HostCapabilitiesSchema.parse({ profile_id: "isolated", protocol_version: "test", capabilities: operations.map((operation) => ({ operation, scope: "profile", state: "available" })) });
let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); localStorage.setItem("tracegraph.language", "en"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
function button(name: string) { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name); if (!value) throw new Error("Missing " + name); return value; }
async function click(name: string) { await act(async () => button(name).click()); }
async function input(label: string, value: string) { const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function render(client: DemoTraceGraphClient, value = configuration, operations?: string[], finished = vi.fn()) { await act(async () => root.render(<LanguageProvider><SetupFlow client={client} configuration={value} capabilities={caps(operations)} projects={[]} onConfigured={vi.fn()} onClose={vi.fn()} onFinish={finished} /></LanguageProvider>)); return finished; }
async function successfulTest(client: DemoTraceGraphClient) { client.testModel = vi.fn(async () => ({ status: "passed" as const, code: "connection_ok", message: "Tiny request succeeded", checked_at: "2026-10-03T00:00:00.000Z", model: "isolated-model", duration_ms: 2 })); await click("Test connection"); await click("Continue"); }

describe("install and use onboarding", () => {
  it("saves a write-only key, sends no implicit test, and starts plain chat without optional tools or projects", async () => {
    const client = new DemoTraceGraphClient(); client.getCapabilities = vi.fn(async () => caps()); client.configureModel = vi.fn(async () => ({ ...configuration, configured: true, has_key: true }));
    const test = vi.spyOn(client, "testModel"), mcp = vi.spyOn(client, "getMcpStatus"), lsp = vi.spyOn(client, "getLspStatus"), home = vi.spyOn(client, "returnHome");
    const finished = await render(client); await input("Setup API key", "isolated-write-only-key"); await click("Save and continue");
    expect(client.configureModel).toHaveBeenCalledWith({ provider: "custom", protocol: "openai-chat-completions", base_url: configuration.base_url, model: "isolated-model", api_key: "isolated-write-only-key" });
    expect(container.textContent).not.toContain("isolated-write-only-key"); expect(test).not.toHaveBeenCalled(); expect(button("Continue").disabled).toBe(true);
    await successfulTest(client); expect(client.testModel).toHaveBeenCalledWith({ command_id: expect.any(String) }); await click("Start a conversation");
    expect(home).toHaveBeenCalledOnce(); expect(finished).toHaveBeenCalledOnce(); expect(mcp).not.toHaveBeenCalled(); expect(lsp).not.toHaveBeenCalled();
  });
  it("preserves a failed key draft without displaying it in diagnostic copy", async () => {
    const client = new DemoTraceGraphClient(); client.configureModel = vi.fn(async () => { throw new Error("Rejected isolated-write-only-key"); });
    await render(client); await input("Setup API key", "isolated-write-only-key"); await click("Save and continue");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Setup API key"]')!.value).toBe("isolated-write-only-key");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save"); expect(container.textContent).not.toContain("isolated-write-only-key"); expect(container.textContent).toContain("[redacted]");
  });
  it("retains the project step after a native picker cancellation", async () => {
    const client = new DemoTraceGraphClient(); client.openLocalProject = vi.fn(async () => false);
    const finished = await render(client, { ...configuration, configured: true, has_key: true }, ["model.test", "projects.open.native"]);
    await successfulTest(client); await click("Open local folder"); expect(finished).not.toHaveBeenCalled(); expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Choose a project");
  });
  it("blocks a failed actual connection test from advancing and keeps environment-owned keys read-only", async () => {
    const client = new DemoTraceGraphClient(); client.testModel = vi.fn(async () => ({ status: "failed" as const, code: "provider_unreachable", message: "No response", checked_at: "2026-10-03T00:00:00.000Z", model: "isolated-model", duration_ms: 2 }));
    await render(client, { ...configuration, configured: true, has_key: true, credential: { name: "MODEL_KEY", backend: "environment", writable: false } }); await click("Test connection");
    expect(button("Continue").disabled).toBe(true); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't connect"); await click("Edit model");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Setup API key"]')!.disabled).toBe(true); const save = vi.spyOn(client, "configureModel"); await click("Save and continue"); expect(save).not.toHaveBeenCalled();
  });
  it("opens first-use only from an actual unconfigured model response and disables chat until a model is saved", async () => {
    const client = new DemoTraceGraphClient(), snapshot = { ...createDemoSnapshot("empty"), dataSource: "live" as const };
    client.getSnapshot = () => snapshot; client.getModelConfig = vi.fn(async () => configuration); client.getCapabilities = vi.fn(async () => caps());
    await act(async () => root.render(<App client={client} />)); expect(container.querySelector('[aria-label="Set up Outlive Agent"]')).not.toBeNull();
    await click("Return to workbench"); expect(button("Send message").disabled).toBe(true); expect(button("Connect model")).not.toBeNull();
  });
  it("keeps the normal conversation usable with a configured model even when optional integrations are absent", async () => {
    const start = vi.fn(async () => undefined);
    await act(async () => root.render(<LanguageProvider><NoProject modelReady connection={{ state: "live", message: "Ready", lastSequence: 0 }} onStartChat={start} reasoningEffort="low" onReasoningEffortChange={vi.fn()} /></LanguageProvider>));
    const element = container.querySelector<HTMLTextAreaElement>('[aria-label="Plain chat message"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, "Hello"); element.dispatchEvent(new Event("input", { bubbles: true })); }); await click("Send message"); expect(start).toHaveBeenCalledWith("Hello", "low", []);
  });
});
