import {
  ExperienceCaseExtractionInputSchema,
  ExperienceCaseExtractionResultSchema,
  ExperienceCaseSchema,
  ExperienceConditionSchema,
  ExperienceEvidenceStatementSchema,
  ExperienceOutcomeRefSchema,
  ExperienceVerificationRefSchema,
  ExperienceCounterexampleSchema,
  ExperienceScopeRuleSchema,
  MemoryEpisodeSchema,
  SessionEventSchema,
  type ExperienceCase,
  type ExperienceCaseExtractionInput,
  type ExperienceConditionDraft,
  type ExperienceEvidenceStatementDraft,
  type ExperienceOutcomeDraft,
  type ExperienceVerificationDraft,
  type ExperienceCounterexampleDraft,
  type ExperienceApplicabilityDraft,
  type ExperienceActionPatternDraft,
  type ExperienceSituationDraft,
  type MemoryEpisode,
  type SessionEvent,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";
import type { ModelAdapter } from "../../kernel/types.js";
import {
  assertCandidateEvidenceSequences,
  buildMemoryEpisodeExtractionInput,
  projectMemoryEpisode,
} from "../memory/memory-episode.js";

export const EXPERIENCE_CASE_EXTRACTOR_VERSION = "episode-extractor-v1";
export const MAX_EXPERIENCE_CASE_RESULT_CHARS = 32_000;

export interface ExperienceCaseExtractor {
  readonly id: string;
  canExtract(): boolean;
  extract(input: ExperienceCaseExtractionInput, options: { signal: AbortSignal }): Promise<unknown>;
}

export interface ProjectExperienceCaseCandidatesInput {
  readonly episode: MemoryEpisode;
  readonly events: readonly SessionEvent[];
  readonly extractionInput: ExperienceCaseExtractionInput;
  readonly extractorId: string;
  readonly result: unknown;
}

export function buildExperienceCaseExtractionInput(
  episodeValue: MemoryEpisode,
  eventValues: readonly unknown[],
): ExperienceCaseExtractionInput {
  const episode = MemoryEpisodeSchema.parse(episodeValue);
  const events = eventValues.map((event) => SessionEventSchema.parse(event));
  const canonicalEpisode = projectMemoryEpisode(events);
  if (canonicalEpisode.episodeId !== episode.episodeId
    || canonicalEpisode.projectId !== episode.projectId
    || canonicalEpisode.runId !== episode.runId
    || canonicalEpisode.sourceDigest !== episode.sourceDigest) {
    throw new ExperienceCaseExtractionError(
      "experience_case_source_mismatch",
      "Experience extraction Episode does not match the canonical settled Run",
    );
  }
  const episodeInput = buildMemoryEpisodeExtractionInput(canonicalEpisode, events);
  const { outcome: episodeOutcome, ...input } = episodeInput;
  return ExperienceCaseExtractionInputSchema.parse({ ...input, episodeOutcome });
}

/** Convert untrusted model output into candidate-only, source-addressable projections. */
export function projectExperienceCaseCandidates(
  inputValue: ProjectExperienceCaseCandidatesInput,
): ExperienceCase[] {
  const episode = MemoryEpisodeSchema.parse(inputValue.episode);
  const events = inputValue.events.map((event) => SessionEventSchema.parse(event));
  const canonicalInput = buildExperienceCaseExtractionInput(episode, events);
  const extractionInput = ExperienceCaseExtractionInputSchema.parse(inputValue.extractionInput);
  if (stableStringify(canonicalInput) !== stableStringify(extractionInput)) {
    throw new ExperienceCaseExtractionError(
      "experience_case_input_mismatch",
      "Experience extractor input differs from the bounded canonical Episode input",
    );
  }

  const parsed = ExperienceCaseExtractionResultSchema.safeParse(inputValue.result);
  if (!parsed.success) {
    throw new ExperienceCaseExtractionError(
      "experience_case_invalid_output",
      "Experience extractor output does not match the strict Case draft contract",
      { cause: parsed.error },
    );
  }
  if (stableStringify(parsed.data).length > MAX_EXPERIENCE_CASE_RESULT_CHARS) {
    throw new ExperienceCaseExtractionError(
      "experience_case_output_unbounded",
      "Experience extractor output exceeds the bounded result size",
    );
  }

  const extractorId = inputValue.extractorId.trim();
  if (extractorId.length === 0 || extractorId.length > 160) {
    throw new ExperienceCaseExtractionError("experience_case_invalid_extractor", "Experience extractor identity is invalid");
  }

  return parsed.data.cases.map((draft, index) => {
    const allSequences = collectDraftEvidenceSequences(draft);
    const allEvidenceRefs = resolveEvidenceSequences(allSequences, extractionInput, episode, events);
    const evidenceBySequence = new Map(allEvidenceRefs.map((ref) => [ref.sequence, ref]));
    const resolve = (sequences: readonly number[]) => sequences.map((sequence) => {
      const ref = evidenceBySequence.get(sequence);
      if (ref === undefined) {
        throw new ExperienceCaseExtractionError(
          "experience_case_evidence_not_in_input",
          "Experience Case cites evidence that was not included in the bounded extractor input",
        );
      }
      return ref;
    });
    return ExperienceCaseSchema.parse({
      schemaVersion: "tracegraph.experience-case.v1",
      caseId: experienceCaseId(episode.episodeId, extractorId, index),
      version: 1,
      projectId: episode.projectId,
      episodeId: episode.episodeId,
      sourceDigest: episode.sourceDigest,
      extractorId,
      title: draft.title,
      situation: {
        conditions: draft.situation.conditions.map((condition) => mapCondition(condition, resolve)),
      },
      objective: draft.objective,
      actions: draft.actions.map((action) => mapAction(action, resolve)),
      outcome: mapOutcome(draft.outcome, resolve),
      verification: draft.verification.map((verification) => mapVerification(verification, resolve)),
      counterexamples: draft.counterexamples.map((counterexample) => mapCounterexample(counterexample, resolve)),
      applicability: draft.applicability.map((rule) => mapApplicability(rule, resolve)),
      evidenceRefs: allEvidenceRefs,
      ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
      status: "candidate",
    });
  });
}

export async function extractExperienceCaseCandidates(
  extractor: ExperienceCaseExtractor,
  episode: MemoryEpisode,
  events: readonly SessionEvent[],
  signal: AbortSignal,
): Promise<ExperienceCase[]> {
  if (!extractor.canExtract()) {
    throw new ExperienceCaseExtractionError("experience_case_extractor_unavailable", "Experience Case extraction is not configured");
  }
  signal.throwIfAborted();
  const extractionInput = buildExperienceCaseExtractionInput(episode, events);
  const result = await extractor.extract(extractionInput, { signal });
  signal.throwIfAborted();
  return projectExperienceCaseCandidates({
    episode,
    events,
    extractionInput,
    extractorId: extractor.id,
    result,
  });
}

export function createModelExperienceCaseExtractor(model: ModelAdapter): ExperienceCaseExtractor | undefined {
  if (model.extractExperienceCase === undefined) return undefined;
  return {
    id: "model-experience-extractor:v1",
    canExtract: () => model.canExtractExperienceCase?.() ?? true,
    extract: (input, options) => model.extractExperienceCase!(input, options),
  };
}

function collectDraftEvidenceSequences(draft: {
  situation: ExperienceSituationDraft;
  actions: ExperienceActionPatternDraft[];
  outcome: ExperienceOutcomeDraft;
  verification: ExperienceVerificationDraft[];
  counterexamples: ExperienceCounterexampleDraft[];
  applicability: ExperienceApplicabilityDraft[];
}): number[] {
  const sequences = [
    ...draft.situation.conditions.flatMap(({ evidenceSequences }) => evidenceSequences),
    ...draft.actions.flatMap((action) => [
      ...action.preconditions.flatMap(({ evidenceSequences }) => evidenceSequences),
      ...action.steps.flatMap(({ evidenceSequences }) => evidenceSequences),
    ]),
    ...draft.outcome.evidenceSequences,
    ...draft.verification.flatMap(({ evidenceSequences }) => evidenceSequences),
    ...draft.counterexamples.flatMap(({ evidenceSequences }) => evidenceSequences),
    ...draft.applicability.flatMap(({ evidenceSequences }) => evidenceSequences),
  ];
  return [...new Set(sequences)].sort((left, right) => left - right);
}

function resolveEvidenceSequences(
  sequences: readonly number[],
  input: ExperienceCaseExtractionInput,
  episode: MemoryEpisode,
  events: readonly SessionEvent[],
) {
  const allowed = new Set(input.evidenceSequences);
  if (sequences.some((sequence) => !allowed.has(sequence))) {
    throw new ExperienceCaseExtractionError(
      "experience_case_evidence_not_in_input",
      "Experience Case cites evidence that was not included in the bounded extractor input",
    );
  }
  return assertCandidateEvidenceSequences(episode, events, sequences);
}

function mapCondition(
  draft: ExperienceConditionDraft,
  resolve: (sequences: readonly number[]) => ReturnType<typeof assertCandidateEvidenceSequences>,
) {
  const { evidenceSequences, ...fields } = draft;
  return ExperienceConditionSchema.parse({ ...fields, evidenceRefs: resolve(evidenceSequences) });
}

function mapEvidenceStatement(
  draft: ExperienceEvidenceStatementDraft,
  resolve: (sequences: readonly number[]) => ReturnType<typeof assertCandidateEvidenceSequences>,
) {
  const { evidenceSequences, ...fields } = draft;
  return ExperienceEvidenceStatementSchema.parse({ ...fields, evidenceRefs: resolve(evidenceSequences) });
}

function mapAction(
  draft: ExperienceActionPatternDraft,
  resolve: (sequences: readonly number[]) => ReturnType<typeof assertCandidateEvidenceSequences>,
) {
  return {
    intent: draft.intent,
    preconditions: draft.preconditions.map((condition) => mapCondition(condition, resolve)),
    steps: draft.steps.map((step) => mapEvidenceStatement(step, resolve)),
  };
}

function mapOutcome(
  draft: ExperienceOutcomeDraft,
  resolve: (sequences: readonly number[]) => ReturnType<typeof assertCandidateEvidenceSequences>,
) {
  const { evidenceSequences, ...fields } = draft;
  return ExperienceOutcomeRefSchema.parse({ ...fields, evidenceRefs: resolve(evidenceSequences) });
}

function mapVerification(
  draft: ExperienceVerificationDraft,
  resolve: (sequences: readonly number[]) => ReturnType<typeof assertCandidateEvidenceSequences>,
) {
  const { evidenceSequences, ...fields } = draft;
  return ExperienceVerificationRefSchema.parse({ ...fields, evidenceRefs: resolve(evidenceSequences) });
}

function mapCounterexample(
  draft: ExperienceCounterexampleDraft,
  resolve: (sequences: readonly number[]) => ReturnType<typeof assertCandidateEvidenceSequences>,
) {
  const { evidenceSequences, ...fields } = draft;
  return ExperienceCounterexampleSchema.parse({ ...fields, evidenceRefs: resolve(evidenceSequences) });
}

function mapApplicability(
  draft: ExperienceApplicabilityDraft,
  resolve: (sequences: readonly number[]) => ReturnType<typeof assertCandidateEvidenceSequences>,
) {
  const { evidenceSequences, ...fields } = draft;
  return ExperienceScopeRuleSchema.parse({ ...fields, evidenceRefs: resolve(evidenceSequences) });
}

function experienceCaseId(episodeId: string, extractorId: string, slot: number): string {
  return `experience:${sha256(stableStringify({
    version: EXPERIENCE_CASE_EXTRACTOR_VERSION,
    episodeId,
    extractorId,
    slot,
  })).slice("sha256:".length, 40)}`;
}

export class ExperienceCaseExtractionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExperienceCaseExtractionError";
    this.code = code;
  }
}
