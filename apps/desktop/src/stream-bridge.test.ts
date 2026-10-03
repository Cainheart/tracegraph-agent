import { describe, expect, it, vi } from "vitest";
import type { TraceGraphClient } from "@tracegraph/sdk";
import { CLIENT_PROTOCOL_CONFORMANCE_FIXTURES } from "@tracegraph/sdk/protocol";
import { DesktopStreamManager } from "./stream-bridge.js";

function fixture(name: string): unknown {
  const packet = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES.find((entry) => entry.name === name)?.message;
  if (packet?.kind !== "event") throw new Error("Missing public fixture");
  return packet.event.event;
}
function clientWith(values: unknown[]) {
  const states: AbortSignal[] = [];
  const create = vi.fn(async function* (_id: string, options: { signal: AbortSignal }) {
    states.push(options.signal);
    for (const value of values) yield value;
  });
  return { states, create, client: { streamEvents: create, streamLiveActivities: create, streamModelSurface: create } as unknown as TraceGraphClient };
}

describe("Desktop public stream authority", () => {
  it("rejects a retired owner generation before subscribing and tags all replacement packets",async()=>{
    const {client,create}=clientWith([fixture("event.ledger")]);const manager=new DesktopStreamManager(client,4);
    expect(()=>manager.open(1,{kind:"ledger",run_id:"run-fixture",generation:3})).toThrow("generation");expect(create).not.toHaveBeenCalled();
    const id=manager.open(1,{kind:"ledger",run_id:"run-fixture",generation:4});
    expect(await manager.read(1,id)).toMatchObject({state:"event",generation:4});await manager.closeOwner(1);
  });
  it("forwards each actual stream through its own cursor without polling projections", async () => {
    for (const [kind, name, method, cursor] of [
      ["ledger", "event.ledger", "streamEvents", "afterSequence"],
      ["activity", "event.activity", "streamLiveActivities", "afterSequence"],
      ["model_surface", "event.model_surface", "streamModelSurface", "afterCursor"],
    ] as const) {
      const { client, create } = clientWith([fixture(name)]);
      const manager = new DesktopStreamManager(client);
      const id = manager.open(1, { kind, run_id: "run-fixture", after: 4, reconnect: false });
      expect(create).toHaveBeenCalledWith("run-fixture", expect.objectContaining({ [cursor]: 4, reconnect: false }));
      expect(client[method]).toBe(create);
      await expect(manager.read(1, id)).resolves.toEqual({ state: "event", kind, value: fixture(name),generation:0 });
      await expect(manager.read(1, id)).resolves.toEqual({ state: "end",generation:0 });
      await manager.close(1, id);
    }
  });

  it("drops compatibility private thinking events before IPC serialization", async () => {
    const publicEvent = fixture("event.model_surface") as Record<string, unknown>;
    const { client } = clientWith([{ ...publicEvent, type: "thinking_snapshot", text: "PRIVATE_CHAIN_OF_THOUGHT_DO_NOT_SHOW" }, publicEvent]);
    const manager = new DesktopStreamManager(client);
    const id = manager.open(1, { kind: "model_surface", run_id: "run-fixture" });
    await expect(manager.read(1, id)).resolves.toEqual({ state: "event", kind: "model_surface", value: publicEvent,generation:0 });
    await manager.close(1, id);
  });

  it("isolates renderer stream handles and imposes a bounded subscription count", async () => {
    const { client } = clientWith([]);
    const manager = new DesktopStreamManager(client);
    const ids = Array.from({ length: 12 }, () => manager.open(1, { kind: "ledger", run_id: "run-fixture" }));
    expect(() => manager.open(1, { kind: "ledger", run_id: "run-fixture" })).toThrow("limit");
    await expect(manager.read(2, ids[0])).rejects.toThrow("Unknown");
    await expect(manager.close(2, ids[0])).rejects.toThrow("Unknown");
    await manager.closeOwner(1);
    expect(() => manager.open(1, { kind: "ledger", run_id: "run-fixture" })).not.toThrow();
    await manager.closeOwner(1);
  });

  it("cancels a pending SSE read without cancelling the Run or leaking failure details", async () => {
    const stopped = vi.fn();
    let markEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const client = {
      stop: stopped,
      streamEvents: async function* (_id: string, { signal }: { signal: AbortSignal }) {
        markEntered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("private-token/provider-url");
      },
    } as unknown as TraceGraphClient;
    const manager = new DesktopStreamManager(client);
    const id = manager.open(1, { kind: "ledger", run_id: "run-fixture" });
    const pending = manager.read(1, id);
    await entered;
    await expect(manager.read(1, id)).rejects.toThrow("already pending");
    await manager.closeOwner(1);
    await expect(pending).resolves.toEqual({ state: "end",generation:0 });
    expect(stopped).not.toHaveBeenCalled();
  });

  it("returns a safe failure when the transport fails and rejects injected stream scope", async () => {
    const client = { streamEvents: async function* () { throw new Error("private-bearer"); } } as unknown as TraceGraphClient;
    const manager = new DesktopStreamManager(client);
    const id = manager.open(1, { kind: "ledger", run_id: "run-fixture" });
    await expect(manager.read(1, id)).resolves.toEqual({ state: "error", message: "The Host public stream disconnected",generation:0 });
    expect(() => manager.open(1, { kind: "ledger", run_id: "run-fixture", profile_root: "/untrusted" })).toThrow();
    await manager.closeOwner(1);
  });
});
