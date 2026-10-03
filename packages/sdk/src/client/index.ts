import {
  ClientCancelMessageSchema,
  ClientCommandMessageSchema,
  ClientErrorMessageSchema,
  ClientEventMessageSchema,
  ClientQueryMessageSchema,
  ClientReplyMessageSchema,
  type ClientCommandMessage,
  type ClientEventMessage,
  type ClientProtocolError,
  type ClientQueryMessage,
  type ClientReplyResult,
} from "../protocol/index.js";
import { CLIENT_PROTOCOL_VERSION } from "../protocol/constants.js";
import { FramedMessageDecoder, FramedFrameWriter, FramedRpcTransportError, parseClientProtocolMessage } from "../transport/framing.js";
import type { FramedRpcDuplex } from "../transport/duplex.js";
import type { ClientCommand, ClientQuery } from "../protocol/index.js";

export interface FramedRpcClientOptions {
  readonly maxFrameBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly maxPendingRequests?: number;
  readonly closeTimeoutMs?: number;
  readonly createRequestId?: () => string;
}

export class ClientRpcClosedError extends Error {
  constructor(message = "RPC connection is closed") {
    super(message);
    this.name = "ClientRpcClosedError";
  }
}

export class ClientRpcRemoteError extends Error {
  readonly protocolError: ClientProtocolError;

  constructor(protocolError: ClientProtocolError) {
    super(protocolError.message);
    this.name = "ClientRpcRemoteError";
    this.protocolError = protocolError;
  }
}

