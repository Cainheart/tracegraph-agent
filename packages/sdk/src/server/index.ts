import { IdentifierSchema } from "@tracegraph/contracts";
import {
  ClientErrorMessageSchema,
  ClientEventMessageSchema,
  ClientReplyMessageSchema,
  ClientReplyResultSchema,
  type ClientCommandMessage,
  type ClientEventMessage,
  type ClientProtocolError,
  type ClientQueryMessage,
  type ClientReplyResult,
  type ClientCommand,
  type ClientQuery,
} from "../protocol/index.js";
import { CLIENT_PROTOCOL_VERSION } from "../protocol/constants.js";
import {
  FramedFrameWriter,
  FramedMessageDecoder,
  FramedRpcTransportError,
  parseClientProtocolMessage,
} from "../transport/framing.js";
import type { FramedRpcDuplex } from "../transport/duplex.js";

export interface ClientProtocolDispatchContext {
  readonly signal: AbortSignal;
  sendEvent(message: ClientEventMessage): Promise<void>;
}

/** Domain/controller methods are injected so this transport owns no policy or persistence. */
export interface ClientProtocolDispatcher {
  handleCommand(command: ClientCommand, context: ClientProtocolDispatchContext): Promise<ClientReplyResult>;
  handleQuery(query: ClientQuery, context: ClientProtocolDispatchContext): Promise<ClientReplyResult>;
}

export interface FramedRpcServerOptions {
  readonly maxFrameBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly maxInFlightRequests?: number;
  readonly closeDrainTimeoutMs?: number;
}

export class ClientRpcDispatchError extends Error {
  readonly code: ClientProtocolError["code"];
  readonly retryable: boolean;

