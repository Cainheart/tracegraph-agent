import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationSchema, type ContextPolicy } from "@tracegraph/contracts";
import { DeterministicContextBuilder, readContextArtifact } from "@tracegraph/context";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../evidence/runtime-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Context package Core composition", () => {
  it("reconstructs the model-visible projection and refetches a spill through Core ArtifactStore", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-context-package-"));
    roots.push(root);
    let sequence = 0;
    const idFactory = (prefix: string) => `${prefix}:integration:${++sequence}`;
    const artifactStore = new ArtifactStore(join(root, "artifacts"), { idFactory });
    await artifactStore.initialize();
    const builder = new DeterministicContextBuilder({
      idFactory,
      now: () => new Date("2026-09-30T00:00:00.000Z"),
    });
    const policy: ContextPolicy = {
      window_tokens: 8_192,
      reserved_output_tokens: 1_024,
      warning_ratio: 0.7,
      compression_ratio: 0.8,
      recent_history_messages: 2,
      history_checkpoint_tokens: 256,
      tool_budget_ratio: 0.1,
      token_estimator: "heuristic_v2",
      compaction: {
        tool_output_pruner: { enabled: false, threshold_tokens: 1_000, target_tokens: 500 },
        spill: { enabled: true, threshold_tokens: 500, preview_tokens: 100 },
        model_summary: {
          enabled: false,
          threshold_tokens: 2_000,
          target_tokens: 500,
          timeout_ms: 1_000,
          prompt_version: "integration.v1",
        },
        tiered_checkpoint: { enabled: true, threshold_tokens: 2_000, target_tokens: 500 },
      },
    };
    const output = "verified artifact source line\n".repeat(2_000);
    const observation = ObservationSchema.parse({
      observation_id: "observation:context-integration",
      action_id: "action:context-integration",
      receipt_id: "receipt:context-integration",
      status: "success",
      summary: "A large tool output",
      facts: { output },
      artifact_refs: [],
      created_at: "2026-09-30T00:00:00.000Z",
    });
    const built = await builder.buildWithStrategies({
      projectId: "project:context-integration",
      runId: "run:context-integration",
      turnId: "turn:context-integration",
      modelCallId: "model-call:context-integration",
      task: "Verify Context package integration",
      workspaceKind: "managed_local",
      observations: [observation],
      contextPolicy: policy,
    }, { artifactStore });
    const includedItems = built.manifest.items
      .filter((item) => item.included_tokens > 0 && item.content !== undefined);

    expect(built.modelContext).toBe(
      includedItems.map((item) => `[${item.section}] ${item.content}`).join("\n\n"),
    );
    expect(built.manifest.compaction_steps?.map((step) => step.strategy_id)).toContain("spill");
    const spilled = built.manifest.items.find((item) => item.artifact_ref?.kind === "spilled_tool_output");
    expect(spilled?.artifact_ref).toBeDefined();
    const fetched = await readContextArtifact({
      locator: `artifact:${spilled!.artifact_ref!.artifact_id}`,
      projectId: "project:context-integration",
      runId: "run:context-integration",
      artifactStore,
    });
    expect(fetched.content).toContain("verified artifact source line");
    expect(fetched.artifact.content_hash).toBe(spilled!.artifact_ref!.content_hash);
    expect(built.modelContext).not.toContain(output);
  });
});
