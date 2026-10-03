import { ClientProtocolMessageSchema, type ClientProtocolMessage } from "../protocol/index.js";
import { CLIENT_PROTOCOL_VERSION } from "../protocol/constants.js";

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGES_PER_CHUNK = 512;

export class FramedRpcTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FramedRpcTransportError";
    this.code = code;
  }
}

export class ProtocolVersionMismatchError extends FramedRpcTransportError {
  readonly expectedVersion: string;
  readonly receivedVersion: string;

  constructor(expectedVersion: string, receivedVersion: string) {
    super(
      "unsupported_version",
      `Protocol version mismatch: expected ${expectedVersion}, received ${receivedVersion}`,
    );
    this.name = "ProtocolVersionMismatchError";
    this.expectedVersion = expectedVersion;
    this.receivedVersion = receivedVersion;
  }
}

export function encodeProtocolFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Uint8Array {
  assertFrameLimit(maxFrameBytes);
  const message = ClientProtocolMessageSchema.parse(value);
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (payload.byteLength === 0 || payload.byteLength > maxFrameBytes) {
    throw new FramedRpcTransportError("frame_too_large", "Protocol frame exceeds the configured size limit");
  }
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

export function parseClientProtocolMessage(value: unknown): ClientProtocolMessage {
  if (isRecord(value) && typeof value.protocol_version === "string" && value.protocol_version !== CLIENT_PROTOCOL_VERSION) {
    throw new ProtocolVersionMismatchError(CLIENT_PROTOCOL_VERSION, value.protocol_version);
  }
  const parsed = ClientProtocolMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new FramedRpcTransportError("invalid_message", "Frame did not match the client protocol contract");
  }
  return parsed.data;
}

/** Incremental, bounded decoder for 4-byte big-endian length-prefixed JSON frames. */
export class FramedMessageDecoder {
  readonly #maxFrameBytes: number;
  #pending = new Uint8Array(0);

  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    assertPositiveLimit(maxFrameBytes, "maxFrameBytes");
    if (maxFrameBytes > 0xffff_ffff) throw new RangeError("maxFrameBytes exceeds the framing limit");
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): unknown[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new FramedRpcTransportError("invalid_chunk", "Transport chunks must be Uint8Array values");
    }
    const messages: unknown[] = [];
    let offset = 0;

    if (this.#pending.byteLength > 0) {
      if (this.#pending.byteLength < 4) {
        offset = this.#appendUntil(chunk, offset, 4);
        if (this.#pending.byteLength < 4) return messages;
      }
      const expectedBytes = this.#readPendingLength() + 4;
      if (this.#pending.byteLength < expectedBytes) {
        offset = this.#appendUntil(chunk, offset, expectedBytes);
        if (this.#pending.byteLength < expectedBytes) return messages;
      }
      messages.push(decodePayload(this.#pending.subarray(4, expectedBytes)));
      this.#pending = new Uint8Array(0);
    }

    while (offset < chunk.byteLength) {
      const remaining = chunk.byteLength - offset;
      if (remaining < 4) {
        this.#pending = chunk.slice(offset);
        break;
      }
      const payloadBytes = readFrameLength(chunk, offset, this.#maxFrameBytes);
      const frameBytes = payloadBytes + 4;
      if (remaining < frameBytes) {
        this.#pending = chunk.slice(offset);
        break;
      }
      messages.push(decodePayload(chunk.subarray(offset + 4, offset + frameBytes)));
      offset += frameBytes;
      if (messages.length > MAX_MESSAGES_PER_CHUNK) {
        throw new FramedRpcTransportError("frame_batch_too_large", "A transport chunk contains too many frames");
      }
    }
    return messages;
  }

  finish(): void {
    if (this.#pending.byteLength === 0) return;
    const code = this.#pending.byteLength < 4 ? "truncated_frame_header" : "truncated_frame_payload";
    this.#pending = new Uint8Array(0);
    throw new FramedRpcTransportError(code, "Transport ended in the middle of a protocol frame");
  }

  #appendUntil(chunk: Uint8Array, offset: number, targetBytes: number): number {
    const count = Math.min(targetBytes - this.#pending.byteLength, chunk.byteLength - offset);
    if (count <= 0) return offset;
    const next = new Uint8Array(this.#pending.byteLength + count);
    next.set(this.#pending);
    next.set(chunk.subarray(offset, offset + count), this.#pending.byteLength);
    this.#pending = next;
    return offset + count;
  }

  #readPendingLength(): number {
    return readFrameLength(this.#pending, 0, this.#maxFrameBytes);
  }
}

/** Serializes writes, bounds queued bytes, and waits for WHATWG stream backpressure. */
export class FramedFrameWriter {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #maxFrameBytes: number;
  readonly #maxQueuedBytes: number;
  #queuedBytes = 0;
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;
  #closed = false;

  constructor(
    writable: WritableStream<Uint8Array>,
    options: { maxFrameBytes?: number; maxQueuedBytes?: number } = {},
  ) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    assertFrameLimit(this.#maxFrameBytes);
    assertPositiveLimit(this.#maxQueuedBytes, "maxQueuedBytes");
    this.#writer = writable.getWriter();
  }

  write(message: ClientProtocolMessage): Promise<void> {
    if (this.#closed) return Promise.reject(new FramedRpcTransportError("transport_closed", "RPC writer is closed"));
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    const frame = encodeProtocolFrame(message, this.#maxFrameBytes);
    if (this.#queuedBytes + frame.byteLength > this.#maxQueuedBytes) {
      return Promise.reject(new FramedRpcTransportError("backpressure_overflow", "RPC writer queue exceeded its byte limit"));
    }
    this.#queuedBytes += frame.byteLength;
    const write = this.#tail.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      await this.#writer.ready;
      await this.#writer.write(frame);
    });
    this.#tail = write.then(
      () => undefined,
      (error: unknown) => { this.#failure = error; },
    );
    return write.finally(() => { this.#queuedBytes -= frame.byteLength; });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    if (this.#failure !== undefined) throw this.#failure;
    await this.#writer.close();
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writer.abort(reason);
  }
}

function readFrameLength(bytes: Uint8Array, offset: number, maxFrameBytes: number): number {
  const payloadBytes = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
  if (payloadBytes === 0) throw new FramedRpcTransportError("empty_frame", "Protocol frames cannot be empty");
  if (payloadBytes > maxFrameBytes) {
    throw new FramedRpcTransportError("frame_too_large", "Protocol frame exceeds the configured size limit");
  }
  return payloadBytes;
}

function decodePayload(payload: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return JSON.parse(text) as unknown;
  } catch {
    throw new FramedRpcTransportError("invalid_json", "Frame payload is not valid UTF-8 JSON");
  }
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

function assertFrameLimit(value: number): void {
  assertPositiveLimit(value, "maxFrameBytes");
  if (value > 0xffff_ffff) throw new RangeError("maxFrameBytes exceeds the framing limit");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
