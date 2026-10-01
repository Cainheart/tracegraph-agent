import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from "./common.js";
import { MemoryRunEvidenceRefSchema } from "./memory.js";
import { MemoryEpisodeOutcomeSchema } from "./memory-episode.js";

const EvidenceSequencesSchema = z.array(z.number().int().positive()).min(1).max(32).superRefine((sequences, context) => {
  const seen = new Set<number>();
  sequences.forEach((sequence, index) => {
    if (seen.has(sequence)) {
      context.addIssue({ code: "custom", path: [index], message: "evidence sequences must be unique" });
    }
    seen.add(sequence);
  });
});
const ExperienceEvidenceRefsSchema = z.array(MemoryRunEvidenceRefSchema).min(1).max(32).superRefine((refs, context) => {
  const seen = new Set<number>();
  refs.forEach((ref, index) => {
    if (seen.has(ref.sequence)) {
      context.addIssue({ code: "custom", path: [index, "sequence"], message: "evidence references must be unique" });
    }
    seen.add(ref.sequence);
  });
});
export const ExperienceCaseStatusSchema = z.enum(["candidate", "validated", "disputed", "retired"]);

export const ExperienceOutcomeSchema = z.enum(["success", "failure", "partial", "unknown"]);
export type ExperienceOutcome = z.infer<typeof ExperienceOutcomeSchema>;

export const ExperienceConditionOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "at_least",
  "at_most",
]);

const experienceConditionFields = {
  dimension: NonEmptyStringSchema.max(100),
  operator: ExperienceConditionOperatorSchema,
  value: NonEmptyStringSchema.max(500),
};

export const ExperienceConditionDraftSchema = z.object({
  ...experienceConditionFields,
  evidenceSequences: EvidenceSequencesSchema,
}).strict();
export type ExperienceConditionDraft = z.infer<typeof ExperienceConditionDraftSchema>;

export const ExperienceConditionSchema = z.object({
  ...experienceConditionFields,
  evidenceRefs: ExperienceEvidenceRefsSchema,
}).strict();
export type ExperienceCondition = z.infer<typeof ExperienceConditionSchema>;

const experienceEvidenceStatementFields = {
  text: NonEmptyStringSchema.max(1_000),
};

export const ExperienceEvidenceStatementDraftSchema = z.object({
  ...experienceEvidenceStatementFields,
  evidenceSequences: EvidenceSequencesSchema,
}).strict();
export type ExperienceEvidenceStatementDraft = z.infer<typeof ExperienceEvidenceStatementDraftSchema>;

export const ExperienceEvidenceStatementSchema = z.object({
  ...experienceEvidenceStatementFields,
  evidenceRefs: ExperienceEvidenceRefsSchema,
}).strict();
export type ExperienceEvidenceStatement = z.infer<typeof ExperienceEvidenceStatementSchema>;

export const ExperienceSituationDraftSchema = z.object({
  conditions: z.array(ExperienceConditionDraftSchema).min(1).max(16),
}).strict();
export type ExperienceSituationDraft = z.infer<typeof ExperienceSituationDraftSchema>;

export const ExperienceSituationSchema = z.object({
  conditions: z.array(ExperienceConditionSchema).min(1).max(16),
}).strict();
export type ExperienceSituation = z.infer<typeof ExperienceSituationSchema>;

const experienceActionFields = {
  intent: NonEmptyStringSchema.max(1_000),
};

export const ExperienceActionPatternDraftSchema = z.object({
  ...experienceActionFields,
  preconditions: z.array(ExperienceConditionDraftSchema).max(16),
  steps: z.array(ExperienceEvidenceStatementDraftSchema).min(1).max(16),
}).strict();
export type ExperienceActionPatternDraft = z.infer<typeof ExperienceActionPatternDraftSchema>;

export const ExperienceActionPatternSchema = z.object({
  ...experienceActionFields,
  preconditions: z.array(ExperienceConditionSchema).max(16),
  steps: z.array(ExperienceEvidenceStatementSchema).min(1).max(16),
}).strict();
export type ExperienceActionPattern = z.infer<typeof ExperienceActionPatternSchema>;

const experienceOutcomeFields = {
  kind: ExperienceOutcomeSchema,
  summary: NonEmptyStringSchema.max(1_000),
};

export const ExperienceOutcomeDraftSchema = z.object({
  ...experienceOutcomeFields,
  evidenceSequences: EvidenceSequencesSchema,
}).strict();
export type ExperienceOutcomeDraft = z.infer<typeof ExperienceOutcomeDraftSchema>;

export const ExperienceOutcomeRefSchema = z.object({
  ...experienceOutcomeFields,
  evidenceRefs: ExperienceEvidenceRefsSchema,
}).strict();
export type ExperienceOutcomeRef = z.infer<typeof ExperienceOutcomeRefSchema>;

export const ExperienceVerificationKindSchema = z.enum([
  "test",
  "tool_receipt",
  "action_verified",
  "user_review",
  "observation",
  "other",
]);

const experienceVerificationFields = {
  kind: ExperienceVerificationKindSchema,
  summary: NonEmptyStringSchema.max(1_000),
};

export const ExperienceVerificationDraftSchema = z.object({
  ...experienceVerificationFields,
  evidenceSequences: EvidenceSequencesSchema,
}).strict();
export type ExperienceVerificationDraft = z.infer<typeof ExperienceVerificationDraftSchema>;

