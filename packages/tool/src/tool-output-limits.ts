/**
 * One auditable source of truth for built-in Tool output limits.
 *
 * `sectionBytes` bounds the three model-visible `RawToolResult` sections while
 * `maxResultBytes` is the final serialized envelope ceiling.  G-02 imports the
 * shared compaction threshold below, so Tool rendering and Context spill do
 * not drift into unrelated policies.
 *
 * This module deliberately has no package imports.  Context construction can
 * consume it without depending on ToolRegistry or creating an import cycle.
 */
export type BuiltinToolName =
  | "read_file"
  | "list_dir"
  | "search"
  | "read_artifact"
  | "list_artifacts"
  | "preview_patch"
  | "commit_patch"
  | "run_test"
  | "todo_read"
  | "todo_write"
  | "spawn_subagent"
  | "send_subagent_message"
  | "list_subagents"
  | "interrupt_subagent"
  | "team_read"
  | "team_task_write"
  | "team_mailbox_send"
  | "team_mailbox_claim"
  | "team_heartbeat"
  | "load_skill";

export interface ToolOutputLimit {
  readonly maxResultBytes: number;
  readonly compactionThresholdTokens: number;
  readonly sectionBytes: {
    readonly summary: number;
    readonly content: number;
    readonly facts: number;
  };
}

export const DEFAULT_TOOL_OUTPUT_COMPACTION_THRESHOLD_TOKENS = 12_000;
export const TODO_READ_MODEL_EXCERPT_BYTES = 4_000;
export const TEAM_READ_MODEL_EXCERPT_BYTES = 4_000;

export const TOOL_OUTPUT_LIMITS: Readonly<Record<BuiltinToolName, ToolOutputLimit>> = Object.freeze({
  read_file: toolLimit(160 * 1024, 2_000, 64 * 1024, 92 * 1024),
  list_dir: toolLimit(96 * 1024, 2_000, 40 * 1024, 52 * 1024),
  search: toolLimit(128 * 1024, 2_000, 56 * 1024, 68 * 1024),
  read_artifact: toolLimit(16 * 1024, 2_000, 4_000, 8 * 1024),
  list_artifacts: toolLimit(96 * 1024, 2_000, 44 * 1024, 48 * 1024),
  preview_patch: toolLimit(128 * 1024, 2_000, 44 * 1024, 80 * 1024),
  commit_patch: toolLimit(96 * 1024, 2_000, 44 * 1024, 48 * 1024),
  run_test: toolLimit(96 * 1024, 2_000, 64 * 1024, 28 * 1024),
  // One contract-valid Todo can contain 128 dependencies, 256 evidence ids,
  // a 4K detail, and JSON-escaped 160-character identifiers. Keep a bounded
  // ceiling that can still carry that worst-case item as a one-item page.
  todo_read: toolLimit(640 * 1024, 2_000, 512 * 1024, 8 * 1024),
  todo_write: toolLimit(32 * 1024, 2_000, 24 * 1024, 4 * 1024),
  spawn_subagent: toolLimit(128 * 1024, 2_000, 72 * 1024, 48 * 1024),
  send_subagent_message: toolLimit(32 * 1024, 2_000, 20 * 1024, 8 * 1024),
  list_subagents: toolLimit(128 * 1024, 2_000, 72 * 1024, 48 * 1024),
  interrupt_subagent: toolLimit(32 * 1024, 2_000, 20 * 1024, 8 * 1024),
  // Team task fields have the same worst-case JSON escaping pressure as Todo
  // fields. Dynamic item paging guarantees the full page stays below this
  // ceiling while retaining one maximum-size contract-valid task.
  team_read: toolLimit(640 * 1024, 2_000, 512 * 1024, 8 * 1024),
  // Mutations expose only one compact receipt plus projection counts. The
  // complete Team remains available through the paged read Tool and Host API.
  team_task_write: toolLimit(32 * 1024, 2_000, 24 * 1024, 4 * 1024),
  team_mailbox_send: toolLimit(32 * 1024, 2_000, 24 * 1024, 4 * 1024),
  team_mailbox_claim: toolLimit(32 * 1024, 2_000, 24 * 1024, 4 * 1024),
  team_heartbeat: toolLimit(32 * 1024, 2_000, 24 * 1024, 4 * 1024),
  // Skill bodies are trusted local instructions, but remain model-visible
  // tool output and therefore use the same bounded receipt/spill boundary.
  load_skill: toolLimit(160 * 1024, 2_000, 128 * 1024, 8 * 1024),
});

function toolLimit(
  maxResultBytes: number,
  summary: number,
  content: number,
  facts: number,
): ToolOutputLimit {
  return Object.freeze({
    maxResultBytes,
    compactionThresholdTokens: DEFAULT_TOOL_OUTPUT_COMPACTION_THRESHOLD_TOKENS,
    sectionBytes: Object.freeze({ summary, content, facts }),
  });
}
