import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryRecordV2Schema,
  type MemoryRecordV2,
} from "@tracegraph/contracts";
import { sha256 } from "../../kernel/crypto.js";
import { JsonlEventLedger } from "../evidence/runtime-service.js";
import { MemoryControlService, JsonlMemoryV2RecordStore } from "./memory-control.js";
import { MemoryLifecycleService } from "./memory-lifecycle.js";
import {
  LegacyCapsuleError,
  acceptLegacyCapsuleImport,
  buildLegacyCapsule,
  previewLegacyCapsuleImport,
  verifyLegacyCapsule,
} from "./legacy-capsule.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const localScope = { allowedScopeIds: ["project:local"] } as const;

describe("Legacy Capsule v1", () => {
  it("builds and verifies a deterministic bounded bundle, redacting sensitive fields", () => {
    const source = makeExportMemory("memory:portable", "private_token=very-secret-capsule-value");
    const input = exportRequest(source);
    input.consent.purpose = "Carry data with private_token=metadata-secret-value";
    const first = buildLegacyCapsule(input);
    const second = buildLegacyCapsule(input);
    const verified = verifyLegacyCapsule(first.files);

    expect(first.files).toEqual(second.files);
    expect(first.capsuleDigest).toBe(verified.capsuleDigest);
    expect(verified.manifest).toMatchObject({
      schema_version: "tracegraph.legacy-capsule.v1",
      included: { memory_count: 1, experience_count: 0 },
      checksum_algorithm: "sha256",
    });
    expect(verified.memories[0]?.claim).not.toContain("very-secret-capsule-value");
    expect(verified.memories[0]?.claim).toContain("[REDACTED]");
    expect(JSON.stringify(first.files)).not.toContain("metadata-secret-value");
    expect(verified.manifest.consent.purpose).toContain("[REDACTED]");
    expect(verified.memories[0]?.contentDigest).toBe(sha256(verified.memories[0]!.claim));
    expect(verified.manifest.redaction.redacted_value_count).toBeGreaterThan(0);
    expect(first.files["SHA256SUMS"]).toContain("  manifest.yaml\n");
    expect(first.files).not.toHaveProperty("evidence/events.jsonl");
  });

  it("fails closed on changed bytes, unsafe paths, and ineligible export selections", () => {
    const source = makeExportMemory("memory:tamper", "A reviewed claim.");
    const bundle = buildLegacyCapsule(exportRequest(source));
    const changed = { ...bundle.files, "memories.jsonl": `${bundle.files["memories.jsonl"]} ` };
    expect(() => verifyLegacyCapsule(changed)).toThrowError(expect.objectContaining({ code: "legacy_capsule_checksum_mismatch" }));

    const unsafe = { ...bundle.files, "../README.md": bundle.files["README.md"]! };
    delete (unsafe as Record<string, string>)["README.md"];
    expect(() => verifyLegacyCapsule(unsafe)).toThrowError(LegacyCapsuleError);

    const notExportable = MemoryRecordV2Schema.parse({ ...source, governance: { ...source.governance, allowExport: false } });
    expect(() => buildLegacyCapsule(exportRequest(notExportable))).toThrowError(expect.objectContaining({ code: "legacy_capsule_item_not_exportable" }));
  });

  it("rejects unsupported versions and noncanonical JSONL even when checksums are recomputed", () => {
    const source = makeExportMemory("memory:format", "A canonical row.");
    const bundle = buildLegacyCapsule(exportRequest(source));
    const unsupportedManifest = bundle.files["manifest.yaml"]!.replace(
      "tracegraph.legacy-capsule.v1",
      "tracegraph.legacy-capsule.v2",
    );
    const unsupported = resealFiles({ ...bundle.files, "manifest.yaml": unsupportedManifest });
    expect(() => verifyLegacyCapsule(unsupported)).toThrowError(expect.objectContaining({ code: "legacy_capsule_unsupported" }));

    const noncanonicalRows = `${bundle.files["memories.jsonl"]!.trimEnd().replace(
      '"claim":"A canonical row."',
      '"claim":"A canonical row.","claim":"A canonical row."',
    )}\n`;
    const manifestWithUpdatedPayload = bundle.files["manifest.yaml"]!.replace(
      /(  memories\.jsonl: )sha256:[a-f0-9]{64}/u,
      `$1${sha256(noncanonicalRows)}`,
    );
    const duplicateKeyBundle = resealFiles({
      ...bundle.files,
      "manifest.yaml": manifestWithUpdatedPayload,
      "memories.jsonl": noncanonicalRows,
    });
    expect(() => verifyLegacyCapsule(duplicateKeyBundle)).toThrowError(expect.objectContaining({ code: "legacy_capsule_invalid" }));
  });

  it("exports only the explicitly selected source rows", () => {
    const selected = makeExportMemory("memory:selected", "Selected claim.");
    const omitted = makeExportMemory("memory:omitted", "Unselected claim.");
    const input = exportRequest(selected);
    input.memories.push(omitted);

    const bundle = buildLegacyCapsule(input);
    const verified = verifyLegacyCapsule(bundle.files);

    expect(verified.memories.map(({ sourceMemoryId }) => sourceMemoryId)).toEqual([selected.memoryId]);
  });

  it("quarantines a review diff and writes only explicitly accepted untrusted Memory candidates", async () => {
    const source = makeExportMemory("memory:import-this", "A portable reviewed claim.");
    const bundle = buildLegacyCapsule(exportRequest(source));
    const { service, ledger } = await createMemoryControlService();
    const quarantine = previewLegacyCapsuleImport(bundle.files, [], "project:local");
    const entry = quarantine.entries[0]!;
    expect(entry).toMatchObject({ sourceId: source.memoryId, classification: "new" });
    expect((await service.list(localScope)).items).toHaveLength(0);

    const request = acceptRequest(quarantine, [entry.entryId]);
    const accepted = await acceptLegacyCapsuleImport(quarantine, bundle.files, request, service, localScope);
    const imported = accepted.importedMemories[0]!;
    expect(imported.record).toMatchObject({
      status: "candidate",
      scope: { ownerId: "owner:local", projectId: "project:local", visibility: "private" },
      provenance: {
        origin: "external",
        evidenceRefs: [{ source_type: "memory", trust: "untrusted" }],
      },
      assessment: { sourceTrust: "untrusted", verification: "unclassified" },
      governance: { consent: "none", allowModelUse: false, allowExport: false },
    });
    const events = await ledger.listMemoryControl("owner:local", imported.record.memoryId);
    expect(events).toMatchObject([{
      action: "imported_candidate_created",
      sourceCapsuleId: bundle.capsuleId,
      sourceCapsuleDigest: bundle.capsuleDigest,
      sourceMemoryId: source.memoryId,
    }]);
    expect(JSON.stringify(events)).not.toContain(source.claim);

    const retried = await acceptLegacyCapsuleImport(quarantine, bundle.files, request, service, localScope);
    expect(retried.importedMemories[0]?.record.memoryId).toBe(imported.record.memoryId);
    expect(retried.alreadyImportedMemoryIds).toEqual([imported.record.memoryId]);
    expect((await ledger.listMemoryControl("owner:local", imported.record.memoryId)).filter((event) => event.action === "imported_candidate_created")).toHaveLength(1);
  });

  it("classifies duplicates and conflicts, and refuses a stale review before writing", async () => {
    const source = makeExportMemory("memory:diff", "A capsule claim.", "key:shared");
    const bundle = buildLegacyCapsule(exportRequest(source));
    const exact = makeLocalMemory("memory:exact", source.claim, "key:shared");
    const conflict = makeLocalMemory("memory:conflict", "A different local claim.", "key:shared");
    const duplicatePreview = previewLegacyCapsuleImport(bundle.files, [exact], "project:local");
    const conflictPreview = previewLegacyCapsuleImport(bundle.files, [conflict], "project:local");
    expect(duplicatePreview.entries[0]?.classification).toBe("duplicate");
    expect(conflictPreview.entries[0]?.classification).toBe("conflict");

    const { service } = await createMemoryControlService();
    const quarantine = previewLegacyCapsuleImport(bundle.files, [], "project:local");
    await service.createCandidate({
      command_id: "command:concurrent-conflict",
      kind: "lesson",
      claim: "A different local claim.",
      normalized_key: "key:shared",
      project_id: "project:local",
    }, localScope);
    await expect(acceptLegacyCapsuleImport(
      quarantine,
      bundle.files,
      acceptRequest(quarantine, [quarantine.entries[0]!.entryId]),
      service,
      localScope,
    )).rejects.toThrowError(expect.objectContaining({ code: "legacy_capsule_review_stale" }));
    expect((await service.list(localScope)).items).toHaveLength(1);
  });

  it("returns accepted Experience rows only as candidate-only external-evidence results", async () => {
    const sourceCase = makeExperienceCase();
    const bundle = buildLegacyCapsule(exportRequest(undefined, sourceCase));
    const { service } = await createMemoryControlService();
    const quarantine = previewLegacyCapsuleImport(bundle.files, [], "project:local");
    const experienceRow = quarantine.entries[0]!;
    expect(experienceRow.classification).toBe("experience_candidate");
    const accepted = await acceptLegacyCapsuleImport(
      quarantine,
      bundle.files,
      acceptRequest(quarantine, [experienceRow.entryId]),
      service,
      localScope,
    );
    expect(accepted.importedExperiences[0]).toMatchObject({
      sourceCapsuleId: bundle.capsuleId,
      sourceCaseId: sourceCase.caseId,
      externalEvidence: true,
      experienceCase: { status: "candidate", version: 1, extractorId: "legacy-capsule-import:v1" },
    });
    expect((await service.list(localScope)).items).toHaveLength(0);
  });

  it("writes only Memory rows explicitly selected from the review diff", async () => {
    const first = makeExportMemory("memory:first", "First claim.");
    const second = makeExportMemory("memory:second", "Second claim.");
    const input = exportRequest(first);
    input.memories.push(second);
    input.selectedMemoryIds.push(second.memoryId);
    const bundle = buildLegacyCapsule(input);
    const { service } = await createMemoryControlService();
    const quarantine = previewLegacyCapsuleImport(bundle.files, [], "project:local");
    const selected = quarantine.entries.find(({ sourceId }) => sourceId === second.memoryId)!;

    const accepted = await acceptLegacyCapsuleImport(
      quarantine,
      bundle.files,
      acceptRequest(quarantine, [selected.entryId]),
      service,
      localScope,
    );

    expect(accepted.importedMemories).toHaveLength(1);
    expect(accepted.importedMemories[0]?.record.claim).toBe(second.claim);
    expect((await service.list(localScope)).items).toHaveLength(1);
  });
});

