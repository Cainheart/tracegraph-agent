import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  SourceRefSchema,
  TrustLevelSchema,
} from "./common.js";

export const MemoryScopeSchema = z.object({
  kind: z.enum(["run", "project", "global"]),
  project_id: IdentifierSchema.optional(),
  run_id: IdentifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "project" || value.kind === "run") && value.project_id === undefined) {
    context.addIssue({ code: "custom", path: ["project_id"], message: "project_id is required" });
  }
  if (value.kind === "run" && value.run_id === undefined) {
    context.addIssue({ code: "custom", path: ["run_id"], message: "run_id is required" });
  }
  if (value.kind === "global" && (value.project_id !== undefined || value.run_id !== undefined)) {
    context.addIssue({ code: "custom", message: "global memory cannot carry project or run scope" });
  }
  if (value.kind === "project" && value.run_id !== undefined) {
    context.addIssue({ code: "custom", path: ["run_id"], message: "project memory cannot carry run scope" });
  }
});
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryStatusSchema = z.enum([
  "candidate",
  "confirmed",
  "rejected",
  "quarantined",
  "superseded",
  "expired",
]);

export const MemoryRecordSchema = z.object({
  memory_id: IdentifierSchema,
  content: NonEmptyStringSchema.max(8_000),
  scope: MemoryScopeSchema,
  origin: z.enum(["user", "tool", "repository", "system", "fixture"]),
  trust: TrustLevelSchema,
  version: z.number().int().positive(),
  status: MemoryStatusSchema,
  source_refs: z.array(SourceRefSchema).min(1),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema.optional(),
  supersedes: z.array(IdentifierSchema).default([]),
  content_hash: Sha256Schema.optional(),
  /** Optional only for replaying records written before G-21. */
  candidate_id: IdentifierSchema.optional(),
  candidate_hash: Sha256Schema.optional(),
  admission_id: IdentifierSchema.optional(),
  admitted_at: IsoDateTimeSchema.optional(),
  admission_reason: NonEmptyStringSchema.max(2_000).optional(),
}).strict();
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryCandidateSchema = z.object({
  candidate_id: IdentifierSchema,
  content: NonEmptyStringSchema.max(8_000),
  scope: MemoryScopeSchema,
  origin: z.enum(["user", "tool", "repository", "system", "fixture"]),
  trust: TrustLevelSchema,
  source_refs: z.array(SourceRefSchema),
  proposed_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema.optional(),
  supersedes: z.array(IdentifierSchema).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.source_refs.map((source) => source.source_id)).size !== value.source_refs.length) {
    context.addIssue({ code: "custom", path: ["source_refs"], message: "memory sources must be unique" });
  }
  if (new Set(value.supersedes).size !== value.supersedes.length) {
    context.addIssue({ code: "custom", path: ["supersedes"], message: "superseded memory ids must be unique" });
  }
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export const MemoryAdmissionSchema = z.object({
  admission_id: IdentifierSchema,
  candidate_id: IdentifierSchema,
  decision: z.enum(["confirmed", "rejected", "quarantined", "expired", "superseded"]),
  reason: NonEmptyStringSchema,
  decided_at: IsoDateTimeSchema,
  resulting_memory_id: IdentifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "confirmed" && value.resulting_memory_id === undefined) {
    context.addIssue({ code: "custom", path: ["resulting_memory_id"], message: "confirmed memory requires an id" });
  }
  if (value.decision !== "confirmed" && value.resulting_memory_id !== undefined) {
    context.addIssue({ code: "custom", path: ["resulting_memory_id"], message: "non-confirmed memory cannot have an id" });
  }
});
export type MemoryAdmission = z.infer<typeof MemoryAdmissionSchema>;

export const RetrievalReceiptSchema = z.object({
  retrieval_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  query: NonEmptyStringSchema,
  retrieved_memory_ids: z.array(IdentifierSchema),
  blocked_memory_ids: z.array(IdentifierSchema),
  reasons: z.record(IdentifierSchema, NonEmptyStringSchema),
  created_at: IsoDateTimeSchema,
});
export type RetrievalReceipt = z.infer<typeof RetrievalReceiptSchema>;

