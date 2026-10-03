import { DecisionSchema } from "@tracegraph/contracts";
import { z } from "zod";

export const MAX_RECORDED_SESSION_FILE_BYTES = 128 * 1024;
export const MAX_RECORDED_SESSION_TOTAL_BYTES = 512 * 1024;
export const MAX_RECORDED_MODEL_STEPS = 64;
export const MAX_RECORDED_WORKSPACE_ENTRIES = 512;
export const MAX_RECORDED_WORKSPACE_FILE_BYTES = 256 * 1024;
export const MAX_RECORDED_WORKSPACE_TOTAL_BYTES = 2 * 1024 * 1024;

export const RecordedSessionScenarioIdSchema = z.enum([
  "minimal-completion",
  "recovery",
  "cancel",
  "memory-recall",
  "subagent",
]);

export const RecordedSessionManifestSchema = z.strictObject({
  schema_version: z.literal("tracegraph.recorded-session.snapshot.v1"),
  case_id: z.string().min(3).max(128),
  scenario_id: RecordedSessionScenarioIdSchema,
  format_version: z.literal(1),
  source_kind: z.literal("offline-capture-import"),
  input_file: z.literal("input.json"),
  model_stream_file: z.literal("model-stream.jsonl"),
  expected_file: z.literal("expected.json"),
});

export const RecordedSessionInputSchema = z.strictObject({
  schema_version: z.literal("tracegraph.recorded-session.input.v1"),
  scenario_id: RecordedSessionScenarioIdSchema,
  workspace_fixture: z.literal("failing-typescript"),
  task: z.string().min(1).max(2_000),
});

/** Capture import remains intentionally narrower than the checked-in replay suite. */
export const RecordedSessionCaptureSchema = z.strictObject({
  schema_version: z.literal("tracegraph.recorded-session.capture.v1"),
  scenario_id: z.literal("minimal-completion"),
  workspace_fixture: z.literal("failing-typescript"),
  task: z.string().min(1).max(2_000),
  model_response: DecisionSchema,
});

export const RecordedModelStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("response"),
    value: DecisionSchema,
  }),
  z.strictObject({
    kind: z.literal("timeout"),
    timeout_ms: z.number().int().min(1).max(30_000),
  }),
]);

export const RecordedSessionSemanticEventSchema = z.strictObject({
  type: z.string().min(1).max(120),
  summary: z.string().max(2_000),
});

export const RecordedSessionWorkspaceEntrySchema = z.strictObject({
  path: z.string().min(1).max(512).refine(isSafeRelativeWorkspacePath),
  kind: z.enum(["file", "directory"]),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
});

export const RecordedSessionResultSchema = z.strictObject({
  schema_version: z.literal("tracegraph.recorded-session.result.v2"),
  status: z.enum([
    "created",
    "indexing",
    "running",
    "awaiting_approval",
    "awaiting_plan_approval",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  outcome: z.string().max(16_000).nullable(),
  failure_code: z.string().max(120).nullable(),
  events: z.array(RecordedSessionSemanticEventSchema).min(1).max(512),
  workspace: z.strictObject({
    before: z.array(RecordedSessionWorkspaceEntrySchema).max(MAX_RECORDED_WORKSPACE_ENTRIES),
    after: z.array(RecordedSessionWorkspaceEntrySchema).max(MAX_RECORDED_WORKSPACE_ENTRIES),
  }),
});

export type RecordedSessionManifest = z.infer<typeof RecordedSessionManifestSchema>;
export type RecordedSessionInput = z.infer<typeof RecordedSessionInputSchema>;
export type RecordedSessionCapture = z.infer<typeof RecordedSessionCaptureSchema>;
export type RecordedModelStep = z.infer<typeof RecordedModelStepSchema>;
export type RecordedSessionResult = z.infer<typeof RecordedSessionResultSchema>;
export type RecordedSessionWorkspaceEntry = z.infer<typeof RecordedSessionWorkspaceEntrySchema>;

function isSafeRelativeWorkspacePath(value: string): boolean {
  return !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
