import type { RawToolResult, ToolSideEffect } from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";

export interface NoProgressPolicy {
  readonly windowTurns: number;
  readonly minimumNoProgressTurns: number;
  readonly minimumRepeatedCallRatio: number;
}

export const DEFAULT_NO_PROGRESS_POLICY: NoProgressPolicy = Object.freeze({
  windowTurns: 4,
  minimumNoProgressTurns: 3,
  minimumRepeatedCallRatio: 0.5,
});

export interface ProgressFingerprint {
  readonly normalizedToolCalls: readonly string[];
  readonly workspaceDeltaHash?: string;
  readonly diagnosticsHash?: string;
  readonly goalStateHash?: string;
  readonly newEvidenceCount: number;
  readonly unresolvedErrorCodes: readonly string[];
}

export interface ProgressEvidenceInput {
  readonly normalizedToolCall: string;
  readonly toolName: string;
  readonly sideEffect: ToolSideEffect;
  readonly result: RawToolResult;
}

export interface NoProgressAssessment {
  readonly triggered: boolean;
  readonly recentTurns: number;
  readonly noProgressTurns: number;
  readonly repeatedCallCount: number;
  readonly totalCallCount: number;
  readonly repeatedCallRatio: number;
}

export function resolveNoProgressPolicy(
  policy: Partial<NoProgressPolicy> | undefined,
): NoProgressPolicy {
  const windowTurns = policy?.windowTurns ?? DEFAULT_NO_PROGRESS_POLICY.windowTurns;
  const resolved: NoProgressPolicy = {
    ...DEFAULT_NO_PROGRESS_POLICY,
    windowTurns,
    minimumNoProgressTurns: policy?.minimumNoProgressTurns
      ?? Math.min(DEFAULT_NO_PROGRESS_POLICY.minimumNoProgressTurns, windowTurns - 1),
    minimumRepeatedCallRatio: policy?.minimumRepeatedCallRatio
      ?? DEFAULT_NO_PROGRESS_POLICY.minimumRepeatedCallRatio,
  };
  if (!Number.isInteger(resolved.windowTurns) || resolved.windowTurns < 3 || resolved.windowTurns > 64) {
    throw new RangeError("noProgressPolicy.windowTurns must be an integer between 3 and 64");
  }
  if (
    !Number.isInteger(resolved.minimumNoProgressTurns)
    || resolved.minimumNoProgressTurns < 2
    || resolved.minimumNoProgressTurns >= resolved.windowTurns
  ) {
    throw new RangeError("noProgressPolicy.minimumNoProgressTurns must be an integer between 2 and windowTurns - 1");
  }
  if (
    !Number.isFinite(resolved.minimumRepeatedCallRatio)
    || resolved.minimumRepeatedCallRatio < 0.5
    || resolved.minimumRepeatedCallRatio > 1
  ) {
    throw new RangeError("noProgressPolicy.minimumRepeatedCallRatio must be between 0.5 and 1");
  }
  return Object.freeze(resolved);
}

/**
 * Produce a hash-only summary of one successful Tool turn. Evidence identity
 * includes the call and its normalized result, so a changed result from a
 * repeated call counts as progress while action/receipt IDs do not.
 */
