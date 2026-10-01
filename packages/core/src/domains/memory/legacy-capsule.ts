import { z } from "zod";
import {
  ExperienceCaseSchema,
  LegacyCapsuleAcceptRequestSchema,
  LegacyCapsuleAcceptedExperienceSchema,
  LegacyCapsuleConsentSchema,
  LegacyCapsuleExperienceEntrySchema,
  LegacyCapsuleExportMetadataSchema,
  LegacyCapsuleExportRequestSchema,
  LegacyCapsuleManifestSchema,
  LegacyCapsuleMemoryEntrySchema,
  LegacyCapsuleQuarantineSchema,
  LegacyCapsuleRelativePathSchema,
  MemoryRecordV2Schema,
  type LegacyCapsuleAcceptedExperience,
  type LegacyCapsuleExperienceEntry,
  type LegacyCapsuleManifest,
  type LegacyCapsuleMemoryEntry,
  type LegacyCapsuleQuarantine,
  type MemoryControlItem,
  type MemoryRecordV2,
} from "@tracegraph/contracts";
import { parseDocument, stringify } from "yaml";
import type { MemoryControlScope } from "./memory-control.js";
import {
  containsSensitiveStructuredData,
  redactStructuredArtifactValue,
  sha256,
  stableStringify,
} from "../../kernel/crypto.js";

export const LEGACY_CAPSULE_README = `# TraceGraph Legacy Capsule v1

This user-curated bundle contains selected Memory and Experience records.
Checksums prove byte integrity, not author identity or factual accuracy.
Imported content remains untrusted and requires local review before use.
The bundle contains no credentials, approvals, executable permissions, raw Run events, or raw artifacts.
Copies outside the exporting instance are outside that instance's deletion control.
`;

export const LEGACY_CAPSULE_MAX_FILES = 6;
export const LEGACY_CAPSULE_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const LEGACY_CAPSULE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const LEGACY_CAPSULE_MAX_ENTRIES = 500;

const capsulePayloadPaths = [
  "memories.jsonl",
  "experiences.jsonl",
  "policies/usage-consent.yaml",
  "README.md",
] as const;
const capsuleFilePaths = ["manifest.yaml", ...capsulePayloadPaths, "SHA256SUMS"] as const;
const capsuleFilePathSet = new Set<string>(capsuleFilePaths);
const capsuleUsageConsentFileSchema = z.object({
  schema_version: LegacyCapsuleManifestSchema.shape.schema_version,
  consent: LegacyCapsuleConsentSchema,
  license: LegacyCapsuleManifestSchema.shape.license,
}).strict();

export type LegacyCapsuleFiles = Readonly<Record<string, string>>;

export interface BuiltLegacyCapsule {
  readonly files: LegacyCapsuleFiles;
  readonly capsuleId: string;
  readonly capsuleDigest: string;
  readonly manifest: LegacyCapsuleManifest;
}

export interface VerifiedLegacyCapsule extends BuiltLegacyCapsule {
  readonly memories: readonly LegacyCapsuleMemoryEntry[];
  readonly experiences: readonly LegacyCapsuleExperienceEntry[];
}

export interface LegacyCapsuleMemoryControlPort {
  list(scope: MemoryControlScope): Promise<{ readonly items: readonly MemoryControlItem[] }>;
  createImportedCandidate(input: unknown, scope: MemoryControlScope): Promise<MemoryControlItem>;
}

export interface LegacyCapsuleAcceptResult {
  readonly capsuleId: string;
  readonly capsuleDigest: string;
  readonly importedMemories: readonly MemoryControlItem[];
  readonly importedExperiences: readonly LegacyCapsuleAcceptedExperience[];
  readonly alreadyImportedMemoryIds: readonly string[];
}

export type LegacyCapsuleErrorCode =
  | "legacy_capsule_invalid"
  | "legacy_capsule_unsupported"
  | "legacy_capsule_size_exceeded"
  | "legacy_capsule_checksum_mismatch"
  | "legacy_capsule_item_not_exportable"
  | "legacy_capsule_selection_invalid"
  | "legacy_capsule_review_stale"
  | "legacy_capsule_scope_denied"
  | "legacy_capsule_partial_accept";

export class LegacyCapsuleError extends Error {
  readonly code: LegacyCapsuleErrorCode;
  readonly completedMemoryIds: readonly string[];

