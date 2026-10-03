import { Readable, Writable } from "node:stream";
import { CLIENT_PROTOCOL_VERSION } from "@tracegraph/sdk/protocol";
import {
  createDesktopHostRuntime,
  type DesktopHostRuntime,
} from "./desktop-host.js";
import {
  DesktopHostReadyMessageSchema,
  DesktopHostStartMessageSchema,
  DesktopHostStartupErrorSchema,
} from "./lifecycle-protocol.js";
import {
  DesktopHostNativeReplySchema,
  DesktopHostNativeRequestSchema,
  type DesktopHostNativeRequest,
} from "./native-control.js";
import { DESKTOP_HOST_PACKAGE_NAME, DESKTOP_HOST_PACKAGE_VERSION } from "./identity.js";

let host: DesktopHostRuntime | undefined;
let readySent = false;
let nativeControlClosing = false;
const nativeTasks = new Set<Promise<void>>();

try {
  const raw = await receiveStartMessage();
  const parsed = DesktopHostStartMessageSchema.safeParse(raw);
  if (!parsed.success) {
    await sendStartupError({ kind: "startup_error", code: "invalid_start", message: "Desktop Host startup message was invalid" });
    process.exitCode = 1;
  } else if (parsed.data.expected_host_version !== DESKTOP_HOST_PACKAGE_VERSION
    || parsed.data.protocol_version !== CLIENT_PROTOCOL_VERSION) {
    await sendStartupError({
      kind: "startup_error",
      code: "version_mismatch",
      message: "Desktop Host package or protocol version did not match the parent request",
      actual_host_version: DESKTOP_HOST_PACKAGE_VERSION,
      actual_protocol_version: CLIENT_PROTOCOL_VERSION,
    });
    process.exitCode = 1;
  } else {
    host = await createDesktopHostRuntime({
      dataDir: parsed.data.data_dir,
      projects: parsed.data.projects,
    });
    const ready = DesktopHostReadyMessageSchema.parse({
      kind: "ready",
      package_name: DESKTOP_HOST_PACKAGE_NAME,
      package_version: DESKTOP_HOST_PACKAGE_VERSION,
      protocol_version: CLIENT_PROTOCOL_VERSION,
      session_recovery: host.sessionRecovery,
    });
    await sendStartupMessage(ready);
    readySent = true;
    process.on("message", onNativeControlMessage);
    if (process.stdin === undefined || process.stdout === undefined) {
      throw new Error("Desktop Host stdio streams are unavailable");
    }
    await host.serve({
      readable: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      writable: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    });
    nativeControlClosing = true;
    await Promise.allSettled([...nativeTasks]);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Desktop Host startup failed";
  if (!readySent) {
    await sendStartupError({ kind: "startup_error", code: "startup_failed", message: safeMessage(message) });
  }
  process.stderr.write(`${safeMessage(message)}\n`);
  process.exitCode = 1;
} finally {
  if (host !== undefined) {
    try {
      await host.close();
    } catch (error) {
      process.stderr.write(`${safeMessage(error instanceof Error ? error.message : "Desktop Host shutdown failed")}\n`);
      process.exitCode = 1;
    }
  }
  process.removeListener("message", onNativeControlMessage);
  if (process.connected) process.disconnect();
}

function onNativeControlMessage(raw: unknown): void {
  const parsed = DesktopHostNativeRequestSchema.safeParse(raw);
  if (!parsed.success || nativeControlClosing || host === undefined) return;
  const task = dispatchNativeControl(parsed.data);
  nativeTasks.add(task);
  void task.finally(() => nativeTasks.delete(task));
}

async function dispatchNativeControl(request: DesktopHostNativeRequest): Promise<void> {
  if (host === undefined || !process.connected) return;
  try {
    const result = await dispatchNativeOperation(request);
    await sendNativeControlMessage(DesktopHostNativeReplySchema.parse({
      kind: "native_reply",
      request_id: request.request_id,
      operation: request.operation,
      ok: true,
      result,
    }));
  } catch {
    const message = request.operation.startsWith("projects.")
      ? "Desktop project operation failed"
      : "Desktop credential or model operation failed";
    await sendNativeControlMessage(DesktopHostNativeReplySchema.parse({
      kind: "native_reply",
      request_id: request.request_id,
      operation: request.operation,
      ok: false,
      message,
    })).catch(() => undefined);
  }
}

function dispatchNativeOperation(request: DesktopHostNativeRequest): Promise<unknown> | unknown {
  if (host === undefined) throw new Error("Desktop Host is unavailable");
  switch (request.operation) {
    case "projects.list": return host.native.listProjects();
    case "projects.register": return host.native.registerProject({
      selectedPath: request.selected_path,
      access: request.access,
    });
    case "projects.remove": return host.native.removeProject(request.project_id);
    case "projects.root": return host.native.resolveProjectRoot(request.project_id);
    case "model.get": return host.native.getModelConfig();
    case "model.configure": return host.native.configureModel(request.input);
  }
}

async function sendNativeControlMessage(message: unknown): Promise<void> {
  if (!process.send || !process.connected) throw new Error("Desktop Host control channel is closed");
  await new Promise<void>((resolve, reject) => process.send!(message, (error) => {
    if (error !== null) reject(error);
    else resolve();
  }));
}

async function receiveStartMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      cleanup();
      resolve(message);
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(new Error("Desktop Host parent disconnected before startup"));
    };
    const cleanup = (): void => {
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", onDisconnect);
    };
    process.once("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

async function sendStartupMessage(message: unknown): Promise<void> {
  if (!process.send) throw new Error("Desktop Host has no private startup channel");
  await new Promise<void>((resolve, reject) => process.send!(message, (error) => {
    if (error !== null) reject(error);
    else resolve();
  }));
}

async function sendStartupError(message: unknown): Promise<void> {
  const parsed = DesktopHostStartupErrorSchema.safeParse(message);
  if (!parsed.success || !process.send || !process.connected) return;
  await sendStartupMessage(parsed.data).catch(() => undefined);
  if (process.connected) process.disconnect();
}

function safeMessage(message: string): string {
  return message.replace(/[\r\n\u0000-\u001f]/gu, " ").slice(0, 500);
}
