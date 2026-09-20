import { describe, expect, it } from "vitest";

import { retrieveMemoryFixture } from "../../packages/core/src/memory.js";

const FIXED_NOW = new Date("2026-09-19T02:00:00.000Z");
const PROJECT_ID = "project:tracegraph";
const RUN_ID = "run:g16-memory-quality";

interface VerificationTask {
  readonly expectedCommand: string;
  readonly expectedEditRoot: string;
  readonly expectedSourceId: string;
}

interface ScriptedTaskResult {
  readonly command: string;
  readonly editRoots: readonly string[];
  readonly citedSourceIds: readonly string[];
  readonly selectedMemoryIds: readonly string[];
  readonly requiresNetwork: boolean;
}

const QUALITY_DIMENSIONS = [
  "command_accuracy",
  "minimal_edit_scope",
  "source_grounding",
  "offline_boundary",
] as const;

type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

interface QualityScore {
  readonly dimensions: Readonly<Record<QualityDimension, 0 | 1>>;
  readonly total: number;
}

interface StoredPlaybook {
  readonly kind: "verification_playbook";
  readonly command: string;
  readonly edit_root: string;
  readonly source_id: string;
}

function isStoredPlaybook(value: unknown): value is StoredPlaybook {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === "verification_playbook"
    && typeof record.command === "string"
    && typeof record.edit_root === "string"
    && typeof record.source_id === "string";
}

function runScriptedVerificationTask(
  retrieval: ReturnType<typeof retrieveMemoryFixture>,
): ScriptedTaskResult {
  for (const record of retrieval.records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.content);
    } catch {
      continue;
    }
    if (!isStoredPlaybook(parsed)) {
      continue;
    }
    const sourceIsAttached = record.source_refs.some(
      ({ source_id: sourceId }) => sourceId === parsed.source_id,
    );
    if (!sourceIsAttached) {
      continue;
    }
    return {
      command: parsed.command,
      editRoots: [parsed.edit_root],
      citedSourceIds: [parsed.source_id],
      selectedMemoryIds: [record.memory_id],
      requiresNetwork: false,
    };
  }

  // This deterministic fallback models the information available without a
  // scoped memory. It deliberately stays offline, but cannot infer this
  // monorepo's package command or the narrow edit boundary.
  return {
    command: "npm test",
    editRoots: ["."],
    citedSourceIds: [],
    selectedMemoryIds: [],
    requiresNetwork: false,
  };
}

function scoreVerificationTask(
  task: VerificationTask,
  result: ScriptedTaskResult,
): QualityScore {
  const dimensions: QualityScore["dimensions"] = {
    command_accuracy: Number(result.command === task.expectedCommand) as 0 | 1,
    minimal_edit_scope: Number(
      result.editRoots.length === 1 && result.editRoots[0] === task.expectedEditRoot,
    ) as 0 | 1,
    source_grounding: Number(
      result.citedSourceIds.length === 1
        && result.citedSourceIds[0] === task.expectedSourceId
        && result.selectedMemoryIds.length === 1,
    ) as 0 | 1,
    offline_boundary: Number(!result.requiresNetwork) as 0 | 1,
  };
  const total = QUALITY_DIMENSIONS.reduce(
    (sum, dimension) => sum + dimensions[dimension],
    0,
  ) / QUALITY_DIMENSIONS.length;
  return { dimensions, total };
}

describe("G16 quality comparison: scoped Memory fixture", () => {
  it("improves command, scope, and grounding for the same offline task", () => {
    // This eval measures the existing deterministic fixture seam only. It does
    // not claim that Runtime already persists, retrieves, or injects Memory.
    const task: VerificationTask = {
      expectedCommand: "pnpm --filter @tracegraph/cli test:e2e",
      expectedEditRoot: "apps/cli",
      expectedSourceId: "repository:cli-module-doc",
    };
    const baseRecord = {
      content: JSON.stringify({
        kind: "verification_playbook",
        command: task.expectedCommand,
        edit_root: task.expectedEditRoot,
        source_id: task.expectedSourceId,
      } satisfies StoredPlaybook),
      origin: "fixture" as const,
      trust: "trusted" as const,
      version: 1,
      status: "confirmed" as const,
      source_refs: [{
        source_id: task.expectedSourceId,
        source_type: "repository" as const,
        trust: "trusted" as const,
        description: "docs/modules/11-CLI-与装配.md",
      }],
      created_at: "2026-09-19T01:00:00.000Z",
      supersedes: [],
    };

    const withoutMemory = retrieveMemoryFixture({
      records: [],
      projectId: PROJECT_ID,
      runId: RUN_ID,
      query: "verify the CLI change with the repository command",
      now: FIXED_NOW,
      idFactory: () => "memory-retrieval:without",
    });
    const withMemory = retrieveMemoryFixture({
      records: [
        {
          ...baseRecord,
          memory_id: "memory:cli-playbook",
          scope: { kind: "project" as const, project_id: PROJECT_ID },
        },
        {
          ...baseRecord,
          memory_id: "memory:other-project",
          scope: { kind: "project" as const, project_id: "project:other" },
          content: JSON.stringify({
            kind: "verification_playbook",
            command: "curl https://example.invalid/check",
            edit_root: ".",
            source_id: task.expectedSourceId,
          } satisfies StoredPlaybook),
        },
      ],
      projectId: PROJECT_ID,
      runId: RUN_ID,
      query: "verify the CLI change with the repository command",
      now: FIXED_NOW,
      idFactory: () => "memory-retrieval:with",
    });

    const baseline = scoreVerificationTask(
      task,
      runScriptedVerificationTask(withoutMemory),
    );
    const augmented = scoreVerificationTask(
      task,
      runScriptedVerificationTask(withMemory),
    );

    expect(withMemory.receipt).toMatchObject({
      retrieved_memory_ids: ["memory:cli-playbook"],
      blocked_memory_ids: ["memory:other-project"],
      reasons: { "memory:other-project": "cross_project_scope" },
    });
    expect(baseline).toEqual({
      dimensions: {
        command_accuracy: 0,
        minimal_edit_scope: 0,
        source_grounding: 0,
        offline_boundary: 1,
      },
      total: 0.25,
    });
    expect(augmented).toEqual({
      dimensions: {
        command_accuracy: 1,
        minimal_edit_scope: 1,
        source_grounding: 1,
        offline_boundary: 1,
      },
      total: 1,
    });
    expect(augmented.total - baseline.total).toBeGreaterThanOrEqual(0.5);
  });
});
