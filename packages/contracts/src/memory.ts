import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  SourceRefSchema,
  TrustLevelSchema,
  ArtifactRefSchema,
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

/** The unversioned G-21 record shape retained for compatibility reads/writes. */
const memoryRecordV1Fields = {
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
  content_hash: Sha256Schema.optional(),
  /** Optional only for replaying records written before G-21. */
  candidate_id: IdentifierSchema.optional(),
  candidate_hash: Sha256Schema.optional(),
  admission_id: IdentifierSchema.optional(),
  admitted_at: IsoDateTimeSchema.optional(),
  admission_reason: NonEmptyStringSchema.max(2_000).optional(),
};

/** Raw V1 row shape used only to preserve omitted/defaulted keys in migration. */
export const MemoryRecordV1SourceSchema = z.object({
  ...memoryRecordV1Fields,
  supersedes: z.array(IdentifierSchema).optional(),
}).strict();
export type MemoryRecordV1Source = z.infer<typeof MemoryRecordV1SourceSchema>;

/** V1 reader schema remains a ZodObject and keeps its historical default. */
export const MemoryRecordV1Schema = z.object({
  ...memoryRecordV1Fields,
  supersedes: z.array(IdentifierSchema).default([]),
}).strict();
export type MemoryRecordV1 = z.infer<typeof MemoryRecordV1Schema>;

/**
 * Compatibility name used by the current G-21 Runtime. MEM-040 deliberately
 * keeps this alias on V1 until a later lifecycle task performs a reviewed
 * canonical-store cutover.
 */
export const MemoryRecordSchema = MemoryRecordV1Schema;
export type MemoryRecord = MemoryRecordV1;

export const MemoryKindV2Schema = z.enum([
  "declared_identity",
  "preference",
  "fact",
  "decision",
  "procedure",
  "lesson",
  "relationship",
  /** Used only while importing a legacy row whose semantic kind is unknown. */
  "legacy_unclassified",
]);
export type MemoryKindV2 = z.infer<typeof MemoryKindV2Schema>;

export const MemoryStatusV2Schema = z.enum([
  "candidate",
  "active",
  "disputed",
  "superseded",
  "revoked",
  "expired",
]);
export type MemoryStatusV2 = z.infer<typeof MemoryStatusV2Schema>;

export const MemoryLifecycleActionSchema = z.enum([
  "review_activate",
  "review_reject",
  "dispute",
  "resolve_active",
  "resolve_superseded",
  "supersede",
  "revoke",
  "expire",
  "revalidate",
]);
export type MemoryLifecycleAction = z.infer<typeof MemoryLifecycleActionSchema>;

function memoryLifecycleEdge(
  from: readonly MemoryStatusV2[],
  to: MemoryStatusV2,
): { readonly from: readonly MemoryStatusV2[]; readonly to: MemoryStatusV2 } {
  return Object.freeze({ from: Object.freeze([...from]), to });
}

export const MEMORY_LIFECYCLE_TRANSITIONS: Readonly<Record<
  MemoryLifecycleAction,
  { readonly from: readonly MemoryStatusV2[]; readonly to: MemoryStatusV2 }
>> = Object.freeze({
  review_activate: memoryLifecycleEdge(["candidate"], "active"),
  review_reject: memoryLifecycleEdge(["candidate"], "revoked"),
  dispute: memoryLifecycleEdge(["active"], "disputed"),
  resolve_active: memoryLifecycleEdge(["disputed"], "active"),
  resolve_superseded: memoryLifecycleEdge(["disputed"], "superseded"),
  supersede: memoryLifecycleEdge(["active"], "superseded"),
  revoke: memoryLifecycleEdge(["active", "disputed", "superseded", "expired"], "revoked"),
  expire: memoryLifecycleEdge(["active"], "expired"),
  revalidate: memoryLifecycleEdge(["expired"], "candidate"),
});