export const ExperienceVerificationRefSchema = z.object({
  ...experienceVerificationFields,
  evidenceRefs: ExperienceEvidenceRefsSchema,
}).strict();
export type ExperienceVerificationRef = z.infer<typeof ExperienceVerificationRefSchema>;

const experienceCounterexampleFields = {
  condition: NonEmptyStringSchema.max(1_000),
  reason: NonEmptyStringSchema.max(1_000),
};

export const ExperienceCounterexampleDraftSchema = z.object({
  ...experienceCounterexampleFields,
  evidenceSequences: EvidenceSequencesSchema,
}).strict();
export type ExperienceCounterexampleDraft = z.infer<typeof ExperienceCounterexampleDraftSchema>;

export const ExperienceCounterexampleSchema = z.object({
  ...experienceCounterexampleFields,
  evidenceRefs: ExperienceEvidenceRefsSchema,
}).strict();
export type ExperienceCounterexample = z.infer<typeof ExperienceCounterexampleSchema>;

const experienceApplicabilityFields = {
  ...experienceConditionFields,
};

export const ExperienceApplicabilityDraftSchema = z.object({
  ...experienceApplicabilityFields,
  evidenceSequences: EvidenceSequencesSchema,
}).strict();
export type ExperienceApplicabilityDraft = z.infer<typeof ExperienceApplicabilityDraftSchema>;

export const ExperienceScopeRuleSchema = z.object({
  ...experienceApplicabilityFields,
  evidenceRefs: ExperienceEvidenceRefsSchema,
}).strict();
export type ExperienceScopeRule = z.infer<typeof ExperienceScopeRuleSchema>;

const experienceCaseDraftFields = {
  title: NonEmptyStringSchema.max(300),
  situation: ExperienceSituationDraftSchema,
  objective: NonEmptyStringSchema.max(1_000),
  actions: z.array(ExperienceActionPatternDraftSchema).min(1).max(8),
  outcome: ExperienceOutcomeDraftSchema,
  verification: z.array(ExperienceVerificationDraftSchema).max(16),
  counterexamples: z.array(ExperienceCounterexampleDraftSchema).max(16),
  applicability: z.array(ExperienceApplicabilityDraftSchema).min(1).max(16),
  confidence: z.number().finite().min(0).max(1).optional(),
};

export const ExperienceCaseDraftSchema = z.object(experienceCaseDraftFields)
  .strict()
  .superRefine((value, context) => {
    if (value.outcome.kind !== "unknown" && value.verification.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "a known outcome requires at least one evidence-backed verification",
      });
    }
  });
export type ExperienceCaseDraft = z.infer<typeof ExperienceCaseDraftSchema>;

export const ExperienceCaseExtractionInputSchema = z.object({
  projectId: IdentifierSchema,
  runId: IdentifierSchema,
  episodeId: IdentifierSchema,
  sourceDigest: Sha256Schema,
  episodeOutcome: MemoryEpisodeOutcomeSchema,
  sourceText: NonEmptyStringSchema.max(48_000),
  evidenceSequences: z.array(z.number().int().positive()).min(1).max(256).superRefine((sequences, context) => {
    if (new Set(sequences).size !== sequences.length) {
      context.addIssue({ code: "custom", message: "allowed evidence sequences must be unique" });
    }
  }),
}).strict();
export type ExperienceCaseExtractionInput = z.infer<typeof ExperienceCaseExtractionInputSchema>;

export const ExperienceCaseExtractionResultSchema = z.object({
  cases: z.array(ExperienceCaseDraftSchema).max(4),
}).strict();
export type ExperienceCaseExtractionResult = z.infer<typeof ExperienceCaseExtractionResultSchema>;

const experienceCaseFields = {
  schemaVersion: z.literal("tracegraph.experience-case.v1"),
  caseId: IdentifierSchema,
  version: z.number().int().positive(),
  projectId: IdentifierSchema,
  episodeId: IdentifierSchema,
  sourceDigest: Sha256Schema,
  extractorId: IdentifierSchema,
  title: NonEmptyStringSchema.max(300),
  situation: ExperienceSituationSchema,
  objective: NonEmptyStringSchema.max(1_000),
  actions: z.array(ExperienceActionPatternSchema).min(1).max(8),
  outcome: ExperienceOutcomeRefSchema,
  verification: z.array(ExperienceVerificationRefSchema).max(16),
  counterexamples: z.array(ExperienceCounterexampleSchema).max(16),
  applicability: z.array(ExperienceScopeRuleSchema).min(1).max(16),
  evidenceRefs: z.array(MemoryRunEvidenceRefSchema).min(1).max(128).superRefine((refs, context) => {
    if (new Set(refs.map(({ sequence }) => sequence)).size !== refs.length) {
      context.addIssue({ code: "custom", message: "case evidence references must be unique" });
    }
  }),
  confidence: z.number().finite().min(0).max(1).optional(),
  status: ExperienceCaseStatusSchema,
};

export const ExperienceCaseSchema = z.object(experienceCaseFields)
  .strict()
  .superRefine((value, context) => {
    if (value.outcome.kind !== "unknown" && value.verification.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "a known outcome requires at least one evidence-backed verification",
      });
    }
    if (value.status === "candidate" && value.version !== 1) {
      context.addIssue({ code: "custom", path: ["version"], message: "candidate projections start at version 1" });
    }
  });
export type ExperienceCase = z.infer<typeof ExperienceCaseSchema>;
