import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.js";
import {
  MemoryKindV2Schema,
  MemoryProvenanceEvidenceRefSchema,
  MemoryRecordV2Schema,
  MemoryStatusV2Schema,
} from "./memory.js";
import { ExperienceCaseSchema } from "./experience-case.js";

export const LEGACY_CAPSULE_SCHEMA_VERSION = "tracegraph.legacy-capsule.v1" as const;
export const LegacyCapsuleRelativePathSchema = z.string().min(1).max(180).refine((path) =>
  !path.startsWith("/")
  && !path.startsWith("\\")
  && !/^[A-Za-z]:/u.test(path)
  && !path.includes("\\")
  && !path.split("/").some((part) => part === "" || part === "." || part === ".."),
"Capsule paths must be canonical relative paths");

export const LegacyCapsulePrincipalSchema = z.object({
  id: IdentifierSchema,
}).strict();

export const LegacyCapsuleConsentSchema = z.object({
  consentedBy: IdentifierSchema,
  consentedAt: IsoDateTimeSchema,
  purpose: NonEmptyStringSchema.max(500),
  externalCopyWarningAcknowledged: z.literal(true),
}).strict();
export type LegacyCapsuleConsent = z.infer<typeof LegacyCapsuleConsentSchema>;

export const LegacyCapsuleMemoryEntrySchema = z.object({
  schemaVersion: z.literal("tracegraph.legacy-capsule-memory.v1"),
  sourceMemoryId: IdentifierSchema,
  sourceVersion: z.number().int().positive(),
  kind: MemoryKindV2Schema,
  claim: NonEmptyStringSchema.max(8_000),
  contentDigest: Sha256Schema,
  normalizedKey: NonEmptyStringSchema.max(500).optional(),
  sourceStatus: MemoryStatusV2Schema,
  evidenceRefs: z.array(MemoryProvenanceEvidenceRefSchema).max(32),
  sourceTrust: z.enum(["authoritative", "trusted", "untrusted", "unknown"]),
  verification: z.enum(["verified", "corroborated", "asserted", "inferred", "unclassified"]),
  validFrom: IsoDateTimeSchema,
  validUntil: IsoDateTimeSchema.optional(),
  sensitivity: z.enum(["public", "internal", "personal"]),
  createdAt: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (value.kind === "legacy_unclassified" && value.sourceStatus !== "candidate" && value.sourceStatus !== "revoked") {
    context.addIssue({ code: "custom", path: ["sourceStatus"], message: "unclassified source Memory cannot be exported as usable" });
  }
});
export type LegacyCapsuleMemoryEntry = z.infer<typeof LegacyCapsuleMemoryEntrySchema>;

export const LegacyCapsuleExperienceEntrySchema = z.object({
  schemaVersion: z.literal("tracegraph.legacy-capsule-experience.v1"),
  sourceCaseId: IdentifierSchema,
  experienceCase: ExperienceCaseSchema,
}).strict().superRefine((value, context) => {
  if (value.sourceCaseId !== value.experienceCase.caseId) {
    context.addIssue({ code: "custom", path: ["sourceCaseId"], message: "source Case identity must match the included Case" });
  }
});
export type LegacyCapsuleExperienceEntry = z.infer<typeof LegacyCapsuleExperienceEntrySchema>;

export const LegacyCapsuleExportMetadataSchema = z.object({
  capsuleId: IdentifierSchema,
  createdAt: IsoDateTimeSchema,
  sourceInstanceId: IdentifierSchema,
  principals: z.object({
    contentCreator: LegacyCapsulePrincipalSchema,
    exportOperator: LegacyCapsulePrincipalSchema,
    describedSubject: LegacyCapsulePrincipalSchema,
    authorizedBy: LegacyCapsulePrincipalSchema,
  }).strict(),
  consent: LegacyCapsuleConsentSchema,
  license: NonEmptyStringSchema.max(300).optional(),
}).strict();
export type LegacyCapsuleExportMetadata = z.infer<typeof LegacyCapsuleExportMetadataSchema>;

export const LegacyCapsuleExportRequestSchema = z.object({
  ...LegacyCapsuleExportMetadataSchema.shape,
  memories: z.array(MemoryRecordV2Schema).max(2_000),
  selectedMemoryIds: z.array(IdentifierSchema).max(500),
  experiences: z.array(ExperienceCaseSchema).max(2_000),
  selectedExperienceCaseIds: z.array(IdentifierSchema).max(500),
}).strict().superRefine((value, context) => {
  if (new Set(value.selectedMemoryIds).size !== value.selectedMemoryIds.length) {
    context.addIssue({ code: "custom", path: ["selectedMemoryIds"], message: "selected Memory ids must be unique" });
  }
  if (new Set(value.selectedExperienceCaseIds).size !== value.selectedExperienceCaseIds.length) {
    context.addIssue({ code: "custom", path: ["selectedExperienceCaseIds"], message: "selected Experience Case ids must be unique" });
  }
  if (value.selectedMemoryIds.length === 0 && value.selectedExperienceCaseIds.length === 0) {
    context.addIssue({ code: "custom", message: "select at least one Memory or Experience Case" });
  }
  if (value.principals.authorizedBy.id !== value.consent.consentedBy) {
    context.addIssue({ code: "custom", path: ["consent", "consentedBy"], message: "consent actor must match the authorization principal" });
  }
});
export type LegacyCapsuleExportRequest = z.infer<typeof LegacyCapsuleExportRequestSchema>;