export const MemoryLifecycleReasonCodeSchema = z.enum([
  "review_accepted",
  "review_rejected",
  "conflicting_evidence",
  "user_challenge",
  "resolution_confirmed",
  "correction_accepted",
  "replacement_accepted",
  "user_requested_forget",
  "policy_withdrawn",
  "retention_elapsed",
  "policy_expired",
  "revalidated_by_user",
]);
export type MemoryLifecycleReasonCode = z.infer<typeof MemoryLifecycleReasonCodeSchema>;

export const MemoryLifecycleActorSchema = z.object({
  type: z.enum(["user", "system"]),
  id: IdentifierSchema,
}).strict();
export type MemoryLifecycleActor = z.infer<typeof MemoryLifecycleActorSchema>;

const memoryLifecycleReasonByAction: Record<MemoryLifecycleAction, readonly MemoryLifecycleReasonCode[]> = {
  review_activate: ["review_accepted"],
  review_reject: ["review_rejected"],
  dispute: ["conflicting_evidence", "user_challenge"],
  resolve_active: ["resolution_confirmed"],
  resolve_superseded: ["correction_accepted"],
  supersede: ["replacement_accepted"],
  revoke: ["user_requested_forget", "policy_withdrawn"],
  expire: ["retention_elapsed", "policy_expired"],
  revalidate: ["revalidated_by_user"],
};

function refineMemoryLifecycleIntent(
  value: {
    action: MemoryLifecycleAction;
    actor: z.infer<typeof MemoryLifecycleActorSchema>;
    reasonCode: MemoryLifecycleReasonCode;
    relatedMemoryId?: string | undefined;
    memoryId: string;
    validUntil?: string | undefined;
    occurredAt?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const requiresRelatedMemory = value.action === "supersede" || value.action === "resolve_superseded";
  if (requiresRelatedMemory !== (value.relatedMemoryId !== undefined)) {
    context.addIssue({ code: "custom", path: ["relatedMemoryId"], message: "related memory identity does not match the lifecycle action" });
  }
  if (value.relatedMemoryId === value.memoryId) {
    context.addIssue({ code: "custom", path: ["relatedMemoryId"], message: "a memory cannot supersede itself" });
  }
  if ((value.action === "revalidate") !== (value.validUntil !== undefined)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "only revalidation carries a renewed validity end" });
  }
  if (value.validUntil !== undefined && value.occurredAt !== undefined
    && Date.parse(value.validUntil) <= Date.parse(value.occurredAt)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "revalidated memory must have a future validity end" });
  }
  if (!memoryLifecycleReasonByAction[value.action].includes(value.reasonCode)) {
    context.addIssue({ code: "custom", path: ["reasonCode"], message: "reason code does not match the lifecycle action" });
  }
  const requiredActor = value.action === "expire"
    || (value.action === "revoke" && value.reasonCode === "policy_withdrawn")
    ? "system"
    : value.action === "dispute"
      ? undefined
      : "user";
  if (requiredActor !== undefined && value.actor.type !== requiredActor) {
    context.addIssue({ code: "custom", path: ["actor", "type"], message: "actor type is not authorized for the lifecycle action" });
  }
}

export const MemoryLifecycleCommandSchema = z.object({
  ownerId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  expectedSequence: z.number().int().nonnegative(),
  action: MemoryLifecycleActionSchema,
  actor: MemoryLifecycleActorSchema,
  reasonCode: MemoryLifecycleReasonCodeSchema,
  relatedMemoryId: IdentifierSchema.optional(),
  validUntil: IsoDateTimeSchema.optional(),
  idempotencyKey: IdentifierSchema,
}).strict().superRefine((value, context) => refineMemoryLifecycleIntent(value, context));
export type MemoryLifecycleCommand = z.infer<typeof MemoryLifecycleCommandSchema>;

const memoryLifecycleDraftFields = {
  schemaVersion: z.literal("tracegraph.memory-lifecycle-event.v1"),
  eventType: z.literal("memory.lifecycle.transitioned"),
  ownerId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  action: MemoryLifecycleActionSchema,
  fromStatus: MemoryStatusV2Schema,
  toStatus: MemoryStatusV2Schema,
  actor: MemoryLifecycleActorSchema,
  reasonCode: MemoryLifecycleReasonCodeSchema,
  relatedMemoryId: IdentifierSchema.optional(),
  /** Required only when an expired record is explicitly revalidated. */
  validUntil: IsoDateTimeSchema.optional(),
  idempotencyKey: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
};

