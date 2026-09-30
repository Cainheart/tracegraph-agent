import { describe, expect, it } from "vitest";
import {
  MemoryLifecycleEventSchema,
  MemoryRecordV1Schema,
  MemoryRecordV1MigrationEnvelopeSchema,
  MemoryRecordV2Schema,
  migrateMemoryRecordV1ToV2,
} from "./index.js";

const hash = `sha256:${"a".repeat(64)}`;
const sourceRef = { source_id: "source:user-1", source_type: "user" as const, trust: "trusted" as const };

const v1Record = {
  memory_id: "memory:legacy-1",
  content: "Use concise explanations.",
  scope: { kind: "run" as const, project_id: "project:one", run_id: "run:one" },
  origin: "user" as const,
  trust: "trusted" as const,
  version: 2,
  status: "confirmed" as const,
  source_refs: [sourceRef],
  created_at: "2026-09-20T00:00:00.000Z",
  expires_at: "2027-09-20T00:00:00.000Z",
  supersedes: ["memory:legacy-0"],
  content_hash: hash,
  candidate_id: "candidate:legacy-1",
  candidate_hash: hash,
  admission_id: "admission:legacy-1",
  admitted_at: "2026-09-20T00:01:00.000Z",
  admission_reason: "explicitly confirmed",
};

const v2Record = {
  schemaVersion: 2,
  memoryId: "memory:v2-1",
  version: 1,
  kind: "preference",
  claim: "Prefer concise explanations.",
  contentDigest: hash,
  status: "active",
  scope: { ownerId: "owner:one", projectId: "project:one", visibility: "private" },
  provenance: {
    origin: "user",
    evidenceRefs: [sourceRef],
    createdBy: { type: "user", id: "user:one" },
  },
  assessment: { sourceTrust: "authoritative", verification: "asserted" },
  validity: {
    validFrom: "2026-09-20T00:00:00.000Z",
    applicability: ["explanations"],
    invalidators: [],
  },
  governance: {
    sensitivity: "personal",
    consent: "explicit",
    retentionPolicy: "review-annually",
    allowModelUse: true,
    allowExport: false,
  },
  lineage: { supersedes: [], contradictedBy: [], derivedFrom: [] },
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

describe("Memory Contract V2", () => {
  it("keeps the V1 reader strict and preserves the complete legacy shape", () => {
    expect(MemoryRecordV1Schema.parse(v1Record)).toEqual(v1Record);
    expect(() => MemoryRecordV1Schema.parse({ ...v1Record, extra: true })).toThrow();
    const { supersedes: _defaulted, ...withoutSupersedes } = v1Record;
    expect(MemoryRecordV1Schema.parse(withoutSupersedes).supersedes).toEqual([]);
  });

  it("accepts a valid V2 record and rejects status, scope, provenance, and lineage drift", () => {
    expect(MemoryRecordV2Schema.parse(v2Record)).toEqual(v2Record);
    expect(() => MemoryRecordV2Schema.parse({ ...v2Record, status: "confirmed" })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      scope: { ...v2Record.scope, ownerId: undefined },
    })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      scope: { ownerId: "owner:one", runId: "run:one", visibility: "private" },
    })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      provenance: { ...v2Record.provenance, origin: "model_inference", evidenceRefs: [] },
    })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      lineage: { supersedes: ["memory:v2-1"], contradictedBy: [], derivedFrom: [] },
    })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      lineage: { supersedes: ["memory:older", "memory:older"], contradictedBy: [], derivedFrom: [] },
    })).toThrow();
  });

  it("validates validity intervals and governance consent before records can be used", () => {
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      validity: {
        ...v2Record.validity,
        validUntil: "2026-09-19T00:00:00.000Z",
      },
    })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      governance: { ...v2Record.governance, consent: "none", allowModelUse: true },
    })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      governance: { ...v2Record.governance, sensitivity: "secret", allowExport: true },
    })).toThrow();
    expect(() => MemoryRecordV2Schema.parse({
      ...v2Record,
      governance: { ...v2Record.governance, sensitivity: "unknown", allowModelUse: true },
    })).toThrow();
  });

  it("validates owner-scoped lifecycle events and rejects illegal status/action pairs", () => {
    const event = {
      schemaVersion: "tracegraph.memory-lifecycle-event.v1",
      eventType: "memory.lifecycle.transitioned",
      eventId: "memory-event:1",
      ownerId: "owner:one",
      memoryId: "memory:v2-1",
      memoryVersion: 1,
      sequence: 1,
      action: "review_activate",
      fromStatus: "candidate",
      toStatus: "active",
      actor: { type: "user", id: "user:one" },
      reasonCode: "review_accepted",
      idempotencyKey: "memory-transition:1",
      occurredAt: "2026-09-21T00:00:00.000Z",
      eventHash: hash,
    };
    expect(MemoryLifecycleEventSchema.parse(event)).toEqual(event);
    expect(() => MemoryLifecycleEventSchema.parse({ ...event, toStatus: "revoked" })).toThrow();
    expect(() => MemoryLifecycleEventSchema.parse({ ...event, actor: { type: "system", id: "system:one" } })).toThrow();
    expect(() => MemoryLifecycleEventSchema.parse({ ...event, reasonCode: "user_requested_forget" })).toThrow();
    expect(() => MemoryLifecycleEventSchema.parse({ ...event, relatedMemoryId: "memory:v2-1" })).toThrow();
  });

  it("allows an unclassified migration candidate to be revoked without ever becoming usable", () => {
    const migrated = migrateMemoryRecordV1ToV2(v1Record, {
      ownerId: "owner:one",
      migratedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(MemoryRecordV2Schema.parse({ ...migrated.record, status: "revoked" }).status).toBe("revoked");
    expect(() => MemoryRecordV2Schema.parse({ ...migrated.record, status: "active" })).toThrow();
  });

  it("preserves every V1 field in a review-gated migration envelope without granting use", () => {
    const migrated = migrateMemoryRecordV1ToV2(v1Record, {
      ownerId: "owner:one",
      migratedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(MemoryRecordV1MigrationEnvelopeSchema.parse(migrated)).toEqual(migrated);
    expect(migrated.source.record).toEqual(v1Record);
    expect(migrated.record).toMatchObject({
      memoryId: v1Record.memory_id,
      claim: v1Record.content,
      status: "candidate",
      kind: "legacy_unclassified",
      scope: { ownerId: "owner:one", projectId: "project:one", runId: "run:one", visibility: "private" },
      governance: {
        consent: "none",
        sensitivity: "unknown",
        allowModelUse: false,
        allowExport: false,
      },
      lineage: { supersedes: v1Record.supersedes },
    });
    expect(migrated.reviewRequired).toBe(true);
    expect(() => migrateMemoryRecordV1ToV2(v1Record, {
      ownerId: "",
      migratedAt: "2026-09-30T00:00:00.000Z",
    })).toThrow();

    const { supersedes: _legacyDefault, ...withoutDefaultedField } = v1Record;
    const sparseMigration = migrateMemoryRecordV1ToV2(withoutDefaultedField, {
      ownerId: "owner:one",
      migratedAt: "2026-09-30T00:00:00.000Z",
    });
    expect("supersedes" in sparseMigration.source.record).toBe(false);
    expect(sparseMigration.record.lineage.supersedes).toEqual([]);
  });
});