export function buildProgressFingerprint(
  inputs: readonly ProgressEvidenceInput[],
  seenEvidence: Set<string>,
): ProgressFingerprint {
  const normalizedToolCalls = inputs.map(({ normalizedToolCall }) => normalizedToolCall).sort();
  let newEvidenceCount = 0;
  const workspaceDeltas: string[] = [];
  const diagnosticSnapshots: string[] = [];
  const goalStates: string[] = [];
  const unresolvedErrorCodes = new Set<string>();

  for (const input of inputs) {
    const normalizedResult = normalizeEvidenceValue({
      status: input.result.status,
      code: input.result.code,
      summary: input.result.summary,
      ...(input.result.content === undefined ? {} : { content: input.result.content }),
      ...(input.result.mimeType === undefined ? {} : { mimeType: input.result.mimeType }),
      ...(input.result.facts === undefined ? {} : { facts: input.result.facts }),
    });
    const evidenceSignature = sha256(stableStringify({
      tool_call: input.normalizedToolCall,
      result: normalizedResult,
    }));
    if (!seenEvidence.has(evidenceSignature)) {
      newEvidenceCount += 1;
      // Keep the set bounded even when a trusted Host configures a large turn
      // budget. The default Run budget remains much smaller than this ceiling.
      if (seenEvidence.size < 16_384) seenEvidence.add(evidenceSignature);
    }

    const facts = input.result.facts;
    if (input.result.status === "success" && input.sideEffect === "write") {
      const delta = facts === undefined ? undefined : firstPresent(facts, [
        "workspace_delta_hash",
        "workspace_delta",
        "patch_hash",
      ]);
      if (delta !== undefined) workspaceDeltas.push(sha256(stableStringify(normalizeEvidenceValue(delta))));
    }
    if (facts !== undefined && input.toolName === "get_diagnostics") {
      const diagnostics = firstPresent(facts, ["diagnostics_hash", "diagnostics"]);
      if (diagnostics !== undefined) diagnosticSnapshots.push(sha256(stableStringify(normalizeEvidenceValue(diagnostics))));
    }
    if (facts !== undefined && (input.toolName === "todo_read" || input.toolName === "todo_write")) {
      goalStates.push(sha256(stableStringify(normalizeEvidenceValue(facts))));
    }
    if (input.result.status !== "success") unresolvedErrorCodes.add(input.result.code);
    for (const code of errorCodesFromFacts(facts)) unresolvedErrorCodes.add(code);
  }

  return {
    normalizedToolCalls,
    ...(workspaceDeltas.length === 0 ? {} : { workspaceDeltaHash: sha256(stableStringify(workspaceDeltas.sort())) }),
    ...(diagnosticSnapshots.length === 0 ? {} : { diagnosticsHash: sha256(stableStringify(diagnosticSnapshots.sort())) }),
    ...(goalStates.length === 0 ? {} : { goalStateHash: sha256(stableStringify(goalStates.sort())) }),
    newEvidenceCount,
    unresolvedErrorCodes: [...unresolvedErrorCodes].sort(),
  };
}

export function assessNoProgress(
  history: readonly ProgressFingerprint[],
  current: ProgressFingerprint,
  policy: NoProgressPolicy,
): NoProgressAssessment {
  const recent = [...history, current].slice(-policy.windowTurns);
  const totalCallCount = recent.reduce((count, fingerprint) => count + fingerprint.normalizedToolCalls.length, 0);
  const uniqueCallCount = new Set(recent.flatMap(({ normalizedToolCalls }) => normalizedToolCalls)).size;
  const repeatedCallCount = Math.max(0, totalCallCount - uniqueCallCount);
  const repeatedCallRatio = totalCallCount === 0 ? 0 : repeatedCallCount / totalCallCount;

  let noProgressTurns = 0;
  for (let index = recent.length - 1; index > 0; index -= 1) {
    if (!isNoProgressTransition(recent[index - 1]!, recent[index]!)) break;
    noProgressTurns += 1;
  }

  return {
    triggered: recent.length === policy.windowTurns
      && noProgressTurns >= policy.minimumNoProgressTurns
      && repeatedCallRatio >= policy.minimumRepeatedCallRatio,
    recentTurns: recent.length,
    noProgressTurns,
    repeatedCallCount,
    totalCallCount,
    repeatedCallRatio,
  };
}

function isNoProgressTransition(previous: ProgressFingerprint, current: ProgressFingerprint): boolean {
  return current.newEvidenceCount === 0
    && previous.workspaceDeltaHash === current.workspaceDeltaHash
    && previous.diagnosticsHash === current.diagnosticsHash
    && previous.goalStateHash === current.goalStateHash;
}

function firstPresent(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function errorCodesFromFacts(facts: Record<string, unknown> | undefined): string[] {
  if (facts === undefined) return [];
  const value = facts.unresolved_error_codes;
  if (!Array.isArray(value)) return [];
  return value.filter((code): code is string => typeof code === "string" && code.length > 0 && code.length <= 160);
}

function normalizeEvidenceValue(value: unknown, key?: string): unknown {
  if (key !== undefined && VOLATILE_EVIDENCE_KEYS.has(key.toLocaleLowerCase("en-US"))) return undefined;
  if (Array.isArray(value)) return value.map((item) => normalizeEvidenceValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => !childKey.startsWith("_internal_"))
      .map(([childKey, childValue]) => [childKey, normalizeEvidenceValue(childValue, childKey)])
      .filter(([, childValue]) => childValue !== undefined));
  }
  return value;
}

const VOLATILE_EVIDENCE_KEYS = new Set([
  "action_id",
  "artifact_id",
  "completed_at",
  "created_at",
  "event_id",
  "event_ids",
  "idempotency_key",
  "observation_id",
  "occurred_at",
  "receipt_id",
  "started_at",
]);