const memoryLifecycleEventFields = {
  ...memoryLifecycleDraftFields,
  eventId: IdentifierSchema,
  sequence: z.number().int().positive(),
  previousEventHash: Sha256Schema.optional(),
  eventHash: Sha256Schema,
};

function refineMemoryLifecycleEvent(
  value: z.infer<z.ZodObject<typeof memoryLifecycleEventFields>>,
  context: z.RefinementCtx,
): void {
  const transition = MEMORY_LIFECYCLE_TRANSITIONS[value.action];
  if (!transition.from.includes(value.fromStatus) || transition.to !== value.toStatus) {
    context.addIssue({ code: "custom", path: ["action"], message: "action does not match the lifecycle status transition" });
  }
  refineMemoryLifecycleIntent(value, context);
}

export const MemoryLifecycleEventDraftSchema = z.object({
  ...memoryLifecycleDraftFields,
  expectedSequence: z.number().int().nonnegative(),
}).strict();
export type MemoryLifecycleEventDraft = z.infer<typeof MemoryLifecycleEventDraftSchema>;

export const MemoryLifecycleEventSchema = z.object(memoryLifecycleEventFields)
  .strict()
  .superRefine(refineMemoryLifecycleEvent);
export type MemoryLifecycleEvent = z.infer<typeof MemoryLifecycleEventSchema>;

/** Exact pointer to a canonical, hash-validated Run event used as evidence. */
export const MemoryRunEvidenceRefSchema = z.object({
  kind: z.literal("run_event"),
  projectId: IdentifierSchema,
  runId: IdentifierSchema,
  sessionId: IdentifierSchema.optional(),
  eventId: IdentifierSchema,
  sequence: z.number().int().positive(),
  eventType: z.string().min(1).max(100),
  eventHash: Sha256Schema,
}).strict();
export type MemoryRunEvidenceRef = z.infer<typeof MemoryRunEvidenceRefSchema>;

export const MemoryProvenanceEvidenceRefSchema = z.union([
  SourceRefSchema,
  MemoryRunEvidenceRefSchema,
]);
export type MemoryProvenanceEvidenceRef = z.infer<typeof MemoryProvenanceEvidenceRefSchema>;