/** Budget applied before retrieved text crosses the model Context boundary. */
export const MemoryRecallBudgetSchema = z.object({
  max_tokens: z.number().int().positive().max(258_000),
  max_hits: z.number().int().positive().max(100),
}).strict();
export type MemoryRecallBudget = z.infer<typeof MemoryRecallBudgetSchema>;

/** Strict shape accepted from a local or remote retrieval implementation. */
export const RetrievalSearchHitSchema = z.object({
  rank: z.number().int().positive(),
  chunk_id: IdentifierSchema,
  content_hash: Sha256Schema,
  score: z.number().finite().nonnegative(),
  source_path: z.string().trim().min(1).max(2_048),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  heading_path: z.array(NonEmptyStringSchema.max(500)).max(6),
  content: NonEmptyStringSchema.max(64_000),
}).strict().superRefine((value, context) => {
  if (value.end_line < value.start_line) {
    context.addIssue({ code: "custom", path: ["end_line"], message: "end line cannot precede start line" });
  }
});
export type RetrievalSearchHit = z.infer<typeof RetrievalSearchHitSchema>;

export const RetrievalSearchResponseSchema = z.object({
  schema_version: z.literal("tracegraph.retrieval.v1"),
  project_id: IdentifierSchema,
  query_hash: Sha256Schema,
  total_indexed_chunks: z.number().int().nonnegative(),
  hits: z.array(RetrievalSearchHitSchema).max(100),
}).strict();
export type RetrievalSearchResponse = z.infer<typeof RetrievalSearchResponseSchema>;

/** Provenance copied into both the Context manifest and the recall Event. */
export const RetrievalAttributionSchema = z.object({
  rank: z.number().int().positive(),
  hit_id: IdentifierSchema,
  content_hash: Sha256Schema,
  score: z.number().finite().nonnegative(),
  source_path: z.string().trim().min(1).max(2_048),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  heading_path: z.array(NonEmptyStringSchema.max(500)).max(6),
  injected_tokens: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.end_line < value.start_line) {
    context.addIssue({ code: "custom", path: ["end_line"], message: "end line cannot precede start line" });
  }
});
export type RetrievalAttribution = z.infer<typeof RetrievalAttributionSchema>;

export const RetrievedMemoryHitSchema = z.object({
  content: NonEmptyStringSchema.max(64_000),
  attribution: RetrievalAttributionSchema,
}).strict();
export type RetrievedMemoryHit = z.infer<typeof RetrievedMemoryHitSchema>;

export const MemoryCandidateEvaluatedDataSchema = z.object({
  admission_id: IdentifierSchema,
  candidate_id: IdentifierSchema,
  candidate_hash: Sha256Schema,
  decided_at: IsoDateTimeSchema,
  accepted: z.boolean(),
  decision: MemoryAdmissionSchema.shape.decision,
  reason: NonEmptyStringSchema.max(2_000),
  source_count: z.number().int().nonnegative(),
  resulting_memory_id: IdentifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.accepted !== (value.decision === "confirmed")) {
    context.addIssue({ code: "custom", path: ["accepted"], message: "accepted must match the admission decision" });
  }
  if (value.accepted !== (value.resulting_memory_id !== undefined)) {
    context.addIssue({ code: "custom", path: ["resulting_memory_id"], message: "accepted candidates require a resulting id" });
  }
});
export type MemoryCandidateEvaluatedData = z.infer<typeof MemoryCandidateEvaluatedDataSchema>;

export const MemoryWrittenDataSchema = z.object({
  admission_id: IdentifierSchema,
  candidate_id: IdentifierSchema,
  memory_id: IdentifierSchema,
  content_hash: Sha256Schema,
  scope: MemoryScopeSchema,
  source_refs: z.array(SourceRefSchema).min(1),
}).strict();
export type MemoryWrittenData = z.infer<typeof MemoryWrittenDataSchema>;