function exportRequest(memory?: MemoryRecordV2, experienceCase?: ReturnType<typeof makeExperienceCase>) {
  return {
    capsuleId: "capsule:test:v1",
    createdAt: "2026-10-01T00:00:00.000Z",
    sourceInstanceId: "instance:origin",
    principals: {
      contentCreator: { id: "user:origin" },
      exportOperator: { id: "user:origin" },
      describedSubject: { id: "subject:origin" },
      authorizedBy: { id: "user:origin" },
    },
    consent: {
      consentedBy: "user:origin",
      consentedAt: "2026-10-01T00:00:00.000Z",
      purpose: "Carry selected knowledge to another local runtime.",
      externalCopyWarningAcknowledged: true as const,
    },
    memories: memory === undefined ? [] : [memory],
    selectedMemoryIds: memory === undefined ? [] : [memory.memoryId],
    experiences: experienceCase === undefined ? [] : [experienceCase],
    selectedExperienceCaseIds: experienceCase === undefined ? [] : [experienceCase.caseId],
  };
}

function acceptRequest(quarantine: ReturnType<typeof previewLegacyCapsuleImport>, selectedEntryIds: string[]) {
  return {
    capsuleId: quarantine.capsuleId,
    capsuleDigest: quarantine.capsuleDigest,
    reviewDigest: quarantine.reviewDigest,
    importId: "import:local:test-v1",
    selectedEntryIds,
  };
}

