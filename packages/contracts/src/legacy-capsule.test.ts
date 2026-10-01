import { describe, expect, it } from "vitest";
import {
  LEGACY_CAPSULE_SCHEMA_VERSION,
  LegacyCapsuleAcceptRequestSchema,
  LegacyCapsuleAcceptedExperienceSchema,
  LegacyCapsuleExperienceEntrySchema,
  LegacyCapsuleExportRequestSchema,
  LegacyCapsuleManifestSchema,
  LegacyCapsuleMemoryEntrySchema,
  LegacyCapsuleQuarantineSchema,
  LegacyCapsuleRelativePathSchema,
  LegacyCapsuleReviewEntrySchema,
} from "./legacy-capsule.js";
import { MemoryRecordV2Schema, type MemoryRecordV2 } from "./memory.js";

const hash = `sha256:${"a".repeat(64)}`;
const createdAt = "2026-10-01T00:00:00.000Z";

describe("Legacy Capsule v1 contracts", () => {
  it("accepts only canonical relative capsule paths", () => {
    expect(LegacyCapsuleRelativePathSchema.parse("policies/usage-consent.yaml"))
      .toBe("policies/usage-consent.yaml");
    for (const path of ["/etc/passwd", "\\\\server\\share", "C:/capsule/manifest.yaml", "a//b", "./a", "a/../b"]) {
      expect(LegacyCapsuleRelativePathSchema.safeParse(path).success, path).toBe(false);
    }
  });

  it("keeps a Memory entry faithful to its source and refuses usable unclassified rows", () => {
    const entry = {
      schemaVersion: "tracegraph.legacy-capsule-memory.v1" as const,
      sourceMemoryId: "memory:v2-1",
      sourceVersion: 1,
      kind: "preference",
      claim: "Prefer concise explanations.",
      contentDigest: hash,
      normalizedKey: "preferences/style",
      sourceStatus: "active",
      evidenceRefs: [{ source_id: "source:user-1", source_type: "user", trust: "trusted" }],
      sourceTrust: "authoritative",
      verification: "asserted",
      validFrom: createdAt,
      validUntil: "2027-10-01T00:00:00.000Z",
      sensitivity: "personal",
      createdAt,
    };
    expect(LegacyCapsuleMemoryEntrySchema.parse(entry)).toEqual(entry);
    const { normalizedKey: _optional, validUntil: _bounded, ...required } = entry;
    expect(LegacyCapsuleMemoryEntrySchema.safeParse(required).success).toBe(true);
    expect(LegacyCapsuleMemoryEntrySchema.safeParse({
      ...entry,
      kind: "legacy_unclassified",
    }).success).toBe(false);
    expect(LegacyCapsuleMemoryEntrySchema.safeParse({
      ...entry,
      kind: "legacy_unclassified",
      sourceStatus: "candidate",
    }).success).toBe(true);
    expect(LegacyCapsuleMemoryEntrySchema.safeParse({
      ...entry,
      kind: "legacy_unclassified",
      sourceStatus: "revoked",
    }).success).toBe(true);
  });

  it("requires an Experience entry to carry its own Case identity", () => {
    const experienceCase = makeExperienceCase();
    const entry = {
      schemaVersion: "tracegraph.legacy-capsule-experience.v1" as const,
      sourceCaseId: experienceCase.caseId,
      experienceCase,
    };
    expect(LegacyCapsuleExperienceEntrySchema.parse(entry)).toEqual(entry);
    expect(LegacyCapsuleExperienceEntrySchema.safeParse({
      ...entry,
      sourceCaseId: "experience:other",
    }).success).toBe(false);
  });

  it("bounds an export request to explicit non-empty unique selections", () => {
    const request = exportRequest();
    expect(LegacyCapsuleExportRequestSchema.parse(request)).toMatchObject({
      capsuleId: "capsule:one",
      selectedMemoryIds: ["memory:v2-1"],
    });
    expect(LegacyCapsuleExportRequestSchema.safeParse({
      ...request,
      memories: [],
      selectedMemoryIds: [],
    }).success).toBe(true);
    expect(LegacyCapsuleExportRequestSchema.safeParse({
      ...request,
      selectedMemoryIds: ["memory:v2-1", "memory:v2-1"],
    }).success).toBe(false);
    expect(LegacyCapsuleExportRequestSchema.safeParse({
      ...request,
      selectedExperienceCaseIds: ["experience:one", "experience:one"],
    }).success).toBe(false);
    expect(LegacyCapsuleExportRequestSchema.safeParse({
      ...request,
      memories: [],
      selectedMemoryIds: [],
      experiences: [],
      selectedExperienceCaseIds: [],
    }).success).toBe(false);
    expect(LegacyCapsuleExportRequestSchema.safeParse({
      ...request,
      consent: { ...request.consent, consentedBy: "user:other" },
    }).success).toBe(false);
  });

  it("reports a manifest whose consent actor is not the authorizing principal", () => {
    const manifest = makeManifest();
    expect(LegacyCapsuleManifestSchema.parse(manifest)).toEqual(manifest);
    expect(LegacyCapsuleManifestSchema.safeParse({
      ...manifest,
      principals: {
        ...manifest.principals,
        authorized_by: { id: "user:other" },
      },
    }).success).toBe(false);
    expect(LegacyCapsuleManifestSchema.safeParse({
      ...manifest,
      schema_version: "tracegraph.legacy-capsule.v2",
    }).success).toBe(false);
  });

  it("quarantines a review diff without granting use, and accepts only explicit rows", () => {
    const quarantine = makeQuarantine();
    expect(LegacyCapsuleQuarantineSchema.parse(quarantine)).toEqual(quarantine);
    expect(LegacyCapsuleReviewEntrySchema.parse(quarantine.entries[0])).toEqual(quarantine.entries[0]);
    expect(LegacyCapsuleReviewEntrySchema.safeParse({
      entryId: "capsule-entry:1",
      sourceId: "memory:v2-1",
      classification: "unchanged",
      matchingMemoryIds: [],
    }).success).toBe(false);
    expect(LegacyCapsuleReviewEntrySchema.safeParse({
      ...quarantine.entries[0],
      classification: "experience_candidate",
      matchingMemoryIds: [],
    }).success).toBe(true);
    expect(LegacyCapsuleAcceptRequestSchema.parse({
      capsuleId: quarantine.capsuleId,
      capsuleDigest: quarantine.capsuleDigest,
      reviewDigest: quarantine.reviewDigest,
      importId: "import:one",
      selectedEntryIds: ["capsule-entry:1"],
    })).toMatchObject({ importId: "import:one" });
    expect(LegacyCapsuleAcceptRequestSchema.safeParse({
      capsuleId: quarantine.capsuleId,
      capsuleDigest: quarantine.capsuleDigest,
      reviewDigest: quarantine.reviewDigest,
      importId: "import:one",
      selectedEntryIds: ["capsule-entry:1", "capsule-entry:1"],
    }).success).toBe(false);
  });

  it("returns an accepted Experience row only as external candidate evidence", () => {
    const accepted = {
      sourceCapsuleId: "capsule:one",
      sourceCaseId: "experience:one",
      externalEvidence: true as const,
      experienceCase: makeExperienceCase({ status: "candidate" }),
    };
    expect(LegacyCapsuleAcceptedExperienceSchema.parse(accepted)).toEqual(accepted);
    expect(LegacyCapsuleAcceptedExperienceSchema.safeParse({
      ...accepted,
      externalEvidence: false,
    }).success).toBe(false);
  });
});