export const MemoryRecallBlockedHitSchema = z.object({
  hit_id: IdentifierSchema,
  reason: z.enum([
    "memory_record_missing",
    "status_rejected",
    "status_quarantined",
    "status_superseded",
    "status_expired",
    "status_candidate",
    "superseded",
    "expired",
    "missing_source",
    "untrusted",
    "cross_project_scope",
    "cross_run_scope",
  ]),
}).strict();
export type MemoryRecallBlockedHit = z.infer<typeof MemoryRecallBlockedHitSchema>;

export const MemoryRecalledDataSchema = z.object({
  retrieval_id: IdentifierSchema,
  query_hash: Sha256Schema,
  status: z.enum(["completed", "degraded"]),
  budget: MemoryRecallBudgetSchema,
  hits: z.array(RetrievalAttributionSchema).max(100),
  // Recall may query both the project index and the dedicated global-memory
  // index; retain bounded rejection evidence from both searches.
  blocked_hits: z.array(MemoryRecallBlockedHitSchema).max(200),
  injected_tokens: z.number().int().nonnegative(),
  failure_code: z.enum(["retriever_unavailable", "retriever_invalid_response", "retriever_failed"]).optional(),
}).strict().superRefine((value, context) => {
  const tokenTotal = value.hits.reduce((total, hit) => total + hit.injected_tokens, 0);
  if (tokenTotal !== value.injected_tokens) {
    context.addIssue({ code: "custom", path: ["injected_tokens"], message: "injected tokens must equal the hit total" });
  }
  if (value.injected_tokens > value.budget.max_tokens || value.hits.length > value.budget.max_hits) {
    context.addIssue({ code: "custom", path: ["budget"], message: "recall result exceeds its budget" });
  }
  if ((value.status === "degraded") !== (value.failure_code !== undefined)) {
    context.addIssue({ code: "custom", path: ["failure_code"], message: "degraded recall requires a failure code" });
  }
});
export type MemoryRecalledData = z.infer<typeof MemoryRecalledDataSchema>;

export const RetrievalIndexUpdatedDataSchema = z.object({
  source_path: z.string().trim().min(1).max(2_048),
  document_hash: Sha256Schema,
  status: z.enum(["updated", "unchanged"]),
  generation: z.number().int().nonnegative(),
  source_chunk_count: z.number().int().nonnegative(),
  total_indexed_chunks: z.number().int().nonnegative(),
}).strict();
export type RetrievalIndexUpdatedData = z.infer<typeof RetrievalIndexUpdatedDataSchema>;

export const RetrievalIndexUpdateResponseSchema = RetrievalIndexUpdatedDataSchema.extend({
  schema_version: z.literal("tracegraph.retrieval.v1"),
  project_id: IdentifierSchema,
}).strict();
export type RetrievalIndexUpdateResponse = z.infer<typeof RetrievalIndexUpdateResponseSchema>;

export const MemoryRememberResultSchema = z.object({
  admission: MemoryAdmissionSchema,
  record: MemoryRecordSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.admission.decision === "confirmed") !== (value.record !== undefined)) {
    context.addIssue({ code: "custom", path: ["record"], message: "confirmed admission must return its record" });
  }
});
export type MemoryRememberResult = z.infer<typeof MemoryRememberResultSchema>;

export const MemoryRecallResultSchema = z.object({
  data: MemoryRecalledDataSchema,
  hits: z.array(RetrievedMemoryHitSchema).max(100),
}).strict().superRefine((value, context) => {
  const ids = value.hits.map((hit) => hit.attribution.hit_id);
  if (ids.length !== value.data.hits.length || ids.some((id, index) => id !== value.data.hits[index]?.hit_id)) {
    context.addIssue({ code: "custom", path: ["hits"], message: "result hits must match recall evidence" });
  }
});
export type MemoryRecallResult = z.infer<typeof MemoryRecallResultSchema>;