function resealFiles(files: Record<string, string>): Record<string, string> {
  const contentFiles = Object.fromEntries(Object.entries(files).filter(([path]) => path !== "SHA256SUMS"));
  return {
    ...contentFiles,
    "SHA256SUMS": `${Object.keys(contentFiles).sort().map((path) => `${sha256(contentFiles[path]!).slice("sha256:".length)}  ${path}`).join("\n")}\n`,
  };
}

function makeExportMemory(memoryId: string, claim: string, normalizedKey = "key:portable"): MemoryRecordV2 {
  return MemoryRecordV2Schema.parse({
    schemaVersion: 2,
    memoryId,
    version: 1,
    kind: "lesson",
    claim,
    contentDigest: sha256(claim),
    normalizedKey,
    status: "active",
    scope: { ownerId: "owner:origin", projectId: "project:origin", visibility: "private" },
    provenance: {
      origin: "user",
      evidenceRefs: [{ source_id: "source:origin", source_type: "user", trust: "trusted" }],
      createdBy: { type: "user", id: "user:origin" },
    },
    assessment: { sourceTrust: "trusted", verification: "verified" },
    validity: { validFrom: "2026-01-01T00:00:00.000Z", applicability: [], invalidators: [] },
    governance: {
      sensitivity: "personal",
      consent: "explicit",
      retentionPolicy: "user-managed",
      allowModelUse: false,
      allowExport: true,
    },
    lineage: { supersedes: [], contradictedBy: [], derivedFrom: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function makeLocalMemory(memoryId: string, claim: string, normalizedKey: string): MemoryRecordV2 {
  return MemoryRecordV2Schema.parse({
    ...makeExportMemory(memoryId, claim, normalizedKey),
    scope: { ownerId: "owner:local", projectId: "project:local", visibility: "private" },
    governance: {
      sensitivity: "personal",
      consent: "none",
      retentionPolicy: "user-managed",
      allowModelUse: false,
      allowExport: false,
    },
  });
}

function makeExperienceCase() {
  const evidenceRef = {
    kind: "run_event" as const,
    projectId: "project:origin",
    runId: "run:origin",
    eventId: "event:origin:1",
    sequence: 1,
    eventType: "run.completed",
    eventHash: sha256("external-event"),
  };
  return {
    schemaVersion: "tracegraph.experience-case.v1" as const,
    caseId: "experience:validated-origin",
    version: 1,
    projectId: "project:origin",
    episodeId: "episode:origin",
    sourceDigest: sha256("origin-source"),
    extractorId: "experience-extractor:origin",
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
  };
}

async function createMemoryControlService() {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-legacy-capsule-"));
  roots.push(root);
  const ledger = new JsonlEventLedger(join(root, "events"));
  const records = new JsonlMemoryV2RecordStore(join(root, "memory-v2"));
  await records.initialize();
  const service = new MemoryControlService({
    ownerId: "owner:local",
    actorId: "user:local",
    records,
    journal: ledger,
    lifecycle: new MemoryLifecycleService({ journal: ledger, now: () => new Date("2026-10-01T12:00:00.000Z") }),
    now: () => new Date("2026-10-01T12:00:00.000Z"),
  });
  return { service, ledger, records };
}
