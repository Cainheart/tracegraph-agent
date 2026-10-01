import { describe, expect, it } from "vitest";
import {
  ExperienceCaseDraftSchema,
  ExperienceCaseExtractionInputSchema,
} from "./experience-case.js";

describe("Experience Case contracts", () => {
  it.each(["success", "failure", "partial", "unknown"] as const)(
    "expresses the %s outcome with applicability and counterexamples",
    (kind) => {
      expect(ExperienceCaseDraftSchema.safeParse(draft(kind)).success).toBe(true);
    },
  );

  it("requires evidence-backed verification for a known outcome", () => {
    expect(ExperienceCaseDraftSchema.safeParse(draft("success", false)).success).toBe(false);
    expect(ExperienceCaseDraftSchema.safeParse(draft("unknown", false)).success).toBe(true);
  });

  it("keeps the extractor wire bounded and rejects caller-assigned identity fields", () => {
    const input = {
      projectId: "project:experience-contract",
      runId: "run:experience-contract",
      episodeId: "episode:experience-contract",
      sourceDigest: "sha256:" + "a".repeat(64),
      episodeOutcome: "succeeded",
      sourceText: JSON.stringify([{ sequence: 1, summary: "A source event." }]),
      evidenceSequences: [1],
    };
    expect(ExperienceCaseExtractionInputSchema.safeParse(input).success).toBe(true);
    expect(ExperienceCaseDraftSchema.safeParse({ ...draft("unknown"), caseId: "experience:forged" }).success).toBe(false);
    expect(ExperienceCaseExtractionInputSchema.safeParse({
      ...input,
      sourceText: "x".repeat(48_001),
    }).success).toBe(false);
    expect(ExperienceCaseExtractionInputSchema.safeParse({
      ...input,
      evidenceSequences: [1, 1],
    }).success).toBe(false);
    expect(ExperienceCaseDraftSchema.safeParse({
      ...draft("unknown"),
      outcome: { kind: "unknown", summary: "Observed outcome.", evidenceSequences: [3, 3] },
    }).success).toBe(false);
  });
});

function draft(kind: "success" | "failure" | "partial" | "unknown", verified = true) {
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
    verification: verified
      ? [{ kind: "test", summary: "The focused check completed.", evidenceSequences: [2] }]
      : [],
    counterexamples: [{
      condition: "The fixture does not cover an external service.",
      reason: "This result does not establish remote behavior.",
      evidenceSequences: [3],
    }],
    applicability: [{
      dimension: "workspace_kind",
      operator: "equals",
      value: "repository",
      evidenceSequences: [1],
    }],
  };
}