interface PendingRequest {
  readonly resolve: (result: ClientReplyResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

type ClientRequestMessage = ClientCommandMessage | ClientQueryMessage;
export type ClientRpcEventListener = (message: ClientEventMessage) => void | Promise<void>;

/** Request/reply client for the private versioned framed protocol. */
export class FramedRpcClient {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: FramedFrameWriter;
  readonly #decoder: FramedMessageDecoder;
  readonly #maxPendingRequests: number;
  readonly #closeTimeoutMs: number;
  readonly #createRequestId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #eventListeners = new Set<ClientRpcEventListener>();
  #closed = false;
  #readTask: Promise<void>;

  constructor(duplex: FramedRpcDuplex, options: FramedRpcClientOptions = {}) {
    const maxPendingRequests = options.maxPendingRequests ?? 16;
    if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests <= 0) {
      throw new RangeError("maxPendingRequests must be a positive safe integer");
    }
    const closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 0) {
      throw new RangeError("closeTimeoutMs must be a non-negative safe integer");
    }
    this.#decoder = new FramedMessageDecoder(options.maxFrameBytes);
    this.#writer = new FramedFrameWriter(duplex.writable, options);
    this.#reader = duplex.readable.getReader();
    this.#maxPendingRequests = maxPendingRequests;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#createRequestId = options.createRequestId ?? (() => `rpc-${globalThis.crypto.randomUUID()}`);
    this.#readTask = this.#readLoop();
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  onEvent(listener: ClientRpcEventListener): { dispose(): void } {
    this.#eventListeners.add(listener);
    return { dispose: () => { this.#eventListeners.delete(listener); } };
  }

  command(command: ClientCommand, options: { signal?: AbortSignal; requestId?: string } = {}): Promise<ClientReplyResult> {
    const requestId = options.requestId ?? this.#createRequestId();
    return this.#request(
      ClientCommandMessageSchema.parse({
        protocol_version: CLIENT_PROTOCOL_VERSION,
        kind: "command",
        request_id: requestId,
        command,
      }),
      options.signal,
    );
  }

  query(query: ClientQuery, options: { signal?: AbortSignal; requestId?: string } = {}): Promise<ClientReplyResult> {
    const requestId = options.requestId ?? this.#createRequestId();
    return this.#request(
      ClientQueryMessageSchema.parse({
        protocol_version: CLIENT_PROTOCOL_VERSION,
        kind: "query",
        request_id: requestId,
        query,
      }),
      options.signal,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new ClientRpcClosedError("RPC client was closed"));
    try {
      await this.#writer.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let peerClosed: boolean;
      try {
        peerClosed = await Promise.race([
          this.#readTask.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), this.#closeTimeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!peerClosed) await this.#reader.cancel().catch(() => undefined);
      await this.#readTask.catch(() => undefined);
    } catch (error) {
      await this.#reader.cancel(error).catch(() => undefined);
      await this.#readTask.catch(() => undefined);
      throw error;
    }
  }

  #request(message: ClientRequestMessage, signal: AbortSignal | undefined): Promise<ClientReplyResult> {
    if (this.#closed) return Promise.reject(new ClientRpcClosedError());
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(new FramedRpcTransportError("backpressure_overflow", "Too many RPC requests are pending"));
    }
    if (this.#pending.has(message.request_id)) {
      return Promise.reject(new FramedRpcTransportError("request_id_conflict", "RPC request id is already in flight"));
    }

    return new Promise<ClientReplyResult>((resolve, reject) => {
      const onAbort = signal === undefined ? undefined : () => {
        const pending = this.#pending.get(message.request_id);
        if (pending === undefined) return;
        this.#pending.delete(message.request_id);
        this.#removeAbortListener(pending);
        reject(createAbortError());
        const cancelMessage = ClientCancelMessageSchema.parse({
          protocol_version: CLIENT_PROTOCOL_VERSION,
          kind: "cancel",
          request_id: message.request_id,
        });
        void this.#writer.write(cancelMessage).catch((error: unknown) => this.#terminate(error));
      };
      const pending: PendingRequest = { resolve, reject, signal, onAbort };
      this.#pending.set(message.request_id, pending);
      signal?.addEventListener("abort", onAbort!, { once: true });
      void this.#writer.write(message).catch((error: unknown) => {
        this.#settleReject(message.request_id, error);
        this.#terminate(error);
      });
    });
  }

  async #readLoop(): Promise<void> {
    try {
      while (!this.#closed) {
        const result = await this.#reader.read();
        if (result.done) {
          this.#decoder.finish();
          this.#terminate(new ClientRpcClosedError("RPC peer closed the connection"));
          return;
        }
        for (const rawMessage of this.#decoder.push(result.value)) {
          const message = parseClientProtocolMessage(rawMessage);
          if (ClientReplyMessageSchema.safeParse(message).success) {
            const reply = ClientReplyMessageSchema.parse(message);
            this.#settleResolve(reply.request_id, reply.result);
            continue;
          }
          if (ClientErrorMessageSchema.safeParse(message).success) {
            const failure = ClientErrorMessageSchema.parse(message);
            this.#settleReject(failure.request_id, new ClientRpcRemoteError(failure.error));
            continue;
          }
          if (ClientEventMessageSchema.safeParse(message).success) {
            const event = ClientEventMessageSchema.parse(message);
            for (const listener of this.#eventListeners) await listener(event);
            continue;
          }
          throw new FramedRpcTransportError("invalid_peer_message", "RPC peer sent a request-only message to the client");
        }
      }
    } catch (error) {
      this.#terminate(error);
    } finally {
      this.#reader.releaseLock();
    }
  }

  #settleResolve(requestId: string, result: ClientReplyResult): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return; // A cancelled request may have a late reply.
    this.#pending.delete(requestId);
    this.#removeAbortListener(pending);
    pending.resolve(result);
  }

  #settleReject(requestId: string, error: unknown): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    this.#removeAbortListener(pending);
    pending.reject(error);
  }

  #rejectPending(error: unknown): void {
    for (const [requestId, pending] of this.#pending) {
      this.#removeAbortListener(pending);
      pending.reject(error);
      this.#pending.delete(requestId);
    }
  }

  #removeAbortListener(pending: PendingRequest): void {
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  #terminate(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    void this.#reader.cancel(error).catch(() => undefined);
    void this.#writer.abort(error).catch(() => undefined);
  }
}

function createAbortError(): DOMException {
  return new DOMException("RPC request was cancelled", "AbortError");
}

export { createTranslator, localeCatalogs, localeKeys, resolveLocale, supportedLocales, terminalLocale, translate } from "./locale/index.js";
export type { ClientLocale, LocaleKey } from "./locale/index.js";
