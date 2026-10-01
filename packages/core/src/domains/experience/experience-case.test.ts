import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  SessionEventSchema,
  type SessionEvent,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";
import {
  ExperienceCaseExtractionError,
  buildExperienceCaseExtractionInput,
  extractExperienceCaseCandidates,
  projectExperienceCaseCandidates,
  type ExperienceCaseExtractor,
} from "./experience-case.js";
import { projectMemoryEpisode } from "../memory/memory-episode.js";

describe("Experience Case extraction", () => {
  it.each(["success", "failure", "partial", "unknown"] as const)(
    "projects a stable, review-gated %s case with exact evidence references",
    async (kind) => {
      const fixture = makeEpisode();
      const extractor: ExperienceCaseExtractor = {
        id: "experience-extractor:test-v1",
        canExtract: () => true,
        async extract(input) {
          expect(input.evidenceSequences).toContain(2);
          expect(input.sourceText).not.toContain("experience-secret-must-redact");
          return { cases: [caseDraft(kind)] };
        },
      };

      const controller = new AbortController();
      const result = await extractExperienceCaseCandidates(extractor, fixture.episode, fixture.events, controller.signal);
      const replayed = await extractExperienceCaseCandidates(extractor, fixture.episode, fixture.events, controller.signal);
      const experience = result[0]!;

      expect(experience).toEqual(replayed[0]);
      expect(experience).toMatchObject({
        schemaVersion: "tracegraph.experience-case.v1",
        caseId: expect.stringMatching(/^experience:/u),
        version: 1,
        projectId: "project:experience-tests",
        episodeId: fixture.episode.episodeId,
        sourceDigest: fixture.episode.sourceDigest,
        extractorId: extractor.id,
        outcome: { kind },
        applicability: [{
          dimension: "workspace_kind",
          operator: "equals",
          value: "repository",
          evidenceRefs: [{ sequence: 1, eventHash: fixture.events[0]?.event_hash }],
        }],
        counterexamples: [{
          condition: "No external provider was called.",
          evidenceRefs: [{ sequence: 3, eventType: "run.completed" }],
        }],
        status: "candidate",
      });
      expect(experience.evidenceRefs.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
      expect(experience.actions[0]?.steps[0]?.evidenceRefs[0]?.runId).toBe(fixture.episode.runId);
      expect("command" in experience.actions[0]!).toBe(false);
    },
  );

  it("rejects citations outside the rows sent to the extractor", () => {
    const fixture = makeEpisode();
    const extractionInput = buildExperienceCaseExtractionInput(fixture.episode, fixture.events);

    expect(() => projectExperienceCaseCandidates({
      ...fixture,
      extractionInput,
      extractorId: "experience-extractor:test-v1",
      result: { cases: [caseDraft("success", { applicability: 99_999 })] },
    })).toThrowError(expect.objectContaining({
      name: "ExperienceCaseExtractionError",
      code: "experience_case_evidence_not_in_input",
    }));
  });

  it("rejects a forged input and a known outcome with no verification", () => {
    const fixture = makeEpisode();
    const extractionInput = buildExperienceCaseExtractionInput(fixture.episode, fixture.events);

    expect(() => projectExperienceCaseCandidates({
      ...fixture,
      extractionInput: { ...extractionInput, sourceText: "forged source" },
      extractorId: "experience-extractor:test-v1",
      result: { cases: [] },
    })).toThrowError(ExperienceCaseExtractionError);

    expect(() => projectExperienceCaseCandidates({
      ...fixture,
      extractionInput,
      extractorId: "experience-extractor:test-v1",
      result: { cases: [caseDraft("success", { omitVerification: true })] },
    })).toThrowError(expect.objectContaining({
      code: "experience_case_invalid_output",
    }));
  });

  it("rejects duplicate evidence citations instead of silently normalizing them", () => {
    const fixture = makeEpisode();
    const extractionInput = buildExperienceCaseExtractionInput(fixture.episode, fixture.events);
    const duplicateDraft = caseDraft("unknown");
    duplicateDraft.situation.conditions[0]!.evidenceSequences = [1, 1];

    expect(() => projectExperienceCaseCandidates({
      ...fixture,
      extractionInput,
      extractorId: "experience-extractor:test-v1",
      result: { cases: [duplicateDraft] },
    })).toThrowError(expect.objectContaining({ code: "experience_case_invalid_output" }));
  });
});

function caseDraft(
  kind: "success" | "failure" | "partial" | "unknown",
  options: { applicability?: number; omitVerification?: boolean } = {},
) {
  return {
    title: "Use a focused verification before continuing.",
    situation: {
      conditions: [{
        dimension: "task_kind",
        operator: "equals",
        value: "repository change",
        evidenceSequences: [1],
      }],
    },
    objective: "Confirm the change against its intended behavior.",
    actions: [{
      intent: "Check the affected behavior.",
      preconditions: [],
      steps: [{ text: "Run the focused check.", evidenceSequences: [2] }],
    }],
    outcome: { kind, summary: "The Run recorded this outcome.", evidenceSequences: [3] },
    verification: options.omitVerification === true
      ? []
      : [{ kind: "test", summary: "The focused check completed.", evidenceSequences: [2] }],
    counterexamples: [{
      condition: "No external provider was called.",
      reason: "This result does not establish remote behavior.",
      evidenceSequences: [3],
    }],
    applicability: [{
      dimension: "workspace_kind",
      operator: "equals",
      value: "repository",
      evidenceSequences: [options.applicability ?? 1],
    }],
  };
}

function makeEpisode(): { episode: ReturnType<typeof projectMemoryEpisode>; events: SessionEvent[] } {
  const runId = "run:experience-case";
  const projectId = "project:experience-tests";
  const values: SessionEvent[] = [];
  const types = ["run.created", "tool.completed", "run.completed"] as const;
  for (const [index, type] of types.entries()) {
    const sequence = index + 1;
    const body = {
      schema_version: SCHEMA_VERSION,
      event_id: `event:experience-case:${sequence}`,
      project_id: projectId,
      run_id: runId,
      sequence,
      occurred_at: new Date(Date.UTC(2026, 9, 1, 0, 0, sequence)).toISOString(),
      attempt: 0,
      summary: sequence === 2
        ? "The focused test passed. private_token=experience-secret-must-redact"
        : type === "run.completed"
          ? "Run completed"
          : "Repository change started",
      artifact_refs: [],
      ...(values.at(-1) === undefined ? {} : { previous_event_hash: values.at(-1)!.event_hash }),
      type,
      data: type === "tool.completed"
        ? { receipt: { tool_name: "test", status: "success", business_status: "success" } }
        : {},
    };
    values.push(SessionEventSchema.parse({
      ...body,
      event_hash: sha256(stableStringify(body)),
    }));
  }
  return { episode: projectMemoryEpisode(values), events: values };
}
