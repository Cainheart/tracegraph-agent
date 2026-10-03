import { describe, expect, it, vi } from "vitest";
import { CLIENT_PROTOCOL_CONFORMANCE_FIXTURES } from "../protocol/fixtures.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  FramedFrameWriter,
  FramedMessageDecoder,
  encodeProtocolFrame,
} from "./framing.js";

function concat(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("private framed RPC transport", () => {
  it("decodes arbitrarily split frames and multiple coalesced frames", () => {
    const first = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[0]!.message;
    const second = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[1]!.message;
    const firstFrame = encodeProtocolFrame(first);
    const secondFrame = encodeProtocolFrame(second);
    const decoder = new FramedMessageDecoder();
    const chunks = [
      firstFrame.subarray(0, 1),
      firstFrame.subarray(1, 3),
      firstFrame.subarray(3, 11),
      firstFrame.subarray(11),
      concat(secondFrame, firstFrame),
    ];

    const messages = chunks.flatMap((chunk) => decoder.push(chunk));
    decoder.finish();
    expect(messages).toEqual([first, second, first]);
  });

  it("rejects oversized, empty, malformed, and truncated frames", () => {
    const frame = encodeProtocolFrame(CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[0]!.message);
    expect(() => new FramedMessageDecoder(4).push(frame)).toThrowError(
      expect.objectContaining({ code: "frame_too_large" }),
    );
    expect(() => new FramedMessageDecoder().push(new Uint8Array([0, 0, 0, 0])))
      .toThrowError(expect.objectContaining({ code: "empty_frame" }));
    expect(() => new FramedMessageDecoder().push(new Uint8Array([0, 0, 0, 1, 0xff])))
      .toThrowError(expect.objectContaining({ code: "invalid_json" }));

    const truncated = new FramedMessageDecoder();
    truncated.push(frame.subarray(0, frame.byteLength - 1));
    expect(() => truncated.finish()).toThrowError(
      expect.objectContaining({ code: "truncated_frame_payload" }),
    );
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  it("waits for sink backpressure and bounds queued frame bytes", async () => {
    const first = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[0]!.message;
    const second = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[1]!.message;
    const entered: Array<ReturnType<typeof deferred>> = [];
    const writes = vi.fn(async () => {
      const gate = deferred();
      entered.push(gate);
      await gate.promise;
    });
    const sink = new WritableStream<Uint8Array>({ write: writes });
    const writer = new FramedFrameWriter(sink, { maxQueuedBytes: 32 * 1024 * 1024 });
    const firstWrite = writer.write(first);
    const secondWrite = writer.write(second);

    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    expect(entered).toHaveLength(1);
    entered[0]!.resolve();
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    entered[1]!.resolve();
    await Promise.all([firstWrite, secondWrite]);
    await writer.close();
  });

  it("fails a write before queuing bytes beyond the configured bound", async () => {
    const gate = deferred();
    const sink = new WritableStream<Uint8Array>({ write: async () => gate.promise });
    const message = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[0]!.message;
    const frameBytes = encodeProtocolFrame(message).byteLength;
    const writer = new FramedFrameWriter(sink, { maxQueuedBytes: frameBytes });
    const firstWrite = writer.write(message);
    await expect(writer.write(message)).rejects.toMatchObject({ code: "backpressure_overflow" });
    gate.resolve();
    await firstWrite;
    await writer.close();
  });
});
