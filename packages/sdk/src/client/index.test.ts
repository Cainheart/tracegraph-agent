import { describe, expect, it } from "vitest";
import { ClientProtocolMessageSchema, type ClientQuery } from "../protocol/index.js";
import type { FramedRpcDuplex } from "../transport/duplex.js";
import { FramedMessageDecoder, encodeProtocolFrame, ProtocolVersionMismatchError } from "../transport/framing.js";
import { FramedRpcClient } from "./index.js";

function duplexPair(): { client: FramedRpcDuplex; peer: FramedRpcDuplex } {
  const clientToPeer = new TransformStream<Uint8Array, Uint8Array>();
  const peerToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: { readable: peerToClient.readable, writable: clientToPeer.writable },
    peer: { readable: clientToPeer.readable, writable: peerToClient.writable },
  };
}

function rawFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

const query: ClientQuery = {
  operation: "session.list",
  input: { project_id: "project-fixture", view: "roots", limit: 25 },
};

describe("framed RPC client", () => {
  it("fails closed when the peer replies with an unsupported protocol version", async () => {
    const { client: clientDuplex, peer } = duplexPair();
    const rpc = new FramedRpcClient(clientDuplex);
    const peerReader = peer.readable.getReader();
    const peerWriter = peer.writable.getWriter();
    const response = rpc.query(query, { requestId: "request-version-mismatch" });
    const decoder = new FramedMessageDecoder();
    let request: ReturnType<typeof ClientProtocolMessageSchema.parse> | undefined;
    while (request === undefined) {
      const result = await peerReader.read();
      if (result.done) throw new Error("Client closed before writing its query");
      const messages = decoder.push(result.value);
      if (messages.length > 0) request = ClientProtocolMessageSchema.parse(messages[0]);
    }
    expect(request).toMatchObject({ kind: "query", request_id: "request-version-mismatch" });
    await peerWriter.write(rawFrame({
      protocol_version: "tracegraph.client-protocol.v1",
      kind: "reply",
      request_id: "request-version-mismatch",
      result: { resource: "sessions", value: { sessions: [] } },
    }));

    await expect(response).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    peerReader.releaseLock();
    peerWriter.releaseLock();
  });

  it("enforces a finite number of pending requests", async () => {
    const rpc = new FramedRpcClient({
      readable: new ReadableStream<Uint8Array>({}),
      writable: new WritableStream<Uint8Array>(),
    }, { maxPendingRequests: 1 });
    const first = rpc.query(query, { requestId: "request-pending-first" });
    void first.catch(() => undefined);
    await expect(rpc.query(query, { requestId: "request-pending-second" }))
      .rejects.toMatchObject({ code: "backpressure_overflow" });
    await rpc.close();
    await expect(first).rejects.toMatchObject({ name: "ClientRpcClosedError" });
  });
});