function makeExperienceCase(overrides: Record<string, unknown> = {}) {
  const evidenceRef = {
    kind: "run_event" as const,
    projectId: "project:one",
    runId: "run:one",
    eventId: "event:one:1",
    sequence: 1,
    eventType: "run.completed",
    eventHash: hash,
  };
  return {
    schemaVersion: "tracegraph.experience-case.v1" as const,
    caseId: "experience:one",
    version: 1,
    projectId: "project:one",
    episodeId: "episode:one",
    sourceDigest: hash,
    extractorId: "experience-extractor:one",
    title: "Check a bounded behavior change.",
    situation: { conditions: [{ dimension: "task", operator: "equals", value: "small change", evidenceRefs: [evidenceRef] }] },
    objective: "Confirm expected behavior.",
    actions: [{ intent: "Run a focused check.", preconditions: [], steps: [{ text: "Run the test suite.", evidenceRefs: [evidenceRef] }] }],
    outcome: { kind: "success" as const, summary: "The check passed.", evidenceRefs: [evidenceRef] },
    verification: [{ kind: "test" as const, summary: "The test passed.", evidenceRefs: [evidenceRef] }],
    counterexamples: [],
    applicability: [{ dimension: "repository", operator: "equals", value: "local", evidenceRefs: [evidenceRef] }],
    evidenceRefs: [evidenceRef],
    status: "validated" as const,
    ...overrides,
  };
}