  constructor(
    code: LegacyCapsuleErrorCode,
    message: string,
    options: { cause?: Error; completedMemoryIds?: readonly string[] } = {},
  ) {
    super(message, options);
    this.name = "LegacyCapsuleError";
    this.code = code;
    this.completedMemoryIds = options.completedMemoryIds ?? [];
  }
}

/** Build the canonical directory file map from explicitly selected records. */
export function buildLegacyCapsule(inputValue: unknown): BuiltLegacyCapsule {
  let input: ReturnType<typeof LegacyCapsuleExportRequestSchema.parse>;
  try {
    input = LegacyCapsuleExportRequestSchema.parse(inputValue);
  } catch (error) {
    throw capsuleInvalid("Legacy Capsule export request is invalid", error);
  }

  const sourceMetadata = {
    capsuleId: input.capsuleId,
    createdAt: input.createdAt,
    sourceInstanceId: input.sourceInstanceId,
    principals: input.principals,
    consent: input.consent,
    ...(input.license === undefined ? {} : { license: input.license }),
  };
  const safeMetadata = LegacyCapsuleExportMetadataSchema.parse(redactStructuredArtifactValue(sourceMetadata));
  assertNoSecrets(safeMetadata, "Capsule metadata still contains secret material after redaction");

  const memoryById = uniqueBy(input.memories.map((record) => MemoryRecordV2Schema.parse(record)), ({ memoryId }) => memoryId);
  const experienceById = uniqueBy(input.experiences.map((item) => ExperienceCaseSchema.parse(item)), ({ caseId }) => caseId);
  const memoryEntries: LegacyCapsuleMemoryEntry[] = [];
  const experienceEntries: LegacyCapsuleExperienceEntry[] = [];
  const metadataChanges = countChangedValues(sourceMetadata, safeMetadata);
  let redactedEntryDigests: string[] = metadataChanges > 0
    ? [sha256(`${safeMetadata.capsuleId}:metadata`)]
    : [];
  let redactedValueCount = metadataChanges;

  for (const sourceMemoryId of input.selectedMemoryIds) {
    const record = memoryById.get(sourceMemoryId);
    if (record === undefined) throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "Selected Memory was not present in the export source set");
    if (record.status !== "active"
      || !record.governance.allowExport
      || record.governance.consent !== "explicit"
      || record.governance.sensitivity === "secret"
      || record.governance.sensitivity === "unknown"
      || record.assessment.sourceTrust === "untrusted"
      || record.assessment.sourceTrust === "unknown"
      || record.kind === "legacy_unclassified") {
      throw new LegacyCapsuleError("legacy_capsule_item_not_exportable", "Selected Memory is not active, locally exportable, and explicitly consented");
    }
    const sourceValue = {
      schemaVersion: "tracegraph.legacy-capsule-memory.v1" as const,
      sourceMemoryId: record.memoryId,
      sourceVersion: record.version,
      kind: record.kind,
      claim: record.claim,
      ...(record.normalizedKey === undefined ? {} : { normalizedKey: record.normalizedKey }),
      sourceStatus: record.status,
      evidenceRefs: record.provenance.evidenceRefs,
      sourceTrust: record.assessment.sourceTrust,
      verification: record.assessment.verification,
      validFrom: record.validity.validFrom,
      ...(record.validity.validUntil === undefined ? {} : { validUntil: record.validity.validUntil }),
      sensitivity: record.governance.sensitivity,
      createdAt: record.createdAt,
    };
    const redacted = redactStructuredArtifactValue(sourceValue) as typeof sourceValue;
    const changes = countChangedValues(sourceValue, redacted);
    const safeMemory = LegacyCapsuleMemoryEntrySchema.parse({
      ...redacted,
      contentDigest: sha256(redacted.claim),
    });
    assertNoSecrets(safeMemory, "Selected Memory still contains secret material after redaction");
    memoryEntries.push(safeMemory);
    if (changes > 0) {
      redactedValueCount += changes;
      redactedEntryDigests.push(sha256(`${safeMetadata.capsuleId}:memory:${safeMemory.sourceMemoryId}`));
    }
  }

  for (const sourceCaseId of input.selectedExperienceCaseIds) {
    const experienceCase = experienceById.get(sourceCaseId);
    if (experienceCase === undefined) throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "Selected Experience Case was not present in the export source set");
    if (experienceCase.status !== "validated") {
      throw new LegacyCapsuleError("legacy_capsule_item_not_exportable", "Only a validated Experience Case can be exported");
    }
    const sourceValue = {
      schemaVersion: "tracegraph.legacy-capsule-experience.v1" as const,
      sourceCaseId,
      experienceCase,
    };
    const redacted = redactStructuredArtifactValue(sourceValue) as typeof sourceValue;
    const changes = countChangedValues(sourceValue, redacted);
    const safeExperience = LegacyCapsuleExperienceEntrySchema.parse(redacted);
    assertNoSecrets(safeExperience, "Selected Experience Case still contains secret material after redaction");
    experienceEntries.push(safeExperience);
    if (changes > 0) {
      redactedValueCount += changes;
      redactedEntryDigests.push(sha256(`${safeMetadata.capsuleId}:experience:${safeExperience.sourceCaseId}`));
    }
  }

  if (uniqueBy(memoryEntries, ({ sourceMemoryId }) => sourceMemoryId).size !== memoryEntries.length
    || uniqueBy(experienceEntries, ({ sourceCaseId }) => sourceCaseId).size !== experienceEntries.length) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Redaction produced duplicate source identities");
  }

  if (memoryEntries.length === 0 && experienceEntries.length === 0) {
    throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "Capsule export requires at least one selected item");
  }

  const scopeKinds = new Set<"user" | "workspace" | "project">();
  for (const memoryId of input.selectedMemoryIds) {
    const record = memoryById.get(memoryId)!;
    if (record.scope.workspaceId !== undefined) scopeKinds.add("workspace");
    if (record.scope.projectId !== undefined) scopeKinds.add("project");
    if (record.scope.workspaceId === undefined && record.scope.projectId === undefined) scopeKinds.add("user");
  }
  if (experienceEntries.length > 0) scopeKinds.add("project");

  const memoryText = serializeJsonLines(memoryEntries);
  const experienceText = serializeJsonLines(experienceEntries);
  const usageConsent = capsuleUsageConsentFileSchema.parse({
    schema_version: "tracegraph.legacy-capsule.v1",
    consent: safeMetadata.consent,
    ...(safeMetadata.license === undefined ? {} : { license: safeMetadata.license }),
  });
  const payloads = {
    "memories.jsonl": memoryText,
    "experiences.jsonl": experienceText,
    "policies/usage-consent.yaml": stringify(usageConsent, { lineWidth: 0, sortMapEntries: true }),
    "README.md": LEGACY_CAPSULE_README,
  };
  const manifest = LegacyCapsuleManifestSchema.parse({
    schema_version: "tracegraph.legacy-capsule.v1",
    capsule_id: safeMetadata.capsuleId,
    created_at: safeMetadata.createdAt,
    source_instance_id: safeMetadata.sourceInstanceId,
    principals: {
      content_creator: safeMetadata.principals.contentCreator,
      export_operator: safeMetadata.principals.exportOperator,
      described_subject: safeMetadata.principals.describedSubject,
      authorized_by: safeMetadata.principals.authorizedBy,
    },
    included: {
      scope_kinds: [...scopeKinds].sort(),
      memory_count: memoryEntries.length,
      experience_count: experienceEntries.length,
    },
    redaction: {
      redacted_entry_count: redactedEntryDigests.length,
      redacted_value_count: redactedValueCount,
      entry_digests: redactedEntryDigests.sort(),
    },
    required_migrations: [],
    consent: safeMetadata.consent,
    ...(safeMetadata.license === undefined ? {} : { license: safeMetadata.license }),
    payload_digests: Object.fromEntries(capsulePayloadPaths.map((path) => [path, sha256(payloads[path])])),
    checksum_algorithm: "sha256",
  });
  const contentFiles = {
    "manifest.yaml": stringify(manifest, { lineWidth: 0, sortMapEntries: true }),
    ...payloads,
  };
  const files = {
    ...contentFiles,
    "SHA256SUMS": serializeSha256Sums(contentFiles),
  };
  validateFileSet(files);
  return {
    files,
    capsuleId: manifest.capsule_id,
    capsuleDigest: digestBundle(files),
    manifest,
  };
}