export const MemoryRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  memoryId: IdentifierSchema,
  version: z.number().int().positive(),
  kind: MemoryKindV2Schema,
  claim: NonEmptyStringSchema.max(8_000),
  contentArtifactRef: ArtifactRefSchema.optional(),
  contentDigest: Sha256Schema.optional(),
  normalizedKey: NonEmptyStringSchema.max(500).optional(),
  status: MemoryStatusV2Schema,
  scope: z.object({
    ownerId: IdentifierSchema,
    workspaceId: IdentifierSchema.optional(),
    projectId: IdentifierSchema.optional(),
    sessionId: IdentifierSchema.optional(),
    /** Retains narrow G-21 Run scope during review-gated migration. */
    runId: IdentifierSchema.optional(),
    visibility: z.enum(["private", "workspace", "exportable"]),
  }).strict().superRefine((value, context) => {
    if (value.visibility === "workspace" && value.workspaceId === undefined) {
      context.addIssue({ code: "custom", path: ["workspaceId"], message: "workspace visibility requires a workspace id" });
    }
    if (value.runId !== undefined && value.projectId === undefined) {
      context.addIssue({ code: "custom", path: ["projectId"], message: "Run scope requires a project id" });
    }
  }),
  provenance: z.object({
    origin: z.enum(["user", "repository", "tool", "external", "system", "model_inference", "fixture"]),
    evidenceRefs: z.array(MemoryProvenanceEvidenceRefSchema),
    createdBy: z.object({
      type: z.enum(["user", "tool", "model", "system", "unknown"]),
      id: IdentifierSchema,
    }).strict(),
    createdFromEpisode: IdentifierSchema.optional(),
  }).strict(),
  assessment: z.object({
    sourceTrust: z.enum(["authoritative", "trusted", "untrusted", "unknown"]),
    inferenceConfidence: z.number().finite().min(0).max(1).optional(),
    verification: z.enum(["verified", "corroborated", "asserted", "inferred", "unclassified"]),
  }).strict(),
  validity: z.object({
    validFrom: IsoDateTimeSchema,
    validUntil: IsoDateTimeSchema.optional(),
    applicability: z.array(NonEmptyStringSchema.max(500)),
    invalidators: z.array(NonEmptyStringSchema.max(500)),
  }).strict().superRefine((value, context) => {
    if (value.validUntil !== undefined && Date.parse(value.validUntil) < Date.parse(value.validFrom)) {
      context.addIssue({ code: "custom", path: ["validUntil"], message: "validUntil cannot precede validFrom" });
    }
  }),
  governance: z.object({
    sensitivity: z.enum(["public", "internal", "personal", "secret", "unknown"]),
    consent: z.enum(["explicit", "policy", "none"]),
    retentionPolicy: NonEmptyStringSchema.max(200),
    allowModelUse: z.boolean(),
    allowExport: z.boolean(),
  }).strict().superRefine((value, context) => {
    if (value.consent === "none" && (value.allowModelUse || value.allowExport)) {
      context.addIssue({ code: "custom", path: ["consent"], message: "without consent, model use and export must be disabled" });
    }
    if ((value.sensitivity === "secret" || value.sensitivity === "unknown") && (value.allowModelUse || value.allowExport)) {
      context.addIssue({ code: "custom", path: ["sensitivity"], message: "secret or unclassified memory cannot be used or exported" });
    }
  }),
  lineage: z.object({
    supersedes: z.array(IdentifierSchema),
    contradictedBy: z.array(IdentifierSchema),
    derivedFrom: z.array(IdentifierSchema),
  }).strict(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt cannot precede createdAt" });
  }
  if (value.kind === "legacy_unclassified"
    && (value.status !== "candidate" && value.status !== "revoked"
      || value.governance.allowModelUse || value.governance.allowExport)) {
    context.addIssue({ code: "custom", path: ["kind"], message: "legacy unclassified memory must remain a non-usable candidate or revoked record" });
  }
  if (value.kind === "declared_identity" && value.provenance.origin !== "user") {
    context.addIssue({ code: "custom", path: ["provenance", "origin"], message: "declared identity must originate from the user" });
  }
  if (value.provenance.origin === "model_inference" && value.provenance.evidenceRefs.length === 0) {
    context.addIssue({ code: "custom", path: ["provenance", "evidenceRefs"], message: "model inference requires evidence" });
  }
  for (const [name, ids] of Object.entries(value.lineage)) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["lineage", name], message: "lineage ids must be unique" });
    }
    if (ids.includes(value.memoryId)) {
      context.addIssue({ code: "custom", path: ["lineage", name], message: "lineage cannot reference the same memory" });
    }
  }
});
export type MemoryRecordV2 = z.infer<typeof MemoryRecordV2Schema>;

/** A review-gated, lossless migration artifact; it is not a canonical record. */
export const MemoryRecordV1MigrationEnvelopeSchema = z.object({
  schemaVersion: z.literal("tracegraph.memory-migration.v2"),
  record: MemoryRecordV2Schema,
  source: z.object({
    schemaVersion: z.literal("tracegraph.memory-record.v1"),
    record: MemoryRecordV1SourceSchema,
  }).strict(),
  reviewRequired: z.literal(true),
  migratedAt: IsoDateTimeSchema,
}).strict();
export type MemoryRecordV1MigrationEnvelope = z.infer<typeof MemoryRecordV1MigrationEnvelopeSchema>;

