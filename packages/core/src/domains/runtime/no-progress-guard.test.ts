import { describe, expect, it } from "vitest";
import {
  assessNoProgress,
  buildProgressFingerprint,
  DEFAULT_NO_PROGRESS_POLICY,
  resolveNoProgressPolicy,
  type ProgressFingerprint,
} from "./no-progress-guard.js";

describe("Runtime no-progress guard", () => {
  it("stops a repeated call only after a full no-progress window", () => {
    const evidence = new Set<string>();
    const history: ProgressFingerprint[] = [];
    let final = assessNoProgress(history, fingerprint(), DEFAULT_NO_PROGRESS_POLICY);

    for (let turn = 0; turn < DEFAULT_NO_PROGRESS_POLICY.windowTurns; turn += 1) {
      const current = fingerprint(evidence);
      final = assessNoProgress(history, current, DEFAULT_NO_PROGRESS_POLICY);
      if (!final.triggered) history.push(current);
    }

    expect(final).toEqual({
      triggered: true,
      recentTurns: 4,
      noProgressTurns: 3,
      repeatedCallCount: 3,
      totalCallCount: 4,
      repeatedCallRatio: 0.75,
    });
  });

  it("treats changed results from the same call as new evidence", () => {
    const evidence = new Set<string>();
    const history: ProgressFingerprint[] = [];
    let final = assessNoProgress(history, fingerprint(), DEFAULT_NO_PROGRESS_POLICY);

    for (let turn = 0; turn < DEFAULT_NO_PROGRESS_POLICY.windowTurns; turn += 1) {
      const current = fingerprint(evidence, `revision ${turn}`);
      final = assessNoProgress(history, current, DEFAULT_NO_PROGRESS_POLICY);
      history.push(current);
    }

    expect(final.triggered).toBe(false);
    expect(final.noProgressTurns).toBe(0);
  });

  it("ignores Runtime-generated IDs when deduplicating the same result", () => {
    const evidence = new Set<string>();
    const first = buildProgressFingerprint([{
      normalizedToolCall: "call:todo-update",
      toolName: "todo_write",
      sideEffect: "none",
      result: {
        status: "success",
        code: "todo.updated",
        summary: "Todo updated",
        facts: { event_id: "event:one", todo_id: "todo:one", state: "in_progress" },
      },
    }], evidence);
    const repeated = buildProgressFingerprint([{
      normalizedToolCall: "call:todo-update",
      toolName: "todo_write",
      sideEffect: "none",
      result: {
        status: "success",
        code: "todo.updated",
        summary: "Todo updated",
        facts: { event_id: "event:two", todo_id: "todo:one", state: "in_progress" },
      },
    }], evidence);

    expect(first.newEvidenceCount).toBe(1);
    expect(repeated.newEvidenceCount).toBe(0);
  });

  it("does not mistake distinct calls with identical output for repetition", () => {
    const evidence = new Set<string>();
    const history: ProgressFingerprint[] = [];
    let final = assessNoProgress(history, fingerprint(), DEFAULT_NO_PROGRESS_POLICY);

    for (let turn = 0; turn < DEFAULT_NO_PROGRESS_POLICY.windowTurns; turn += 1) {
      const current = fingerprint(evidence, "same output", `call-${turn}`);
      final = assessNoProgress(history, current, DEFAULT_NO_PROGRESS_POLICY);
      history.push(current);
    }

    expect(final.triggered).toBe(false);
    expect(final.repeatedCallRatio).toBe(0);
  });

  it("validates trusted policy overrides", () => {
    expect(resolveNoProgressPolicy({ windowTurns: 5 })).toEqual({
      ...DEFAULT_NO_PROGRESS_POLICY,
      windowTurns: 5,
    });
    expect(() => resolveNoProgressPolicy({ windowTurns: 3, minimumNoProgressTurns: 3 })).toThrow(RangeError);
    expect(() => resolveNoProgressPolicy({ minimumRepeatedCallRatio: 0.49 })).toThrow(RangeError);
  });
});

function fingerprint(
  seenEvidence = new Set<string>(),
  content = "stable result",
  call = "call:read-source",
): ProgressFingerprint {
  return buildProgressFingerprint([{
    normalizedToolCall: call,
    toolName: "read_file",
    sideEffect: "read",
    result: {
      status: "success",
      code: "file_read",
      summary: "Read source",
      content,
      mimeType: "text/plain",
      facts: { path: "src/source.ts", content },
    },
  }], seenEvidence);
}