/** Offline integrity/schema verification. A valid checksum is not a trust decision. */
export function verifyLegacyCapsule(filesValue: unknown): VerifiedLegacyCapsule {
  const files = validateFileSet(filesValue);
  verifySha256Sums(files);
  const rawManifest = parseYaml(files["manifest.yaml"]!, "Capsule manifest is invalid");
  if (typeof rawManifest !== "object" || rawManifest === null || Array.isArray(rawManifest)) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule manifest must be a mapping");
  }
  const manifestHeader = rawManifest as Record<string, unknown>;
  if (manifestHeader.checksum_algorithm !== "sha256" || manifestHeader.schema_version !== "tracegraph.legacy-capsule.v1") {
    throw new LegacyCapsuleError("legacy_capsule_unsupported", "Capsule version or checksum algorithm is unsupported");
  }
  let manifest: LegacyCapsuleManifest;
  try {
    manifest = LegacyCapsuleManifestSchema.parse(rawManifest);
  } catch (error) {
    throw capsuleInvalid("Capsule manifest is invalid", error);
  }
  for (const path of capsulePayloadPaths) {
    if (manifest.payload_digests[path] !== sha256(files[path]!)) {
      throw new LegacyCapsuleError("legacy_capsule_checksum_mismatch", `Capsule payload digest does not match ${path}`);
    }
  }
  const consentFile = parseYamlSchema(capsuleUsageConsentFileSchema, files["policies/usage-consent.yaml"]!, "Capsule consent file is invalid");
  if (stableStringify(consentFile.consent) !== stableStringify(manifest.consent)
    || consentFile.license !== manifest.license) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule consent file does not match the manifest");
  }

  const memories = parseJsonLines(files["memories.jsonl"]!, LegacyCapsuleMemoryEntrySchema, "Memory entry");
  const experiences = parseJsonLines(files["experiences.jsonl"]!, LegacyCapsuleExperienceEntrySchema, "Experience entry");
  if (memories.length !== manifest.included.memory_count || experiences.length !== manifest.included.experience_count) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule entry counts do not match its manifest");
  }
  if (memories.length > LEGACY_CAPSULE_MAX_ENTRIES || experiences.length > LEGACY_CAPSULE_MAX_ENTRIES) {
    throw new LegacyCapsuleError("legacy_capsule_size_exceeded", "Capsule contains too many entries");
  }
  if (uniqueBy(memories, ({ sourceMemoryId }) => sourceMemoryId).size !== memories.length
    || uniqueBy(experiences, ({ sourceCaseId }) => sourceCaseId).size !== experiences.length) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule contains duplicate source identities");
  }
  for (const memory of memories) {
    if (memory.contentDigest !== sha256(memory.claim)) {
      throw new LegacyCapsuleError("legacy_capsule_checksum_mismatch", "Capsule Memory content digest does not match its claim");
    }
  }

  return {
    files,
    capsuleId: manifest.capsule_id,
    capsuleDigest: digestBundle(files),
    manifest,
    memories,
    experiences,
  };
}

