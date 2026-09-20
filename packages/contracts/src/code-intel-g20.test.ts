import { describe, expect, it } from "vitest";
import {
  CodeIntelStaleBaseSchema,
  CodeIntelUpdatedDataSchema,
  EventTypeSchema,
  GitBaseContextSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
} from "./index.js";

const capturedAt = "2026-09-21T00:00:00.000Z";
const gitContext = {
  status: "available" as const,
  base_commit: "a".repeat(40),
  branch: "main",
  dirty: false,
  worktree_fingerprint: `sha256:${"b".repeat(64)}`,
  captured_at: capturedAt,
};

describe("G20 semantic CodeGraph contracts", () => {
  it("requires the bounded repository state needed to fence an approval", () => {
    expect(GitBaseContextSchema.parse(gitContext)).toMatchObject({ status: "available", branch: "main" });
    expect(() => GitBaseContextSchema.parse({
      status: "unavailable",
      base_commit: "a".repeat(40),
      captured_at: capturedAt,
    })).toThrow();
  });

  it("accepts only a self-consistent Git baseline drift explanation", () => {
    const expected = gitContext;
    const actualUnavailable = {
      status: "unavailable" as const,
      captured_at: capturedAt,
      reason: "not_git_repository",
    };
    const base = {
      expected,
      actual: { ...expected, base_commit: "c".repeat(40) },
      detected_at: capturedAt,
      reason: "base_commit_changed" as const,
      requires_reapproval: true as const,
    };

    expect(CodeIntelStaleBaseSchema.parse(base).reason).toBe("base_commit_changed");
    expect(CodeIntelStaleBaseSchema.parse({
      ...base,
      actual: { ...expected, branch: "release" },
      reason: "branch_changed",
    }).reason).toBe("branch_changed");
    expect(CodeIntelStaleBaseSchema.parse({
      ...base,
      actual: { ...expected, worktree_fingerprint: `sha256:${"d".repeat(64)}` },
      reason: "worktree_changed",
    }).reason).toBe("worktree_changed");
    expect(CodeIntelStaleBaseSchema.parse({
      ...base,
      actual: actualUnavailable,
      reason: "git_context_unavailable",
    }).reason).toBe("git_context_unavailable");
  });

  it("rejects stale-base facts whose reason does not match their Git contexts", () => {
    const base = {
      expected: gitContext,
      actual: { ...gitContext, base_commit: "c".repeat(40) },
      detected_at: capturedAt,
      reason: "base_commit_changed" as const,
      requires_reapproval: true as const,
    };
    const unavailable = {
      status: "unavailable" as const,
      captured_at: capturedAt,
      reason: "not_git_repository",
    };

    expect(() => CodeIntelStaleBaseSchema.parse({
      ...base,
      expected: unavailable,
    })).toThrow();
    expect(() => CodeIntelStaleBaseSchema.parse({
      ...base,
      reason: "git_context_unavailable",
    })).toThrow();
    expect(() => CodeIntelStaleBaseSchema.parse({
      ...base,
      actual: unavailable,
    })).toThrow();
    expect(() => CodeIntelStaleBaseSchema.parse({
      ...base,
      actual: { ...gitContext, worktree_fingerprint: `sha256:${"d".repeat(64)}` },
    })).toThrow();
    expect(() => CodeIntelStaleBaseSchema.parse({
      ...base,
      reason: "branch_changed",
    })).toThrow();
    expect(() => CodeIntelStaleBaseSchema.parse({
      ...base,
      reason: "worktree_changed",
    })).toThrow();
  });

  it("records static declaration symbols and containment edges without treating them as calls", () => {
    const symbol = GraphNodeSchema.parse({
      id: "symbol_parse_input",
      kind: "symbol",
      label: "parseInput",
      file_path: "src/parser.ts",
      line: 8,
      end_line: 14,
      symbol_name: "parseInput",
      declaration_kind: "function",
      content_hash: `sha256:${"c".repeat(64)}`,
    });
    expect(GraphEdgeSchema.parse({
      id: "contains_parser_parse_input",
      kind: "contains",
      source_node_id: "file_parser",
      target_node_id: symbol.id,
      file_path: "src/parser.ts",
      line: 8,
      confidence: "high",
      resolution: "resolved",
    }).kind).toBe("contains");
  });

  it("keeps baseline empty and requires both snapshots for post-patch semantic deltas", () => {
    const baseline = {
      project_id: "project:semantic",
      phase: "baseline" as const,
      git_context: gitContext,
      base_snapshot_id: "graph:before",
      changed_files: [],
      changed_files_truncated: false,
      changed_symbols: [],
      changed_symbols_truncated: false,
    };
    expect(CodeIntelUpdatedDataSchema.parse(baseline).phase).toBe("baseline");
    expect(() => CodeIntelUpdatedDataSchema.parse({ ...baseline, changed_files: ["src/parser.ts"] })).toThrow();
    expect(CodeIntelUpdatedDataSchema.parse({
      ...baseline,
      phase: "post_patch",
      result_snapshot_id: "graph:after",
      changed_files: ["src/parser.ts"],
      changed_symbols: [{
        symbol_id: "symbol_parse_input",
        name: "parseInput",
        kind: "function",
        file_path: "src/parser.ts",
        line: 8,
        change: "changed",
      }],
    }).changed_symbols).toHaveLength(1);
  });

  it("appends the two canonical semantic lifecycle facts", () => {
    expect(EventTypeSchema.options.slice(-2)).toEqual([
      "code.intel_updated",
      "code.stale_base_detected",
    ]);
  });
});
