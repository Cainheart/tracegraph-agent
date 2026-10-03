import { describe, expect, it } from "vitest";
import { createDemoSnapshot, events } from "./demo";
import { adjacentReplaySequence, canUseExecuteMode, evidenceForSelection, getInspectorTabs, getStatusLabel, graphForVersion, totalDiff } from "./model";

describe("workbench view rules", () => {
  it("locks Manual mode for local repositories", () => {
    expect(canUseExecuteMode(createDemoSnapshot("ready", "readonly_local").project)).toBe(false);
    expect(canUseExecuteMode(createDemoSnapshot("ready", "disposable_fixture").project)).toBe(true);
    expect(canUseExecuteMode(null)).toBe(false);
  });

  it("only exposes inspector tabs backed by event relations", () => {
    const query = events.find((event) => event.kind === "query") ?? null;
    const patch = events.find((event) => event.kind === "patch") ?? null;

    expect(getInspectorTabs(query)).toEqual(["summary", "io"]);
    expect(getInspectorTabs(patch)).toEqual([
      "summary",
      "io",
      "context",
      "changes",
      "architecture",
      "evidence",
      "timing",
    ]);
    expect(getInspectorTabs(null)).toEqual([]);
  });

  it("keeps all required user-facing run states named", () => {
    expect(getStatusLabel("needs_approval")).toBe("Needs approval");
    expect(getStatusLabel("ready_for_review")).toBe("Ready for review");
    expect(getStatusLabel("reconnecting")).toBe("Reconnecting");
    expect(getStatusLabel("historical")).toBe("Historical run");
  });

  it("aggregates the review diff without trusting header constants", () => {
    expect(totalDiff(createDemoSnapshot("completed").changedFiles)).toEqual({ additions: 14, deletions: 4 });
  });

  it("does not claim future test evidence while approval is pending", () => {
    const pendingPatch = createDemoSnapshot("needs_approval").run?.events.find((event) => event.kind === "patch");
    const completedPatch = createDemoSnapshot("completed").run?.events.find((event) => event.kind === "patch");

    expect(pendingPatch?.testReceiptRef).toBeUndefined();
    expect(pendingPatch?.graphDeltaRef).toBeUndefined();
    expect(completedPatch?.testReceiptRef).toBe("test_018");
  });

  it("uses run-level latest evidence only while no trajectory event is selected", () => {
    const snapshot = createDemoSnapshot("completed");
    const query = snapshot.run?.events.find((event) => event.kind === "query") ?? null;

    expect(evidenceForSelection(snapshot, null).evidence.diff.status).toBe("demo");
    expect(evidenceForSelection(snapshot, query).evidence.diff.status).toBe("not_present");
    expect(evidenceForSelection(snapshot, query).changedFiles).toEqual([]);
  });

  it("materializes changed graph entities from their real before and after values", () => {
    const snapshot = createDemoSnapshot("completed");
    const before = graphForVersion(snapshot.graphNodes, snapshot.graphEdges, "before");
    const after = graphForVersion(snapshot.graphNodes, snapshot.graphEdges, "after");

    expect(before.nodes.find((node) => node.id === "parser")?.label).toBe("parser.ts · direct trim");
    expect(after.nodes.find((node) => node.id === "parser")?.label).toBe("parser.ts · normalizer");
    expect(before.nodes.some((node) => node.id === "normalizer")).toBe(false);
    expect(after.nodes.some((node) => node.id === "normalizer")).toBe(true);
  });

  it("steps through recorded replay sequences without assuming they are contiguous", () => {
    const sequences = [1, 3, 8];
    expect(adjacentReplaySequence(sequences, 3, -1)).toBe(1);
    expect(adjacentReplaySequence(sequences, 3, 1)).toBe(8);
    expect(adjacentReplaySequence(sequences, 1, -1)).toBeNull();
    expect(adjacentReplaySequence(sequences, 8, 1)).toBeNull();
    expect(adjacentReplaySequence(sequences, 2, 1)).toBeNull();
  });
});
