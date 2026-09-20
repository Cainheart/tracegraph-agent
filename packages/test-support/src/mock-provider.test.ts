import { describe, expect, it, vi } from "vitest";
import type { ModelInput } from "@tracegraph/core";
import {
  MAX_MOCK_PROVIDER_RESPONSE_BYTES,
  MAX_MOCK_PROVIDER_STEPS,
  ScriptedMockProvider,
  mockDecision,
  mockInvalidOutput,
  mockTimeout,
} from "./mock-provider.js";

const finishDecision = {
  decision_id: "decision:mock-finish",
  kind: "finish" as const,
  public_reason: "The scripted evaluation is complete.",
  evidence_refs: [],
  risk: "none" as const,
  final_answer: "Done.",
};

describe("ScriptedMockProvider", () => {
  it("returns fixed decisions in order and reports canonical usage without network access", async () => {
    const usage = {
      provider: "tracegraph-mock",
      model: "scripted-v1",
      input_tokens: 21,
      output_tokens: 5,
      total_tokens: 26,
      request_kind: "initial" as const,
      request_sequence: 1,
    };
    const provider = new ScriptedMockProvider({
      decisions: [mockDecision(finishDecision, usage)],
    });
    const reports: unknown[] = [];

    await expect(provider.decide(input({ onUsage: (report) => reports.push(report) })))
      .resolves.toEqual(finishDecision);
    expect(reports).toEqual([usage]);
    expect(provider.calls()).toEqual([{
      channel: "decision",
      ordinal: 0,
      step_kind: "response",
      run_id: "run:mock",
    }]);
    expect(provider.remaining()).toEqual({ decisions: 0, summaries: 0 });
    await expect(provider.decide(input())).rejects.toMatchObject({ code: "mock_script_exhausted" });
  });

  it("returns explicit invalid output for Runtime validation and isolates usage callback failures", async () => {
    const provider = new ScriptedMockProvider({
      decisions: [mockInvalidOutput({ unexpected: true }, {
        provider: "tracegraph-mock",
        model: "scripted-v1",
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 3,
        request_kind: "initial",
        request_sequence: 1,
      })],
    });

    await expect(provider.decide(input({ onUsage: () => { throw new Error("consumer failed"); } })))
      .resolves.toEqual({ unexpected: true });
    expect(provider.calls()[0]?.step_kind).toBe("invalid_output");
  });

  it("fails a finite timeout and responds immediately to AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const timeoutProvider = new ScriptedMockProvider({ decisions: [mockTimeout(20)] });
      const timedOut = timeoutProvider.decide(input());
      const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: "mock_timeout" });
      await vi.advanceTimersByTimeAsync(20);
      await timeoutAssertion;

      const abortProvider = new ScriptedMockProvider({ decisions: [mockTimeout(20_000)] });
      const controller = new AbortController();
      const aborted = abortProvider.decide(input({ signal: controller.signal }));
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ code: "mock_aborted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unbounded scripts, payloads, waits, and mismatched usage identities", () => {
    expect(() => new ScriptedMockProvider({
      decisions: Array.from({ length: MAX_MOCK_PROVIDER_STEPS + 1 }, () => mockInvalidOutput(null)),
    })).toThrow(/steps/u);
    expect(() => new ScriptedMockProvider({
      decisions: [mockInvalidOutput("x".repeat(MAX_MOCK_PROVIDER_RESPONSE_BYTES + 1))],
    })).toThrow(/response/u);
    expect(() => mockTimeout(0)).toThrow(/timeout/u);
    expect(() => new ScriptedMockProvider({
      decisions: [{
        ...mockDecision(finishDecision),
        usage: {
          provider: "another-provider",
          model: "scripted-v1",
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          request_kind: "initial",
          request_sequence: 1,
        },
      }],
    })).toThrow(/identity/u);
  });
});

function input(overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    projectId: "project:mock",
    runId: "run:mock",
    task: "Run a deterministic offline evaluation.",
    mode: "execute",
    reasoningEffort: "default",
    turn: 1,
    context: "bounded context",
    contextManifest: {} as ModelInput["contextManifest"],
    observations: [],
    toolSchemas: [],
    ...overrides,
  };
}