/** Build a no-side-effect, redacted import review. */
export function previewLegacyCapsuleImport(
  filesValue: unknown,
  existingRecords: readonly MemoryRecordV2[],
  targetProjectId?: string,
): LegacyCapsuleQuarantine {
  const verified = verifyLegacyCapsule(filesValue);
  return previewVerifiedCapsule(verified, existingRecords.map((record) => MemoryRecordV2Schema.parse(record)), targetProjectId);
}

/** Reverify the displayed bundle/diff, then explicitly create only selected local candidates. */
export async function acceptLegacyCapsuleImport(
  quarantineValue: unknown,
  filesValue: unknown,
  requestValue: unknown,
  control: LegacyCapsuleMemoryControlPort,
  scope: MemoryControlScope,
): Promise<LegacyCapsuleAcceptResult> {
  const quarantine = LegacyCapsuleQuarantineSchema.parse(quarantineValue);
  const request = LegacyCapsuleAcceptRequestSchema.parse(requestValue);
  if (request.capsuleId !== quarantine.capsuleId || request.capsuleDigest !== quarantine.capsuleDigest
    || request.reviewDigest !== quarantine.reviewDigest) {
    throw new LegacyCapsuleError("legacy_capsule_review_stale", "Capsule import confirmation does not match the reviewed bundle");
  }
  if (quarantine.targetProjectId !== undefined && !scope.allowedScopeIds.includes(quarantine.targetProjectId)) {
    throw new LegacyCapsuleError("legacy_capsule_scope_denied", "Target project is outside the caller's visible scope");
  }

  const verified = verifyLegacyCapsule(filesValue);
  if (verified.capsuleDigest !== quarantine.capsuleDigest || verified.capsuleId !== quarantine.capsuleId) {
    throw new LegacyCapsuleError("legacy_capsule_review_stale", "Capsule bytes changed after the review diff was prepared");
  }
  const current = await control.list(scope);
  const currentRecords = current.items.map(({ record }) => record);
  const currentQuarantine = previewVerifiedCapsule(verified, currentRecords, quarantine.targetProjectId);
  if (currentQuarantine.reviewDigest !== quarantine.reviewDigest) {
    throw new LegacyCapsuleError("legacy_capsule_review_stale", "Local Memory state changed after the review diff was prepared");
  }

  const selectedIds = new Set(request.selectedEntryIds);
  const entryById = new Map(currentQuarantine.entries.map((entry) => [entry.entryId, entry]));
  if ([...selectedIds].some((id) => !entryById.has(id))) {
    throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "Selected Capsule entry is not present in the reviewed diff");
  }
  const selectedEntries = [...selectedIds].map((id) => entryById.get(id)!);
  const memoryById = new Map(verified.memories.map((entry) => [capsuleMemoryReviewId(verified.capsuleId, entry.sourceMemoryId), entry]));
  const experienceById = new Map(verified.experiences.map((entry) => [capsuleExperienceReviewId(verified.capsuleId, entry.sourceCaseId), entry]));

  const importedMemories: MemoryControlItem[] = [];
  const alreadyImportedMemoryIds: string[] = [];
  const importedExperiences: LegacyCapsuleAcceptedExperience[] = [];
  for (const entry of selectedEntries) {
    if (entry.classification === "experience_candidate") {
      const source = experienceById.get(entry.entryId);
      if (source === undefined) throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "Selected Experience Case could not be resolved");
      importedExperiences.push(materializeImportedExperience(verified.capsuleId, source));
      continue;
    }
    const source = memoryById.get(entry.entryId);
    if (source === undefined) throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "Selected Memory could not be resolved");
    if (entry.classification === "duplicate") {
      const sanitizedSource = redactCapsuleMemoryEntry(source).entry;
      const existing = current.items.find(({ record }) => entry.matchingMemoryIds.includes(record.memoryId)
        && isImportedFromCapsule(record, verified.capsuleId, source.sourceMemoryId, sanitizedSource.contentDigest));
      if (existing === undefined) {
        throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "An already-present local duplicate cannot be accepted as a Capsule import");
      }
      importedMemories.push(existing);
      alreadyImportedMemoryIds.push(existing.record.memoryId);
      continue;
    }
    if (entry.classification !== "new" && entry.classification !== "conflict") {
      throw new LegacyCapsuleError("legacy_capsule_selection_invalid", "Capsule entry is not eligible for import acceptance");
    }
  }

  const selectedMemoryEntries = selectedEntries
    .filter((entry) => entry.classification === "new" || entry.classification === "conflict")
    .map((entry) => memoryById.get(entry.entryId)!)
    .filter(Boolean);
  const completedMemoryIds: string[] = [];
  try {
    for (const entry of selectedMemoryEntries) {
      const requestId = `capsule-entry:${sha256(`${request.importId}:${entry.sourceMemoryId}`).slice("sha256:".length, 40)}`;
      const item = await control.createImportedCandidate({
        command_id: requestId,
        source_capsule_id: verified.capsuleId,
        source_capsule_digest: verified.capsuleDigest,
        source_memory_id: entry.sourceMemoryId,
        kind: entry.kind === "declared_identity" ? "legacy_unclassified" : entry.kind,
        claim: entry.claim,
        ...(entry.normalizedKey === undefined ? {} : { normalized_key: entry.normalizedKey }),
        ...(quarantine.targetProjectId === undefined ? {} : { project_id: quarantine.targetProjectId }),
        source_valid_from: entry.validFrom,
        ...(entry.validUntil === undefined ? {} : { source_valid_until: entry.validUntil }),
        sensitivity: entry.sensitivity,
      }, scope);
      importedMemories.push(item);
      completedMemoryIds.push(item.record.memoryId);
    }
  } catch (error) {
    throw new LegacyCapsuleError(
      "legacy_capsule_partial_accept",
      "Some selected Memory candidates were committed; retry the same confirmation and import id to resume idempotently",
      { cause: asError(error), completedMemoryIds },
    );
  }

  return {
    capsuleId: verified.capsuleId,
    capsuleDigest: verified.capsuleDigest,
    importedMemories,
    importedExperiences,
    alreadyImportedMemoryIds,
  };
}