  constructor(code: ClientProtocolError["code"], message: string, retryable = false) {
    super(message);
    this.name = "ClientRpcDispatchError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Serve one private duplex connection. It does not listen on a network port or authenticate a peer. */
export async function serveFramedRpc(
  duplex: FramedRpcDuplex,
  dispatcher: ClientProtocolDispatcher,
  options: FramedRpcServerOptions = {},
): Promise<void> {
  const maxInFlightRequests = options.maxInFlightRequests ?? 16;
  const closeDrainTimeoutMs = options.closeDrainTimeoutMs ?? 2_000;
  assertPositiveLimit(maxInFlightRequests, "maxInFlightRequests");
  if (!Number.isSafeInteger(closeDrainTimeoutMs) || closeDrainTimeoutMs < 0) {
    throw new RangeError("closeDrainTimeoutMs must be a non-negative safe integer");
  }
  const reader = duplex.readable.getReader();
  const writer = new FramedFrameWriter(duplex.writable, options);
  const decoder = new FramedMessageDecoder(options.maxFrameBytes);
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  let closing = false;
  let fatalError: unknown;

  const abortActive = (): void => {
    for (const controller of active.values()) controller.abort();
  };
  const failTransport = (error: unknown): void => {
    if (fatalError !== undefined) return;
    fatalError = error;
    closing = true;
    abortActive();
    void reader.cancel(error).catch(() => undefined);
    void writer.abort(error).catch(() => undefined);
  };
  const sendError = (
    requestId: string,
    code: ClientProtocolError["code"],
    message: string,
    retryable = false,
  ): Promise<void> => writer.write(ClientErrorMessageSchema.parse({
    protocol_version: CLIENT_PROTOCOL_VERSION,
    kind: "error",
    request_id: requestId,
    error: { code, message, retryable },
  }));

  const dispatch = (message: ClientCommandMessage | ClientQueryMessage): void => {
    if (active.has(message.request_id)) {
      void sendError(message.request_id, "conflict", "Request id is already in flight").catch(failTransport);
      return;
    }
    if (active.size >= maxInFlightRequests) {
      void sendError(message.request_id, "unavailable", "RPC server is at its in-flight request limit", true).catch(failTransport);
      return;
    }
    const controller = new AbortController();
    active.set(message.request_id, controller);
    const context: ClientProtocolDispatchContext = {
      signal: controller.signal,
      async sendEvent(eventMessage) {
        if (closing || controller.signal.aborted) {
          throw new ClientRpcDispatchError("unavailable", "RPC request is no longer active");
        }
        const parsed = ClientEventMessageSchema.parse(eventMessage);
        try {
          await writer.write(parsed);
        } catch (error) {
          failTransport(error);
          throw error;
        }
      },
    };
    const task = (async () => {
      let outgoing: ReturnType<typeof ClientReplyMessageSchema.parse> | ReturnType<typeof ClientErrorMessageSchema.parse>;
      try {
        const result = message.kind === "command"
          ? await dispatcher.handleCommand(message.command, context)
          : await dispatcher.handleQuery(message.query, context);
        if (closing) return;
        if (controller.signal.aborted) {
          outgoing = errorMessage(message.request_id, "unavailable", "RPC request was cancelled", false);
        } else {
          outgoing = ClientReplyMessageSchema.parse({
            protocol_version: CLIENT_PROTOCOL_VERSION,
            kind: "reply",
            request_id: message.request_id,
            result: ClientReplyResultSchema.parse(result),
          });
        }
      } catch (error) {
        if (closing) return;
        outgoing = error instanceof ClientRpcDispatchError
          ? errorMessage(message.request_id, error.code, error.message, error.retryable)
          : controller.signal.aborted
            ? errorMessage(message.request_id, "unavailable", "RPC request was cancelled", false)
            : errorMessage(message.request_id, "internal", "RPC request could not be processed", false);
      }
      if (closing) return;
      try {
        await writer.write(outgoing);
      } catch (error) {
        failTransport(error);
      }
    })().finally(() => {
      if (active.get(message.request_id) === controller) active.delete(message.request_id);
    });
    tasks.add(task);
    void task.then(
      () => { tasks.delete(task); },
      (error: unknown) => { tasks.delete(task); failTransport(error); },
    );
  };

  try {
    while (!closing) {
      const result = await reader.read();
      if (result.done) {
        decoder.finish();
        break;
      }
      for (const rawMessage of decoder.push(result.value)) {
        const header = readHeader(rawMessage);
        if (typeof header.protocolVersion !== "string") {
          await sendError(header.requestId, "invalid_request", "Client protocol version is required", false);
          continue;
        }
        if (header.protocolVersion !== CLIENT_PROTOCOL_VERSION) {
          await sendError(header.requestId, "unsupported_version", "Client protocol version is not supported", false);
          continue;
        }
        let message;
        try {
          message = parseClientProtocolMessage(rawMessage);
        } catch (error) {
          if (error instanceof FramedRpcTransportError && error.code === "invalid_message") {
            await sendError(header.requestId, "invalid_request", "Frame did not match the client protocol contract", false);
            continue;
          }
          throw error;
        }
        switch (message.kind) {
          case "cancel":
            active.get(message.request_id)?.abort();
            break;
          case "command":
            dispatch(message);
            break;
          case "query":
            dispatch(message);
            break;
          default:
            await sendError(header.requestId, "invalid_request", "Client sent a response-only protocol message", false);
        }
      }
    }
    if (fatalError !== undefined) throw fatalError;
    closing = true;
    abortActive();
    await settleTasks(tasks, closeDrainTimeoutMs);
    if (tasks.size > 0) await writer.abort(new FramedRpcTransportError("drain_timeout", "RPC handlers did not stop before the connection closed"));
    else await writer.close();
  } catch (error) {
    closing = true;
    abortActive();
    await reader.cancel(error).catch(() => undefined);
    await writer.abort(error).catch(() => undefined);
    await settleTasks(tasks, closeDrainTimeoutMs);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function errorMessage(
  requestId: string,
  code: ClientProtocolError["code"],
  message: string,
  retryable: boolean,
): ReturnType<typeof ClientErrorMessageSchema.parse> {
  return ClientErrorMessageSchema.parse({
    protocol_version: CLIENT_PROTOCOL_VERSION,
    kind: "error",
    request_id: requestId,
    error: { code, message, retryable },
  });
}

function readHeader(value: unknown): { requestId: string; protocolVersion: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FramedRpcTransportError("invalid_message", "Frame must contain a protocol envelope");
  }
  const record = value as Record<string, unknown>;
  const requestId = IdentifierSchema.safeParse(record.request_id);
  if (!requestId.success) {
    throw new FramedRpcTransportError("invalid_message", "Frame has no valid request id");
  }
  return { requestId: requestId.data, protocolVersion: record.protocol_version };
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

async function settleTasks(tasks: ReadonlySet<Promise<void>>, timeoutMs: number): Promise<void> {
  if (tasks.size === 0 || timeoutMs === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...tasks]).then(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