export function migrateMemoryRecordV1ToV2(
  recordValue: unknown,
  options: { ownerId: string; migratedAt: string },
): MemoryRecordV1MigrationEnvelope {
  const sourceSnapshot = MemoryRecordV1SourceSchema.parse(recordValue);
  const sourceRecord = MemoryRecordV1Schema.parse(sourceSnapshot);
  const ownerId = IdentifierSchema.parse(options.ownerId);
  const migratedAt = IsoDateTimeSchema.parse(options.migratedAt);
  const record = MemoryRecordV2Schema.parse({
    schemaVersion: 2,
    memoryId: sourceRecord.memory_id,
    version: sourceRecord.version,
    kind: "legacy_unclassified",
    claim: sourceRecord.content,
    ...(sourceRecord.content_hash === undefined ? {} : { contentDigest: sourceRecord.content_hash }),
    // Imported content stays a candidate until a user reviews the source and
    // supplies the missing V2 kind, consent, and usage policy.
    status: "candidate",
    scope: {
      ownerId,
      ...(sourceRecord.scope.project_id === undefined ? {} : { projectId: sourceRecord.scope.project_id }),
      ...(sourceRecord.scope.run_id === undefined ? {} : { runId: sourceRecord.scope.run_id }),
      visibility: "private",
    },
    provenance: {
      origin: sourceRecord.origin,
      evidenceRefs: sourceRecord.source_refs,
      createdBy: { type: "unknown", id: "actor:legacy-unknown" },
    },
    assessment: {
      sourceTrust: sourceRecord.trust === "quarantined" ? "unknown" : sourceRecord.trust,
      verification: "unclassified",
    },
    validity: {
      validFrom: sourceRecord.created_at,
      ...(sourceRecord.expires_at === undefined ? {} : { validUntil: sourceRecord.expires_at }),
      applicability: [],
      invalidators: [],
    },
    governance: {
      sensitivity: "unknown",
      consent: "none",
      retentionPolicy: "legacy-unreviewed",
      allowModelUse: false,
      allowExport: false,
    },
    lineage: {
      supersedes: sourceRecord.supersedes,
      contradictedBy: [],
      derivedFrom: [],
    },
    createdAt: sourceRecord.created_at,
    updatedAt: sourceRecord.created_at,
  });
  return MemoryRecordV1MigrationEnvelopeSchema.parse({
    schemaVersion: "tracegraph.memory-migration.v2",
    record,
    source: { schemaVersion: "tracegraph.memory-record.v1", record: sourceSnapshot },
    reviewRequired: true,
    migratedAt,
  });
}

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

/** Evidence identity copied into Context without copying source descriptions. */
export const MemoryEvidenceReferenceSchema = z.object({
  source_id: IdentifierSchema,
  source_type: SourceRefSchema.shape.source_type,
  trust: TrustLevelSchema,
  artifact_ref: ArtifactRefSchema.optional(),
}).strict();
export type MemoryEvidenceReference = z.infer<typeof MemoryEvidenceReferenceSchema>;

/** Exact immutable Memory record version that supplied a retrieved chunk. */
export const MemoryVersionReferenceSchema = z.object({
  record_schema_version: z.enum(["tracegraph.memory-record.v1", "tracegraph.memory-record.v2"]),
  memory_id: IdentifierSchema,
  version: z.number().int().positive(),
  content_hash: Sha256Schema,
  evidence_refs: z.array(MemoryEvidenceReferenceSchema).min(1).max(128),
}).strict();
export type MemoryVersionReference = z.infer<typeof MemoryVersionReferenceSchema>;

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
  /** Present only when the indexed source resolves to an admitted Memory record. */
  memory_ref: MemoryVersionReferenceSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.end_line < value.start_line) {
    context.addIssue({ code: "custom", path: ["end_line"], message: "end line cannot precede start line" });
  }
  if (value.source_path.startsWith("memory/")) {
    const memoryRefPath = value.memory_ref === undefined
      ? undefined
      : `memory/${encodeURIComponent(value.memory_ref.memory_id)}.md`;
    if (memoryRefPath === undefined || memoryRefPath !== value.source_path) {
      context.addIssue({
        code: "custom",
        path: ["memory_ref"],
        message: "indexed Memory sources require the exact canonical record identity and version",
      });
    }
  }
  if (value.memory_ref !== undefined && !value.source_path.startsWith("memory/")) {
    context.addIssue({
      code: "custom",
      path: ["memory_ref"],
      message: "canonical Memory identity cannot be attached to a non-Memory source path",
    });
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