function previewVerifiedCapsule(
  verified: VerifiedLegacyCapsule,
  existingRecords: readonly MemoryRecordV2[],
  targetProjectId?: string,
): LegacyCapsuleQuarantine {
  const redactedManifestValue = redactStructuredArtifactValue(verified.manifest);
  const manifest = LegacyCapsuleManifestSchema.parse(redactedManifestValue);
  let importRedactedValueCount = countChangedValues(verified.manifest, manifest);
  const entries = [];

  const localScopeRecords = existingRecords.filter((record) => record.scope.projectId === targetProjectId
    && record.scope.workspaceId === undefined);
  for (const sourceValue of verified.memories) {
    const safeSource = redactCapsuleMemoryEntry(sourceValue);
    importRedactedValueCount += safeSource.redactedValues;
    const source = safeSource.entry;
    const sameKey = source.normalizedKey === undefined
      ? []
      : localScopeRecords.filter((record) => record.normalizedKey === source.normalizedKey);
    const exact = localScopeRecords.filter((record) => record.claim === source.claim);
    const matches = [...new Set([...sameKey, ...exact].map(({ memoryId }) => memoryId))].sort();
    const classification = sameKey.some((record) => record.claim !== source.claim)
      ? "conflict" as const
      : exact.length > 0
        ? "duplicate" as const
        : "new" as const;
    entries.push({
      entryId: capsuleMemoryReviewId(verified.capsuleId, source.sourceMemoryId),
      sourceId: source.sourceMemoryId,
      kind: source.kind,
      claim: source.claim,
      classification,
      matchingMemoryIds: matches,
    });
  }
  for (const sourceValue of verified.experiences) {
    const source = redactCapsuleExperienceEntry(sourceValue);
    importRedactedValueCount += source.redactedValues;
    entries.push({
      entryId: capsuleExperienceReviewId(verified.capsuleId, source.entry.sourceCaseId),
      sourceId: source.entry.sourceCaseId,
      title: source.entry.experienceCase.title,
      classification: "experience_candidate" as const,
      matchingMemoryIds: [],
    });
  }

  const reviewDigest = digestReview(verified, entries, existingRecords, targetProjectId);
  return LegacyCapsuleQuarantineSchema.parse({
    capsuleId: verified.capsuleId,
    capsuleDigest: verified.capsuleDigest,
    reviewDigest,
    ...(targetProjectId === undefined ? {} : { targetProjectId }),
    manifest,
    entries,
    importRedactedValueCount,
  });
}

