// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesSchema, type ImageProviderConfigSnapshot } from "@tracegraph/contracts";
import { DemoTraceGraphClient } from "../client";
import { LanguageProvider } from "../i18n";
import { MediaStudio } from "./MediaStudio";
import { ImageProviderSettings } from "./ImageProviderSettings";
import { GeneratedGallery } from "./GeneratedGallery";
import { ChatView } from "./WorkbenchStates";
import { createDemoSnapshot } from "../demo";
const caps = (...operations: string[]) => HostCapabilitiesSchema.parse({ profile_id: "isolated", protocol_version: "test", capabilities: operations.map((operation) => ({ operation, scope: "profile", state: "available" })) });
const config: ImageProviderConfigSnapshot = { configured: false, has_key: false, protocol: "openai-images", base_url: "http://127.0.0.1:19001/v1", model: "synthetic-image" };
let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); localStorage.setItem("tracegraph.language", "en"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
function button(name: string) { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name); if (!value) throw new Error("Missing " + name); return value; }
async function click(name: string) { await act(async () => button(name).click()); }
async function input(label: string, value: string) { const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function renderStudio(client: DemoTraceGraphClient, open = true, operations = ["media.diagram", "media.chart"], created = vi.fn()) { await act(async () => root.render(<LanguageProvider><MediaStudio client={client} capabilities={caps(...operations)} open={open} onClose={vi.fn()} onSettings={vi.fn()} onCreated={created} /></LanguageProvider>)); return created; }
describe("real media product surfaces", () => {
  it("sends a typed local diagram without model or optional tool configuration", async () => {
    const client = new DemoTraceGraphClient(); client.startMediaRun = vi.fn(async () => undefined); const model = vi.spyOn(client, "getModelConfig"); await client.returnHome(); const created = await renderStudio(client);
    await input("Media title", "Simple flow"); await input("Node label 1", "Input"); await input("Node label 2", "Output"); await click("Create");
    expect(client.startMediaRun).toHaveBeenCalledWith({ command_id: expect.any(String), operation: { kind: "diagram", title: "Simple flow", nodes: [{ id: "node-1", label: "Input" }, { id: "node-2", label: "Output" }], edges: [{ from: "node-1", to: "node-2" }] } }); expect(created).toHaveBeenCalledOnce(); expect(model).not.toHaveBeenCalled();
  });
  it("retains unknown acceptance through closing, retries exactly the same command, and never auto retries", async () => {
    const client = new DemoTraceGraphClient(); const start = vi.fn().mockRejectedValueOnce(new Error("Connection lost after acceptance")).mockResolvedValue(undefined); client.startMediaRun = start;
    await renderStudio(client); await input("Media title", "Flow"); await input("Node label 1", "A"); await input("Node label 2", "B"); await click("Create"); expect(start).toHaveBeenCalledOnce(); expect(container.textContent).toContain("may already have been accepted"); expect(container.querySelector<HTMLInputElement>('[aria-label="Media title"]')!.disabled).toBe(true);
    await renderStudio(client, false); await renderStudio(client); await click("Check previous request"); expect(start).toHaveBeenCalledTimes(2); expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0]);
    await click("Create"); expect(start.mock.calls[2]![0].command_id).not.toBe(start.mock.calls[0]![0].command_id);
  });
  it("gates remote images by actual capability and rejects missing chart numbers instead of coercing zero", async () => {
    const client = new DemoTraceGraphClient(); const start = vi.spyOn(client, "startMediaRun"); await renderStudio(client); await click("Image"); expect(button("Create").disabled).toBe(true); expect(container.textContent).toContain("Connect an image provider"); await click("Chart"); await input("Media title", "Chart"); await input("Data label 1", "A"); await input("Data label 2", "B"); await click("Create"); expect(start).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("valid labels and numbers");
  });
  it("keeps image keys write-only and preserves a failed save draft with redacted errors", async () => {
    const client = new DemoTraceGraphClient(); client.getImageConfig = vi.fn(async () => config); client.configureImageProvider = vi.fn(async () => { throw new Error("Rejected disposable-image-key"); });
    await act(async () => root.render(<LanguageProvider><ImageProviderSettings client={client} capabilities={caps("image.read", "image.configure", "image.clear")} /></LanguageProvider>)); await input("Image API Key", "disposable-image-key"); await click("Save image configuration"); expect(client.configureImageProvider).toHaveBeenCalledWith({ protocol: "openai-images", base_url: config.base_url, model: config.model, api_key: "disposable-image-key" }); expect(container.textContent).not.toContain("disposable-image-key"); expect(container.textContent).toContain("[redacted]"); expect(container.querySelector<HTMLInputElement>('[aria-label="Image API Key"]')!.value).toBe("disposable-image-key");
  });
  it("only previews explicit verified content and revokes it when entering Replay", async () => {
    const artifact = { artifactId: "artifact_generated", runId: "run_generated", projectId: "project_generated", mediaType: "image/png" as const, bytes: 3, sha256: "sha256:" + "a".repeat(64), label: "Generated image" };
    const load = vi.fn(async () => ({ artifactId: artifact.artifactId, mediaType: artifact.mediaType, sha256: artifact.sha256, bytes: new Uint8Array([1, 2, 3]) })); Object.assign(URL, { createObjectURL: vi.fn(() => "blob:verified-generated"), revokeObjectURL: vi.fn() });
    const render = async (disabled = false) => act(async () => root.render(<LanguageProvider><GeneratedGallery artifacts={[artifact]} onLoad={load} disabled={disabled} {...(disabled ? { disabledReason: "Return to now to preview generated artifacts." } : {})} /></LanguageProvider>));
    await render(); expect(load).not.toHaveBeenCalled(); await click("Preview generated artifact"); expect(load).toHaveBeenCalledWith("run_generated", "artifact_generated"); expect(container.querySelector("img")?.src).toBe("blob:verified-generated"); expect(container.querySelector("a")?.download).toBe("outlive-artifact_generated.png"); await render(true); expect(container.querySelector("img")).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:verified-generated"); expect(button("Preview generated artifact").disabled).toBe(true);
  });
  it("rejects an Artifact response with a mismatched recorded digest", async () => {
    const artifact = { artifactId: "artifact_generated", runId: "run_generated", projectId: "project_generated", mediaType: "image/png" as const, bytes: 1, sha256: "sha256:" + "a".repeat(64), label: "Generated image" };
    const load = vi.fn(async () => ({ artifactId: artifact.artifactId, mediaType: artifact.mediaType, sha256: "sha256:" + "b".repeat(64), bytes: new Uint8Array([1]) }));
    await act(async () => root.render(<LanguageProvider><GeneratedGallery artifacts={[artifact]} onLoad={load} /></LanguageProvider>)); await click("Preview generated artifact"); expect(container.querySelector("img")).toBeNull(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("verification failed");
  });
  it("keeps offline, Replay and capability denial distinct without loading or downloading content", async () => {
    const artifact = { artifactId: "artifact_generated", runId: "run_generated", projectId: "project_generated", mediaType: "image/png" as const, bytes: 1, sha256: "sha256:" + "a".repeat(64), label: "Generated image" };
    const load = vi.fn();
    for (const reason of ["Reconnect to preview generated artifacts.", "Return to now to preview generated artifacts.", "The current policy denies binary artifact reads."]) {
      await act(async () => root.render(<LanguageProvider><GeneratedGallery artifacts={[artifact]} onLoad={load} disabled disabledReason={reason} /></LanguageProvider>));
      expect(container.textContent).toContain(reason); expect(button("Preview generated artifact").disabled).toBe(true);
      expect(container.querySelector("img")).toBeNull(); expect(container.querySelector("a[download]")).toBeNull();
      if (reason !== "Return to now to preview generated artifacts.") expect(container.textContent).not.toContain("Return to now");
    }
    expect(load).not.toHaveBeenCalled();
    await act(async () => root.render(<LanguageProvider><GeneratedGallery artifacts={[artifact]} disabled /></LanguageProvider>));
    expect(container.textContent).toContain("This feature is unavailable on this installation."); expect(container.textContent).not.toContain("Return to now");
  });
  it("passes the real disconnected reason to both historical and current answer galleries", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const snapshot = createDemoSnapshot("completed");
    const artifact = { artifactId: "artifact_generated", runId: "run_current", projectId: "project_generated", mediaType: "image/png" as const, bytes: 1, sha256: "sha256:" + "a".repeat(64), label: "Generated image" };
    const load = vi.fn();
    await act(async () => root.render(<LanguageProvider><ChatView runId="run_current" conversation={[{ runId: "run_old", task: "Earlier task", response: "Earlier result", status: "completed", events: [], generatedArtifacts: [{ ...artifact, runId: "run_old" }] }]} task="Current task" status="completed" events={[]} dataSource="live" changedFiles={[]} evidence={snapshot.evidence} generatedArtifacts={[artifact]} onLoadGeneratedArtifact={load} generatedPreviewsDisabled generatedPreviewsDisabledReason="Reconnect to preview generated artifacts." /></LanguageProvider>));
    const cards = [...container.querySelectorAll(".generated-card")]; expect(cards).toHaveLength(2);
    for (const card of cards) { expect(card.textContent).toContain("Reconnect to preview generated artifacts."); expect(card.textContent).not.toContain("Return to now"); expect(card.querySelector("button")?.disabled).toBe(true); }
    expect(load).not.toHaveBeenCalled();
  });
});
