import { z } from "zod";
import {
  IdentifierSchema,
  ApprovePlanRequestSchema,
  ArtifactWireResponseSchema,
  LivePublicActivitySchema,
  MemoryExperienceControlCommandSchema,
  MemoryExperienceControlQuerySchema,
  MemoryExperienceControlReplySchema,
  ModelSurfaceEventSchema,
  RunCommandSchema,
  RunProjectionSchema,
  SCHEMA_VERSION,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionReadResultSchema,
  SessionRenameRequestSchema,
  SessionResumeRequestSchema,
  SessionResumeResponseSchema,
  SessionDeleteResponseSchema,
  StartChatRequestSchema,
  SubmitUserInputRequestSchema,
  SubmitUserInputResultSchema,
  TodoWriteRequestSchema,
  TodoMutationResultSchema,
  TodoListSchema,
  WireSessionEventSchema,
  type LivePublicActivity,
  type ModelSurfaceEvent,
  type RunCommand,
  type RunProjection,
  type SessionListQuery,
  type SessionListResponse,
  type SessionReadResult,
  type SubmitUserInputResult,
  type WireSessionEvent,
} from "@tracegraph/contracts";
import { NonEmptyStringSchema } from "@tracegraph/contracts";
import { CLIENT_PROTOCOL_VERSION } from "./constants.js";

/** Version of the private client protocol, independent of ledger/projector versions. */
export { CLIENT_PROTOCOL_VERSION };
export const ClientProtocolVersionSchema = z.literal(CLIENT_PROTOCOL_VERSION);

const ClientRunQuerySchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("run.get"),
    run_id: IdentifierSchema,
  }).strict(),
  z.object({
    operation: z.literal("session.list"),
    input: SessionListQuerySchema,
  }).strict(),
  z.object({
    operation: z.literal("session.get"),
    session_id: IdentifierSchema,
  }).strict(),
  z.object({ operation: z.literal("todo.list"), run_id: IdentifierSchema }).strict(),
  z.object({ operation: z.literal("artifact.get"), run_id: IdentifierSchema, artifact_id: IdentifierSchema }).strict(),
]);
export const ClientQuerySchema = z.union([ClientRunQuerySchema, MemoryExperienceControlQuerySchema]);
export type ClientQuery = z.infer<typeof ClientQuerySchema>;

const ClientWorkbenchCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.start"), input: StartChatRequestSchema }).strict(),
  z.object({ type: z.literal("session.resume"), session_id: IdentifierSchema, input: SessionResumeRequestSchema }).strict(),
  z.object({ type: z.literal("session.rename"), session_id: IdentifierSchema, input: SessionRenameRequestSchema }).strict(),
  z.object({ type: z.literal("session.delete"), session_id: IdentifierSchema }).strict(),
  z.object({ type: z.literal("todo.write"), run_id: IdentifierSchema, input: TodoWriteRequestSchema }).strict(),
  z.object({ type: z.literal("run.input"), run_id: IdentifierSchema, input: SubmitUserInputRequestSchema }).strict(),
  z.object({ type: z.literal("run.approve_plan"), run_id: IdentifierSchema, input: ApprovePlanRequestSchema }).strict(),
]);
export const ClientCommandSchema = z.union([RunCommandSchema, MemoryExperienceControlCommandSchema, ClientWorkbenchCommandSchema]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export const ClientCommandMessageSchema = z.object({
  protocol_version: ClientProtocolVersionSchema,
  kind: z.literal("command"),
  request_id: IdentifierSchema,
  command: ClientCommandSchema,
});
export type ClientCommandMessage = z.infer<typeof ClientCommandMessageSchema>;

export const ClientQueryMessageSchema = z.object({
  protocol_version: ClientProtocolVersionSchema,
  kind: z.literal("query"),
  request_id: IdentifierSchema,
  query: ClientQuerySchema,
});
export type ClientQueryMessage = z.infer<typeof ClientQueryMessageSchema>;

/**
 * Ledger events are durable and ordered by their Run sequence. Activity and
 * model-surface events are transient projections with independent cursors.
 */
export const ClientEventSchema = z.discriminatedUnion("stream", [
  z.object({
    stream: z.literal("ledger"),
    event: WireSessionEventSchema,
  }).strict(),
  z.object({
    stream: z.literal("activity"),
    event: LivePublicActivitySchema,
  }).strict(),
  z.object({
    stream: z.literal("model_surface"),
    event: ModelSurfaceEventSchema,
  }).strict(),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export const ClientEventMessageSchema = z.object({
  protocol_version: ClientProtocolVersionSchema,
  kind: z.literal("event"),
  event: ClientEventSchema,
});
export type ClientEventMessage = z.infer<typeof ClientEventMessageSchema>;

/** Transport cancellation targets an in-flight request id; it is not a Run command. */
export const ClientCancelMessageSchema = z.object({
  protocol_version: ClientProtocolVersionSchema,
  kind: z.literal("cancel"),
  request_id: IdentifierSchema,
});
export type ClientCancelMessage = z.infer<typeof ClientCancelMessageSchema>;

const ClientRunReplyResultSchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("run"), value: RunProjectionSchema }).strict(),
  z.object({ resource: z.literal("user_input"), value: SubmitUserInputResultSchema }).strict(),
  z.object({ resource: z.literal("session"), value: SessionReadResultSchema }).strict(),
  z.object({ resource: z.literal("sessions"), value: SessionListResponseSchema }).strict(),
  z.object({ resource: z.literal("session_resume"), value: SessionResumeResponseSchema }).strict(),
  z.object({ resource: z.literal("session_delete"), value: SessionDeleteResponseSchema }).strict(),
  z.object({ resource: z.literal("todos"), value: TodoListSchema }).strict(),
  z.object({ resource: z.literal("todo_mutation"), value: TodoMutationResultSchema }).strict(),
  z.object({ resource: z.literal("artifact"), value: ArtifactWireResponseSchema }).strict(),
]);
export const ClientReplyResultSchema = z.union([ClientRunReplyResultSchema, MemoryExperienceControlReplySchema]);
export type ClientReplyResult = z.infer<typeof ClientReplyResultSchema>;

export const ClientReplyMessageSchema = z.object({
  protocol_version: ClientProtocolVersionSchema,
  kind: z.literal("reply"),
  request_id: IdentifierSchema,
  result: ClientReplyResultSchema,
});
export type ClientReplyMessage = z.infer<typeof ClientReplyMessageSchema>;

export const ClientProtocolErrorSchema = z.object({
  code: z.enum([
    "invalid_request",
    "unsupported_version",
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "unavailable",
    "internal",
  ]),
  message: NonEmptyStringSchema.max(500),
  retryable: z.boolean(),
  correlation_id: IdentifierSchema.optional(),
}).strict();
export type ClientProtocolError = z.infer<typeof ClientProtocolErrorSchema>;

export const ClientErrorMessageSchema = z.object({
  protocol_version: ClientProtocolVersionSchema,
  kind: z.literal("error"),
  request_id: IdentifierSchema,
  error: ClientProtocolErrorSchema,
});
export type ClientErrorMessage = z.infer<typeof ClientErrorMessageSchema>;

/** A transport-neutral packet. It has no routing, authority, or side effects. */
export const ClientProtocolMessageSchema = z.discriminatedUnion("kind", [
  ClientCommandMessageSchema,
  ClientQueryMessageSchema,
  ClientEventMessageSchema,
  ClientCancelMessageSchema,
  ClientReplyMessageSchema,
  ClientErrorMessageSchema,
]);
export type ClientProtocolMessage = z.infer<typeof ClientProtocolMessageSchema>;

// Named aliases keep consumers from redefining the source contracts locally.
export type {
  LivePublicActivity,
  ModelSurfaceEvent,
  RunCommand,
  RunProjection,
  SessionListQuery,
  SessionListResponse,
  SessionReadResult,
  SubmitUserInputResult,
  WireSessionEvent,
};
export { SCHEMA_VERSION };
export { CLIENT_PROTOCOL_CONFORMANCE_FIXTURES } from "./fixtures.js";
