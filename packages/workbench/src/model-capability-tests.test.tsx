// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCapabilities, ModelConnection, ModelCapabilityTestRequest, ModelCapabilityTestResult } from "@tracegraph/contracts";
import type { WorkbenchClient } from "./client";
import { ModelCapabilityTests } from "./components/ModelCapabilityTests";
import { ModelConnectionsSettings } from "./components/ModelConnectionsSettings";
const connection: ModelConnection = { connection_id: "connection:fixture", label: "Fixture", revision: 3, model: "model-a", models: ["model-a", "model-b"], provider: "custom", protocol: "openai-chat-completions", base_url: "http://127.0.0.1:1/v1", has_key: true, source: "environment", writable: false };
const capabilities: HostCapabilities = { profile_id: "profile:fixture", protocol_version: "outlive.local-host.v1", capabilities: ["models.capabilities.test", "models.capabilities.read"].map(operation => ({ operation, state: "available", scope: "profile", requires_restart: false })) };
const completed = (id: string): ModelCapabilityTestResult => ({ command_id: id, connection_id: connection.connection_id, connection_revision: 3, model: "model-b", provider: "custom", protocol: connection.protocol, checked_at: "2026-10-05T00:00:00Z", duration_ms: 4, results: [{ feature: "tools", status: "passed", code: "model_probe_passed", duration_ms: 4, dispatched: true, evidence: "native_tool_call", usage_status: "unknown" }] });
let node: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); sessionStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });
const button = (text: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text)!;
const checkbox = (text: string) => [...node.querySelectorAll("label")].find(item => item.textContent?.trim() === text)!.querySelector<HTMLInputElement>("input")!;
const click = async (text: string) => { await act(async () => button(text).click()); };
async function show(client: Partial<WorkbenchClient>, extra: { online?: boolean; connection?: ModelConnection; capabilities?: HostCapabilities; generation?: number } = {}) { await act(async () => root.render(<ModelCapabilityTests client={client as WorkbenchClient} connection={extra.connection ?? connection} capabilities={extra.capabilities ?? capabilities} online={extra.online ?? true} generation={extra.generation} />)); }
describe("explicit model capability controls", () => {
  it("reopens a saved current-revision receipt without a provider request or a fictitious zero cost", async () => {
    const saved = completed("probe:saved"), testModelCapabilities = vi.fn();
    await show({ testModelCapabilities }, { connection: { ...connection, capability_test: saved } });
    expect(node.querySelector('section[aria-label="Model test results"]')).not.toBeNull();
    expect(node.textContent).toContain("model-b · Revision 3");
    expect(node.textContent).toContain("Provider usage: Unknown · Cost: Unknown");
    expect(button("Inspect previous test")).toBeDefined();
    expect(testModelCapabilities).not.toHaveBeenCalled();
  });
  it("sends only selected kinds/model/revision after confirmation, including a read-only environment connection", async () => {
    const testModelCapabilities = vi.fn(async (_id: string, input: ModelCapabilityTestRequest) => completed(input.command_id)); await show({ testModelCapabilities });
    await act(async () => { const select = node.querySelector<HTMLSelectElement>('select[aria-label="Model to test"]')!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "model-b"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => checkbox("Text response").click()); await act(async () => checkbox("Native tool calling").click()); await click("Run selected tests");
    expect(testModelCapabilities).toHaveBeenCalledExactlyOnceWith(connection.connection_id, { command_id: expect.any(String), expected_revision: 3, model: "model-b", features: ["tools"], confirmed: true }); expect(window.confirm).toHaveBeenCalledOnce(); expect(node.textContent).toMatch(/Provider usage: Unknown · Cost: Unknown/u);
  });
  it("clears an environment summary on a live rerender and labels an old same-revision receipt as historical", async () => {
    const saved = { ...completed("probe:old-owner"), model: connection.model };
    const testModelCapabilities = vi.fn(), getModelCapabilityTestReceipt = vi.fn(async () => ({ command_id: saved.command_id, state: "completed" as const, result: saved }));
    const client = { testModelCapabilities, getModelCapabilityTestReceipt };
    await show(client, { generation: 1, connection: { ...connection, capability_test: saved } });
    expect(node.querySelector('section[aria-label="Model test results"]')).not.toBeNull();
    expect(node.textContent).not.toContain("earlier model or configuration");
    await show(client, { generation: 2, connection: { ...connection } });
    expect(node.querySelector('section[aria-label="Model test results"]')).toBeNull();
    await click("Inspect previous test");
    expect(getModelCapabilityTestReceipt).toHaveBeenCalledExactlyOnceWith(saved.command_id);
    expect(node.textContent).toContain("does not verify the current selection");
    expect(testModelCapabilities).not.toHaveBeenCalled();
  });
  it("discards a late old-owner read and refreshes the new model list without retaining a removed selection", async () => {
    const old = { ...connection, capability_test: completed("probe:old") };
    let release!: (value: { connections: ModelConnection[]; default_connection_id: string }) => void;
    const getModelConnections = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue({ connections: [{ ...connection, model: "replacement", models: ["replacement"] }], default_connection_id: connection.connection_id });
    const client = { getModelConnections } as unknown as WorkbenchClient;
    const caps = { ...capabilities, capabilities: [...capabilities.capabilities, { operation: "models.read", state: "available" as const, scope: "profile" as const, requires_restart: false }] };
    await act(async () => root.render(<ModelConnectionsSettings client={client} capabilities={caps} online generation={1} />));
    await act(async () => root.render(<ModelConnectionsSettings client={client} capabilities={caps} online generation={2} />));
    expect(node.textContent).toContain("replacement");
    await act(async () => release({ connections: [old], default_connection_id: connection.connection_id }));
    expect(node.textContent).not.toContain("probe:old");
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="Model to test"]')?.value).toBe("replacement");
    expect(getModelConnections).toHaveBeenCalledTimes(2);
  });
  it("resets a removed model and drops an unsupported schema choice on the same mounted control", async () => {
    const client = { testModelCapabilities: vi.fn() };
    await show(client);
    await act(async () => { const select = node.querySelector<HTMLSelectElement>('select[aria-label="Model to test"]')!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "model-b"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => checkbox("Schema-constrained output").click());
    await show(client, { connection: { ...connection, model: "replacement", models: ["replacement"], protocol: "anthropic-messages" } });
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="Model to test"]')?.value).toBe("replacement");
    expect(checkbox("Schema-constrained output").checked).toBe(false);
    expect(checkbox("Schema-constrained output").disabled).toBe(true);
    expect(client.testModelCapabilities).not.toHaveBeenCalled();
  });
  it("a cancelled confirmation and an unavailable/replay capability never send requests", async () => {
    const testModelCapabilities = vi.fn(); vi.mocked(window.confirm).mockReturnValue(false); await show({ testModelCapabilities }); await click("Run selected tests"); expect(testModelCapabilities).not.toHaveBeenCalled();
    await show({ testModelCapabilities }, { capabilities: { ...capabilities, capabilities: capabilities.capabilities.map(item => ({ ...item, state: "unavailable" })) } }); expect(button("Run selected tests").disabled).toBe(true); expect(testModelCapabilities).not.toHaveBeenCalled();
  });
  it("keeps an uncertain command across remounts, inspects only its original receipt and never auto repeats", async () => {
    const testModelCapabilities = vi.fn(async (_id: string, _input: ModelCapabilityTestRequest) => { throw new TypeError("Lost response"); }), getModelCapabilityTestReceipt = vi.fn(async (id: string) => ({ command_id: id, state: "unknown" as const })); const client = { testModelCapabilities, getModelCapabilityTestReceipt }; await show(client); await click("Run selected tests"); expect(node.textContent).toContain("receipt is uncertain"); expect(testModelCapabilities).toHaveBeenCalledOnce(); await act(async () => root.render(<></>)); await show(client);
    expect(button("Run selected tests").disabled).toBe(true); await click("Inspect previous test"); expect(getModelCapabilityTestReceipt).toHaveBeenCalledExactlyOnceWith(testModelCapabilities.mock.calls[0]![1].command_id); expect(testModelCapabilities).toHaveBeenCalledOnce(); expect(node.textContent).toContain("No settled test receipt");
  });
  it("Anthropic schema format is disabled with its precise boundary and offline controls preserve selections", async () => { await show({}, { connection: { ...connection, protocol: "anthropic-messages" }, online: false }); expect(checkbox("Schema-constrained output").disabled).toBe(true); expect(node.textContent).toContain("not implemented for Anthropic Messages"); expect(node.textContent).toContain("Reconnect before sending"); expect(button("Run selected tests").disabled).toBe(true); });
  it("a closed pre-dispatch revision rejection preserves selected controls and permits an explicit fresh test", async () => { const testModelCapabilities = vi.fn(async () => { throw { status: 409, body: { error: "model_connection_revision_conflict" } }; }); await show({ testModelCapabilities }); await click("Run selected tests"); expect(node.textContent).toContain("refused before a provider request"); expect(button("Run selected tests").disabled).toBe(false); expect(testModelCapabilities).toHaveBeenCalledOnce(); });
});