function digestReview(
  verified: VerifiedLegacyCapsule,
  entries: readonly {
    entryId: string;
    sourceId: string;
    kind?: string;
    title?: string;
    claim?: string;
    classification: string;
    matchingMemoryIds: readonly string[];
  }[],
  currentRecords: readonly MemoryRecordV2[],
  targetProjectId?: string,
): string {
  const currentById = new Map(currentRecords.map((record) => [record.memoryId, record]));
  const normalizedEntries = entries.map((entry) => {
    const sourceMemoryId = verified.memories.find((item) => capsuleMemoryReviewId(verified.capsuleId, item.sourceMemoryId) === entry.entryId)?.sourceMemoryId;
    if (sourceMemoryId === undefined) return entry;
    const source = redactCapsuleMemoryEntry(verified.memories.find((item) => item.sourceMemoryId === sourceMemoryId)!).entry;
    const nonImportedMatches = entry.matchingMemoryIds.filter((memoryId) => {
      const record = currentById.get(memoryId);
      return record === undefined || !isImportedFromCapsule(record, verified.capsuleId, sourceMemoryId, source.contentDigest);
    });
    if (entry.matchingMemoryIds.length > 0 && nonImportedMatches.length === 0) {
      return { ...entry, classification: "new", matchingMemoryIds: [] };
    }
    return { ...entry, matchingMemoryIds: nonImportedMatches };
  });
  return sha256(stableStringify({
    capsuleDigest: verified.capsuleDigest,
    targetProjectId: targetProjectId ?? null,
    entries: normalizedEntries,
  }));
}

