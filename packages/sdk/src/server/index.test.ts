import { describe, expect, it, vi } from "vitest";
import {
  ClientProtocolMessageSchema,
  type ClientQuery,
} from "../protocol/index.js";
import { CLIENT_PROTOCOL_CONFORMANCE_FIXTURES } from "../protocol/fixtures.js";
import type { FramedRpcDuplex } from "../transport/duplex.js";
import { FramedMessageDecoder, encodeProtocolFrame } from "../transport/framing.js";
import { FramedRpcClient } from "../client/index.js";
import { serveFramedRpc } from "./index.js";

function duplexPair(): { client: FramedRpcDuplex; server: FramedRpcDuplex } {
  const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
  const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: { readable: serverToClient.readable, writable: clientToServer.writable },
    server: { readable: clientToServer.readable, writable: serverToClient.writable },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function rawFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

async function readMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const decoder = new FramedMessageDecoder();
  while (true) {
    const result = await reader.read();
    if (result.done) throw new Error("RPC peer closed before sending a frame");
    const messages = decoder.push(result.value);
    if (messages.length > 0) return messages[0];
  }
}

const sessionQuery = (projectId = "project-fixture"): ClientQuery => ({
  operation: "session.list",
  input: { project_id: projectId, view: "roots", limit: 25 },
});

describe("framed RPC server", () => {
  it("dispatches shared queries and sends canonical events over the same framed stream", async () => {
    const { client: clientDuplex, server: serverDuplex } = duplexPair();
    const query = vi.fn(async () => ({ resource: "sessions" as const, value: { sessions: [] } }));
    const command = vi.fn(async () => ({ resource: "sessions" as const, value: { sessions: [] } }));
    const serverTask = serveFramedRpc(serverDuplex, {
      handleCommand: command,
      async handleQuery(input, context) {
        expect(input).toEqual(sessionQuery());
        await context.sendEvent(CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[10]!.message as never);
        return query();
      },
    });
    const rpc = new FramedRpcClient(clientDuplex);
    const events: unknown[] = [];
    rpc.onEvent((message) => { events.push(message); });
    await expect(rpc.query(sessionQuery(), { requestId: "request-session-list" }))
      .resolves.toEqual({ resource: "sessions", value: { sessions: [] } });
    expect(events).toEqual([CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[10]!.message]);
    expect(query).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();

    await rpc.close();
    await serverTask;
  });

  it("returns unsupported_version without dispatching a mismatched envelope", async () => {
    const { client, server } = duplexPair();
    const command = vi.fn(async () => ({ resource: "sessions" as const, value: { sessions: [] } }));
    const query = vi.fn(async () => ({ resource: "sessions" as const, value: { sessions: [] } }));
    const serverTask = serveFramedRpc(server, { handleCommand: command, handleQuery: query });
    const outgoing = client.writable.getWriter();
    const reader = client.readable.getReader();
    await outgoing.write(rawFrame({
      protocol_version: "tracegraph.client-protocol.v0",
      kind: "query",
      request_id: "request-old-version",
      query: sessionQuery(),
    }));

    const response = ClientProtocolMessageSchema.parse(await readMessage(reader));
    expect(response).toMatchObject({
      kind: "error",
      request_id: "request-old-version",
      error: { code: "unsupported_version" },
    });
    expect(command).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    await outgoing.close();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    await serverTask;
  });

  it("aborts only the matching in-flight transport request", async () => {
    const { client: clientDuplex, server: serverDuplex } = duplexPair();
    const signals: AbortSignal[] = [];
    let resolveSecond!: (result: { resource: "sessions"; value: { sessions: [] } }) => void;
    const command = vi.fn(async () => ({ resource: "sessions" as const, value: { sessions: [] } }));
    const serverTask = serveFramedRpc(serverDuplex, {
      handleCommand: command,
      handleQuery: (_query, context) => new Promise((resolve) => {
        const signalIndex = signals.push(context.signal) - 1;
        if (signalIndex === 1) resolveSecond = resolve;
        context.signal.addEventListener("abort", () => {
          if (signalIndex === 0) resolve({ resource: "sessions", value: { sessions: [] } });
        }, { once: true });
      }),
    });
    const client = new FramedRpcClient(clientDuplex, { createRequestId: () => "unused" });
    const cancelController = new AbortController();
    const cancelled = client.query(sessionQuery("project-cancel"), {
      requestId: "request-cancel-one",
      signal: cancelController.signal,
    });
    const continuing = client.query(sessionQuery("project-continue"), { requestId: "request-continue-two" });
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    cancelController.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    expect(signals[1]!.aborted).toBe(false);
    expect(command).not.toHaveBeenCalled();
    resolveSecond!({ resource: "sessions", value: { sessions: [] } });
    await expect(continuing).resolves.toEqual({ resource: "sessions", value: { sessions: [] } });

    await client.close();
    await serverTask;
  });

  it("serializes server replies while the output sink is applying backpressure", async () => {
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const gates: Array<ReturnType<typeof deferred>> = [];
    let writeCount = 0;
    const sink = new WritableStream<Uint8Array>({
      write: async () => {
        writeCount += 1;
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      },
    });
    const serverTask = serveFramedRpc({ readable: clientToServer.readable, writable: sink }, {
      handleCommand: async () => ({ resource: "sessions", value: { sessions: [] } }),
      handleQuery: async () => ({ resource: "sessions", value: { sessions: [] } }),
    });
    const input = clientToServer.writable.getWriter();
    const request = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[7]!.message;
    await input.write(encodeProtocolFrame(request));
    await input.write(encodeProtocolFrame({ ...request, request_id: "request-backpressure-two" }));
    await vi.waitFor(() => expect(writeCount).toBe(1));
    expect(writeCount).toBe(1);
    gates[0]!.resolve();
    await vi.waitFor(() => expect(writeCount).toBe(2));
    gates[1]!.resolve();
    await input.close();
    await serverTask;
  });

  it("rejects requests beyond the configured in-flight bound", async () => {
    const { client, server } = duplexPair();
    const firstStarted = deferred();
    const finishFirst = deferred<{ resource: "sessions"; value: { sessions: [] } }>();
    const serverTask = serveFramedRpc(server, {
      handleCommand: async () => ({ resource: "sessions", value: { sessions: [] } }),
      handleQuery: async () => {
        firstStarted.resolve();
        return finishFirst.promise;
      },
    }, { maxInFlightRequests: 1 });
    const rpc = new FramedRpcClient(client);
    const first = rpc.query(sessionQuery(), { requestId: "request-inflight-first" });
    await firstStarted.promise;
    const second = rpc.query(sessionQuery(), { requestId: "request-inflight-second" });
    await expect(second).rejects.toMatchObject({ protocolError: { code: "unavailable", retryable: true } });
    finishFirst.resolve({ resource: "sessions", value: { sessions: [] } });
    await expect(first).resolves.toEqual({ resource: "sessions", value: { sessions: [] } });
    await rpc.close();
    await serverTask;
  });
});