export const LegacyCapsuleManifestSchema = z.object({
  schema_version: z.literal(LEGACY_CAPSULE_SCHEMA_VERSION),
  capsule_id: IdentifierSchema,
  created_at: IsoDateTimeSchema,
  source_instance_id: IdentifierSchema,
  principals: z.object({
    content_creator: LegacyCapsulePrincipalSchema,
    export_operator: LegacyCapsulePrincipalSchema,
    described_subject: LegacyCapsulePrincipalSchema,
    authorized_by: LegacyCapsulePrincipalSchema,
  }).strict(),
  included: z.object({
    scope_kinds: z.array(z.enum(["user", "workspace", "project"])).min(1).max(3),
    memory_count: z.number().int().nonnegative().max(500),
    experience_count: z.number().int().nonnegative().max(500),
  }).strict(),
  redaction: z.object({
    redacted_entry_count: z.number().int().nonnegative().max(1_001),
    redacted_value_count: z.number().int().nonnegative().max(10_000_000),
    entry_digests: z.array(Sha256Schema).max(1_001),
  }).strict(),
  required_migrations: z.array(NonEmptyStringSchema.max(120)).max(32),
  license: NonEmptyStringSchema.max(300).optional(),
  consent: LegacyCapsuleConsentSchema,
  payload_digests: z.object({
    "memories.jsonl": Sha256Schema,
    "experiences.jsonl": Sha256Schema,
    "policies/usage-consent.yaml": Sha256Schema,
    "README.md": Sha256Schema,
  }).strict(),
  checksum_algorithm: z.literal("sha256"),
}).strict().superRefine((value, context) => {
  if (value.principals.authorized_by.id !== value.consent.consentedBy) {
    context.addIssue({ code: "custom", path: ["consent", "consentedBy"], message: "consent actor must match the authorization principal" });
  }
});
export type LegacyCapsuleManifest = z.infer<typeof LegacyCapsuleManifestSchema>;

export const LegacyCapsuleReviewEntrySchema = z.object({
  entryId: IdentifierSchema,
  sourceId: IdentifierSchema,
  kind: MemoryKindV2Schema.optional(),
  title: NonEmptyStringSchema.max(300).optional(),
  claim: NonEmptyStringSchema.max(8_000).optional(),
  classification: z.enum(["new", "duplicate", "conflict", "experience_candidate"]),
  matchingMemoryIds: z.array(IdentifierSchema).max(100),
}).strict();
export type LegacyCapsuleReviewEntry = z.infer<typeof LegacyCapsuleReviewEntrySchema>;

export const LegacyCapsuleQuarantineSchema = z.object({
  capsuleId: IdentifierSchema,
  capsuleDigest: Sha256Schema,
  reviewDigest: Sha256Schema,
  targetProjectId: IdentifierSchema.optional(),
  manifest: LegacyCapsuleManifestSchema,
  entries: z.array(LegacyCapsuleReviewEntrySchema).max(1_000),
  importRedactedValueCount: z.number().int().nonnegative().max(10_000),
}).strict();
export type LegacyCapsuleQuarantine = z.infer<typeof LegacyCapsuleQuarantineSchema>;

export const LegacyCapsuleAcceptRequestSchema = z.object({
  capsuleId: IdentifierSchema,
  capsuleDigest: Sha256Schema,
  reviewDigest: Sha256Schema,
  importId: IdentifierSchema,
  selectedEntryIds: z.array(IdentifierSchema).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.selectedEntryIds).size !== value.selectedEntryIds.length) {
    context.addIssue({ code: "custom", path: ["selectedEntryIds"], message: "selected Capsule entry ids must be unique" });
  }
});
export type LegacyCapsuleAcceptRequest = z.infer<typeof LegacyCapsuleAcceptRequestSchema>;

export const LegacyCapsuleAcceptedExperienceSchema = z.object({
  sourceCapsuleId: IdentifierSchema,
  sourceCaseId: IdentifierSchema,
  externalEvidence: z.literal(true),
  experienceCase: ExperienceCaseSchema,
}).strict();
export type LegacyCapsuleAcceptedExperience = z.infer<typeof LegacyCapsuleAcceptedExperienceSchema>;
