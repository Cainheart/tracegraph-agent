import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectStructuralBaseline,
  compareStructuralBaseline,
  renderReport,
} from "./gen-current-baseline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function samplePerformance() {
  return {
    measured_at: "2026-09-29T00:00:00.000Z",
    result: "passed",
    test_summary: { total: 3, passed: 3, failed: 0 },
    command: "fixture performance command",
    metrics: [{ name: "sample", value: 1, unit: "ms", accepted_max: 10 }],
  };
}

describe("current baseline generator", () => {
  it("collects package DAG, source LOC, static test inventory, and event schema size", async () => {
    const structure = await collectStructuralBaseline(root);
    assert.ok(structure.packages.length > 0);
    assert.ok(structure.packages.some(({ name, dependencies }) => name === "@tracegraph/cli" && dependencies.includes("@tracegraph/core")));
    assert.ok(structure.source_loc.nonblank_lines > 0);
    assert.ok(structure.tests.test_files > 0);
    assert.ok(structure.tests.test_declaration_call_sites > 0);
    assert.ok(structure.events.event_type_count > 0);
    assert.equal(structure.events.event_type_count, structure.events.event_types.length);
  });

  it("checks deterministic structure while ignoring diagnostic metadata and performance samples", async () => {
    const structure = await collectStructuralBaseline(root);
    const first = renderReport({ generated_at: "first", commit: "a", working_tree_dirty: false, platform: { os: "one", arch: "one", node: "one", pnpm: "one" } }, structure, samplePerformance());
    const second = renderReport({ generated_at: "second", commit: "b", working_tree_dirty: true, platform: { os: "two", arch: "two", node: "two", pnpm: "two" } }, structure, {
      ...samplePerformance(),
      measured_at: "later",
      metrics: [{ name: "sample", value: 9, unit: "ms", accepted_max: 10 }],
    });
    assert.equal(compareStructuralBaseline(first, structure).ok, true);
    assert.equal(compareStructuralBaseline(second, structure).ok, true);
  });

  it("fails check mode when deterministic structural values drift", async () => {
    const structure = await collectStructuralBaseline(root);
    const report = renderReport({ generated_at: "now", commit: "sha", working_tree_dirty: true, platform: { os: "macOS", arch: "arm64", node: "v24", pnpm: "11" } }, structure, samplePerformance());
    const changed = structuredClone(structure);
    changed.events.event_type_count += 1;
    assert.equal(compareStructuralBaseline(report, changed).ok, false);
  });
});