function makeExportMemory(): MemoryRecordV2 {
  return MemoryRecordV2Schema.parse({
    schemaVersion: 2,
    memoryId: "memory:v2-1",
    version: 1,
    kind: "lesson",
    claim: "Keep capsule exports explicit.",
    contentDigest: hash,
    normalizedKey: "capsules/export",
    status: "active",
    scope: { ownerId: "owner:one", projectId: "project:one", visibility: "private" },
    provenance: {
      origin: "user",
      evidenceRefs: [{ source_id: "source:user-1", source_type: "user", trust: "trusted" }],
      createdBy: { type: "user", id: "user:one" },
    },
    assessment: { sourceTrust: "trusted", verification: "verified" },
    validity: { validFrom: createdAt, applicability: [], invalidators: [] },
    governance: {
      sensitivity: "personal",
      consent: "explicit",
      retentionPolicy: "user-managed",
      allowModelUse: false,
      allowExport: true,
    },
    lineage: { supersedes: [], contradictedBy: [], derivedFrom: [] },
    createdAt,
    updatedAt: createdAt,
  });
}

function exportRequest() {
  return {
    capsuleId: "capsule:one",
    createdAt,
    sourceInstanceId: "instance:one",
    principals: {
      contentCreator: { id: "user:one" },
      exportOperator: { id: "user:one" },
      describedSubject: { id: "subject:one" },
      authorizedBy: { id: "user:one" },
    },
    consent: {
      consentedBy: "user:one",
      consentedAt: createdAt,
      purpose: "Carry selected knowledge to another local runtime.",
      externalCopyWarningAcknowledged: true as const,
    },
    memories: [makeExportMemory()],
    selectedMemoryIds: ["memory:v2-1"],
    experiences: [makeExperienceCase()],
    selectedExperienceCaseIds: ["experience:one"],
  };
}

function makeManifest() {
  return {
    schema_version: LEGACY_CAPSULE_SCHEMA_VERSION,
    capsule_id: "capsule:one",
    created_at: createdAt,
    source_instance_id: "instance:one",
    principals: {
      content_creator: { id: "user:one" },
      export_operator: { id: "user:one" },
      described_subject: { id: "subject:one" },
      authorized_by: { id: "user:one" },
    },
    included: { scope_kinds: ["project" as const], memory_count: 1, experience_count: 0 },
    redaction: { redacted_entry_count: 0, redacted_value_count: 0, entry_digests: [] },
    required_migrations: ["memory-record-v1-to-v2"],
    consent: {
      consentedBy: "user:one",
      consentedAt: createdAt,
      purpose: "Carry selected knowledge to another local runtime.",
      externalCopyWarningAcknowledged: true as const,
    },
    payload_digests: {
      "memories.jsonl": hash,
      "experiences.jsonl": hash,
      "policies/usage-consent.yaml": hash,
      "README.md": hash,
    },
    checksum_algorithm: "sha256" as const,
  };
}

function makeQuarantine() {
  return {
    capsuleId: "capsule:one",
    capsuleDigest: hash,
    reviewDigest: hash,
    targetProjectId: "project:local",
    manifest: makeManifest(),
    entries: [{
      entryId: "capsule-entry:1",
      sourceId: "memory:v2-1",
      kind: "lesson" as const,
      claim: "Keep capsule exports explicit.",
      classification: "new" as const,
      matchingMemoryIds: [],
    }],
    importRedactedValueCount: 0,
  };
}