function redactCapsuleMemoryEntry(source: LegacyCapsuleMemoryEntry): { entry: LegacyCapsuleMemoryEntry; redactedValues: number } {
  const redacted = redactStructuredArtifactValue(source) as LegacyCapsuleMemoryEntry;
  const redactedValues = countChangedValues(source, redacted);
  const entry = LegacyCapsuleMemoryEntrySchema.parse({ ...redacted, contentDigest: sha256(redacted.claim) });
  assertNoSecrets(entry, "Capsule Memory still contains secret material after import redaction");
  return { entry, redactedValues };
}

function redactCapsuleExperienceEntry(source: LegacyCapsuleExperienceEntry): { entry: LegacyCapsuleExperienceEntry; redactedValues: number } {
  const redacted = redactStructuredArtifactValue(source) as LegacyCapsuleExperienceEntry;
  const redactedValues = countChangedValues(source, redacted);
  const entry = LegacyCapsuleExperienceEntrySchema.parse(redacted);
  assertNoSecrets(entry, "Capsule Experience Case still contains secret material after import redaction");
  return { entry, redactedValues };
}

function materializeImportedExperience(
  capsuleId: string,
  source: LegacyCapsuleExperienceEntry,
): LegacyCapsuleAcceptedExperience {
  const safeSource = redactCapsuleExperienceEntry(source).entry;
  const experienceCase = ExperienceCaseSchema.parse({
    ...safeSource.experienceCase,
    caseId: `experience:${sha256(`${capsuleId}:${source.sourceCaseId}`).slice("sha256:".length, 40)}`,
    version: 1,
    extractorId: "legacy-capsule-import:v1",
    status: "candidate",
  });
  return LegacyCapsuleAcceptedExperienceSchema.parse({
    sourceCapsuleId: capsuleId,
    sourceCaseId: source.sourceCaseId,
    externalEvidence: true,
    experienceCase,
  });
}

function capsuleMemoryReviewId(capsuleId: string, sourceMemoryId: string): string {
  return `capsule-entry:${sha256(`memory:${capsuleId}:${sourceMemoryId}`).slice("sha256:".length, 40)}`;
}

function capsuleExperienceReviewId(capsuleId: string, sourceCaseId: string): string {
  return `capsule-entry:${sha256(`experience:${capsuleId}:${sourceCaseId}`).slice("sha256:".length, 40)}`;
}

function isImportedFromCapsule(record: MemoryRecordV2, capsuleId: string, sourceMemoryId: string, sourceContentDigest: string): boolean {
  const reference = record.provenance.evidenceRefs.find((ref) => "source_id" in ref);
  return record.provenance.origin === "external"
    && reference !== undefined
    && "source_id" in reference
    && reference.source_id === `capsule:${capsuleId}:memory:${sourceMemoryId}`
    && record.contentDigest === sourceContentDigest;
}

function parseYamlSchema<T>(
  schema: z.ZodType<T>,
  text: string,
  message: string,
): T {
  try {
    return schema.parse(parseYaml(text, message));
  } catch (error) {
    if (error instanceof LegacyCapsuleError) throw error;
    throw capsuleInvalid(message, error);
  }
}

function parseYaml(text: string, message: string): unknown {
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0) throw document.errors[0];
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw capsuleInvalid(message, error);
  }
}

function parseJsonLines<T>(text: string, schema: z.ZodType<T>, label: string): T[] {
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new LegacyCapsuleError("legacy_capsule_invalid", `${label} JSONL must end with a newline`);
  return text.slice(0, -1).split("\n").map((line, index) => {
    if (line.length === 0) throw new LegacyCapsuleError("legacy_capsule_invalid", `${label} JSONL row ${index + 1} is empty`);
    try {
      const value = schema.parse(JSON.parse(line) as unknown);
      if (stableStringify(value) !== line) {
        throw new LegacyCapsuleError("legacy_capsule_invalid", `${label} JSONL row ${index + 1} is not canonical JSON`);
      }
      return value;
    } catch (error) {
      if (error instanceof LegacyCapsuleError) throw error;
      throw capsuleInvalid(`${label} JSONL row ${index + 1} is invalid`, error);
    }
  });
}

