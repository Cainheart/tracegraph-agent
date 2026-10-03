import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  IdentifierSchema,
  ModelConfigUpdateRequestSchema,
  ProjectSummarySchema,
  PublicModelConfigResponseSchema,
  type ModelConfigUpdateRequest,
  type ProjectSummary,
  type PublicModelConfigResponse,
} from "@tracegraph/contracts";
import { z } from "zod";
import { DesktopProjectAccessSchema, type DesktopProjectAccess } from "./project-registry.js";

const NativeOperationSchema = z.enum([
  "projects.list",
  "projects.register",
  "projects.remove",
  "projects.root",
  "model.get",
  "model.configure",
]);
export type DesktopHostNativeOperation = z.infer<typeof NativeOperationSchema>;

export const DesktopHostNativeRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    kind: z.literal("native_request"),
    request_id: IdentifierSchema,
    operation: z.literal("projects.list"),
  }).strict(),
  z.object({
    kind: z.literal("native_request"),
    request_id: IdentifierSchema,
    operation: z.literal("projects.register"),
    selected_path: z.string().min(1).max(4_096),
    access: DesktopProjectAccessSchema,
  }).strict(),
  z.object({
    kind: z.literal("native_request"),
    request_id: IdentifierSchema,
    operation: z.literal("projects.remove"),
    project_id: IdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("native_request"),
    request_id: IdentifierSchema,
    operation: z.literal("projects.root"),
    project_id: IdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("native_request"),
    request_id: IdentifierSchema,
    operation: z.literal("model.get"),
  }).strict(),
  z.object({
    kind: z.literal("native_request"),
    request_id: IdentifierSchema,
    operation: z.literal("model.configure"),
    input: ModelConfigUpdateRequestSchema,
  }).strict(),
]);
export type DesktopHostNativeRequest = z.infer<typeof DesktopHostNativeRequestSchema>;

export const DesktopHostNativeReplySchema = z.discriminatedUnion("ok", [
  z.object({
    kind: z.literal("native_reply"),
    request_id: IdentifierSchema,
    operation: NativeOperationSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal("native_reply"),
    request_id: IdentifierSchema,
    operation: NativeOperationSchema,
    ok: z.literal(false),
    message: z.string().min(1).max(200),
  }).strict(),
]);

export interface DesktopHostNativeOperations {
  listProjects(): Promise<ProjectSummary[]>;
  registerProject(input: { selectedPath: string; access: DesktopProjectAccess }): Promise<ProjectSummary>;
  removeProject(projectId: string): Promise<boolean>;
  resolveProjectRoot(projectId: string): Promise<string>;
  getModelConfig(): Promise<PublicModelConfigResponse>;
  configureModel(input: ModelConfigUpdateRequest): Promise<PublicModelConfigResponse>;
}

interface PendingNativeRequest {
  readonly operation: DesktopHostNativeOperation;
  readonly parseResult: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Private parent/child control plane, separate from Renderer IPC and framed Run/Session RPC. */
export class DesktopHostNativeClient implements DesktopHostNativeOperations {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, PendingNativeRequest>();
  readonly #onMessage = (message: unknown): void => this.#receive(message);
  readonly #onExit = (): void => this.#rejectPending(new Error("Desktop Host control channel closed"));

  constructor(child: ChildProcess, timeoutMs = 60_000) {
    this.#child = child;
    this.timeoutMs = timeoutMs;
    child.on("message", this.#onMessage);
    child.once("exit", this.#onExit);
  }

  readonly timeoutMs: number;

  listProjects(): Promise<ProjectSummary[]> {
    return this.#request({ kind: "native_request", request_id: randomUUID(), operation: "projects.list" }, ProjectSummarySchema.array());
  }

  registerProject(input: { selectedPath: string; access: DesktopProjectAccess }): Promise<ProjectSummary> {
    return this.#request({
      kind: "native_request",
      request_id: randomUUID(),
      operation: "projects.register",
      selected_path: input.selectedPath,
      access: input.access,
    }, ProjectSummarySchema);
  }

  removeProject(projectIdInput: string): Promise<boolean> {
    const projectId = IdentifierSchema.parse(projectIdInput);
    return this.#request({
      kind: "native_request",
      request_id: randomUUID(),
      operation: "projects.remove",
      project_id: projectId,
    }, z.boolean());
  }

  resolveProjectRoot(projectIdInput: string): Promise<string> {
    const projectId = IdentifierSchema.parse(projectIdInput);
    return this.#request({
      kind: "native_request",
      request_id: randomUUID(),
      operation: "projects.root",
      project_id: projectId,
    }, z.string().min(1).max(4_096));
  }

  getModelConfig(): Promise<PublicModelConfigResponse> {
    return this.#request({ kind: "native_request", request_id: randomUUID(), operation: "model.get" }, PublicModelConfigResponseSchema);
  }

  configureModel(input: ModelConfigUpdateRequest): Promise<PublicModelConfigResponse> {
    return this.#request({
      kind: "native_request",
      request_id: randomUUID(),
      operation: "model.configure",
      input: ModelConfigUpdateRequestSchema.parse(input),
    }, PublicModelConfigResponseSchema);
  }

  #request<T>(requestValue: DesktopHostNativeRequest, resultSchema: z.ZodType<T>): Promise<T> {
    const request = DesktopHostNativeRequestSchema.parse(requestValue);
    if (!this.#child.connected || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return Promise.reject(new Error("Desktop Host control channel is unavailable"));
    }
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#settle(request.request_id, new Error("Desktop Host native operation timed out"));
      }, this.timeoutMs);
      this.#pending.set(request.request_id, {
        operation: request.operation,
        parseResult: (value) => resultSchema.parse(value),
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer,
      });
      this.#child.send(request, (error) => {
        if (error !== null) this.#settle(request.request_id, new Error("Desktop Host control request could not be sent"));
      });
    });
  }

  #receive(value: unknown): void {
    const reply = DesktopHostNativeReplySchema.safeParse(value);
    if (!reply.success) {
      this.#rejectPending(new Error("Desktop Host returned an invalid native control response"));
      return;
    }
    const pending = this.#pending.get(reply.data.request_id);
    if (pending === undefined) return;
    if (pending.operation !== reply.data.operation) {
      this.#settle(reply.data.request_id, new Error("Desktop Host native response did not match its request"));
      return;
    }
    if (!reply.data.ok) {
      this.#settle(reply.data.request_id, new Error(reply.data.message));
      return;
    }
    try {
      const result = pending.parseResult(reply.data.result);
      this.#settle(reply.data.request_id, undefined, result);
    } catch {
      this.#settle(reply.data.request_id, new Error("Desktop Host returned an invalid native operation result"));
    }
  }

  #settle(requestId: string, error?: Error, value?: unknown): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (error !== undefined) pending.reject(error);
    else pending.resolve(value);
  }

  #rejectPending(error: Error): void {
    for (const requestId of this.#pending.keys()) this.#settle(requestId, error);
  }
}