function validateFileSet(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule files must be a plain relative-path map");
  }
  const entries = Object.entries(value);
  if (entries.length !== LEGACY_CAPSULE_MAX_FILES) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule contains missing or unsupported files");
  }
  const files: Record<string, string> = {};
  let totalBytes = 0;
  for (const [path, content] of entries) {
    try {
      LegacyCapsuleRelativePathSchema.parse(path);
    } catch (error) {
      throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule contains an unsafe relative path", { cause: asError(error) });
    }
    if (!capsuleFilePathSet.has(path) || Object.hasOwn(files, path)) {
      throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule contains an unknown or duplicate file path");
    }
    if (typeof content !== "string") throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule file contents must be UTF-8 text");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > LEGACY_CAPSULE_MAX_FILE_BYTES) throw new LegacyCapsuleError("legacy_capsule_size_exceeded", "Capsule file exceeds the per-file byte limit");
    totalBytes += bytes;
    if (totalBytes > LEGACY_CAPSULE_MAX_TOTAL_BYTES) throw new LegacyCapsuleError("legacy_capsule_size_exceeded", "Capsule exceeds the total byte limit");
    files[path] = content;
  }
  if (capsuleFilePaths.some((path) => !Object.hasOwn(files, path))) {
    throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule is missing a required file");
  }
  return files;
}

function verifySha256Sums(files: Record<string, string>): void {
  const checksums = files["SHA256SUMS"]!;
  if (!checksums.endsWith("\n")) throw new LegacyCapsuleError("legacy_capsule_invalid", "SHA256SUMS must end with a newline");
  const rows = checksums.slice(0, -1).split("\n");
  const parsed = new Map<string, string>();
  let previousPath = "";
  for (const row of rows) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(row);
    if (match === null) throw new LegacyCapsuleError("legacy_capsule_invalid", "SHA256SUMS has an invalid row");
    const [, digest, path] = match;
    try { LegacyCapsuleRelativePathSchema.parse(path); } catch (error) {
      throw new LegacyCapsuleError("legacy_capsule_invalid", "SHA256SUMS contains an unsafe path", { cause: asError(error) });
    }
    if (!capsuleFilePathSet.has(path!) || path === "SHA256SUMS" || parsed.has(path!) || path! <= previousPath) {
      throw new LegacyCapsuleError("legacy_capsule_invalid", "SHA256SUMS paths must be allowed, unique, and sorted");
    }
    parsed.set(path!, `sha256:${digest}`);
    previousPath = path!;
  }
  const expectedPaths = capsuleFilePaths.filter((path) => path !== "SHA256SUMS").sort();
  if (parsed.size !== expectedPaths.length || expectedPaths.some((path) => parsed.get(path) !== sha256(files[path]!))) {
    throw new LegacyCapsuleError("legacy_capsule_checksum_mismatch", "Capsule SHA-256 checksums do not match its file contents");
  }
}

function serializeSha256Sums(files: Record<string, string>): string {
  return Object.keys(files).sort().map((path) => `${sha256(files[path]!).slice("sha256:".length)}  ${path}`).join("\n") + "\n";
}

function serializeJsonLines(values: readonly unknown[]): string {
  return values.length === 0 ? "" : `${values.map((value) => stableStringify(value)).join("\n")}\n`;
}

function digestBundle(files: LegacyCapsuleFiles): string {
  return sha256(stableStringify(Object.keys(files).sort().map((path) => [path, sha256(files[path]!) ])));
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const output = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (output.has(id)) throw new LegacyCapsuleError("legacy_capsule_invalid", "Capsule source contains duplicate identities");
    output.set(id, item);
  }
  return output;
}

function countChangedValues(before: unknown, after: unknown): number {
  if (Object.is(before, after)) return 0;
  if (typeof before === "string" && typeof after === "string") return 1;
  if (Array.isArray(before) && Array.isArray(after)) {
    return Math.max(before.length, after.length) === 0
      ? 0
      : Array.from({ length: Math.max(before.length, after.length) }, (_, index) => countChangedValues(before[index], after[index])).reduce((sum, count) => sum + count, 0);
  }
  if (typeof before === "object" && before !== null && typeof after === "object" && after !== null) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
    return [...keys].reduce((sum, key) => sum + countChangedValues(beforeRecord[key], afterRecord[key]), 0);
  }
  return 1;
}

function assertNoSecrets(value: unknown, message: string): void {
  if (containsSensitiveStructuredData(value)) throw new LegacyCapsuleError("legacy_capsule_invalid", message);
}

function capsuleInvalid(message: string, cause?: unknown): LegacyCapsuleError {
  return new LegacyCapsuleError("legacy_capsule_invalid", message, { ...(cause === undefined ? {} : { cause: asError(cause) }) });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown Capsule error");
}
