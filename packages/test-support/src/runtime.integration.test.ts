import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ContextManifestSchema,
  type ContextManifest,
  type ContextPolicy,
} from "@tracegraph/contracts";
import {
  ActionWal,
  ToolRegistry,
  JsonlSessionStore,
  createAgentRuntime as createAgentRuntimeWithNativeSandbox,
  createDefaultToolRegistry,
  createFixtureSandboxRunner,
  registerSecretForRedaction,
  sha256,
  type AgentRuntime,
  type CodeGraphProvider,
  type ModelAdapter,
  type ToolDefinition,
} from "@tracegraph/core";
import {
  createFailingTypescriptFixture,
  createSequentialIdFactory,
  createTemporaryDataDir,
} from "./index.js";

/**
 * run_test fails closed unless the host proves full OS isolation, which Linux
 * (unlike macOS seatbelt) never does. These suites cover approval, WAL and
 * crash recovery semantics rather than isolation, so every Runtime they build
 * gets a fixture sandbox boundary -- see createFixtureSandboxRunner.
 */
const createAgentRuntime: typeof createAgentRuntimeWithNativeSandbox = (options) =>
  createAgentRuntimeWithNativeSandbox({
    ...options,
    sandboxRunner: createFixtureSandboxRunner(),
  });

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("P0 Agent runtime", () => {
  it("never persists an exact registered credential during a complete Run", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const secret = "opaque-registered-credential-987654";
    registerSecretForRedaction(secret);
    const model: ModelAdapter = {
      name: "credential-redaction-model",
      async decide() {
        return {
          decision_id: "decision:credential-redaction",
          kind: "finish",
          public_reason: "Handled the registered credential without exposing it.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Completed without exposing the credential.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun({
      ...startInput(fixture.handle),
      task: `Inspect credential ${secret} safely`,
      mode: "execute",
    });
    const result = await waitForTerminal(runtime, started.run_id);
    const persisted = await readTreeText(data.path);

    expect(result.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED_REGISTERED_SECRET]");
  });

  it("keeps a long final answer while bounding the terminal event summary", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const longAnswer = `# Architecture\n\n${"A detailed Mermaid-ready explanation. ".repeat(120)}`;
    const model: ModelAdapter = {
      name: "long-answer-model",
      async decide() {
        return {
          decision_id: "decision:long-answer",
          kind: "finish",
          public_reason: "The requested architecture explanation is ready.",
          evidence_refs: [],
          risk: "none",
          final_answer: longAnswer,
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForTerminal(runtime, started.run_id);
    const terminal = result.timeline.find((event) => event.type === "run.completed");

    expect(result.status).toBe("completed");
    expect(result.outcome).toBe(longAnswer);
    expect(terminal?.summary).toBe("Run completed");
    expect(terminal?.summary.length).toBeLessThanOrEqual(2_000);
  });

  it("streams public model/tool progress with reasoning metadata but no hidden chain", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const receivedEfforts: string[] = [];
    const model: ModelAdapter = {
      name: "observable-model",
      publicRequestMetadata(input) {
        return {
          adapter: "observable-model",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          requested_reasoning_effort: input.reasoningEffort,
          applied_reasoning_effort: "high",
          reasoning_configuration: "mapped",
        };
      },
      async decide(input) {
        receivedEfforts.push(input.reasoningEffort);
        if (input.observations.length === 0) {
          return {
            decision_id: "decision:public-read",
            kind: "tool_call",
            public_reason: "Read the implementation file before answering.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "The file contents will ground the answer.",
            tool_call: {
              action_id: "action:public-read",
              tool_name: "read_file",
              arguments: { path: "src/add.ts" },
            },
          };
        }
        return {
          decision_id: "decision:public-finish",
          kind: "finish",
          public_reason: "The requested file was inspected.",
          evidence_refs: [],
          risk: "none",
          final_answer: "The file defines the current implementation.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });
    const started = await runtime.startRun({
      ...startInput(fixture.handle),
      reasoning_effort: "xhigh",
    });
    const result = await waitForStatus(runtime, started.run_id, "completed");
    const types = result.timeline.map((event) => event.type);
    const request = result.timeline.find((event) => event.type === "model.request_started");
    const read = result.timeline.find((event) => event.type === "tool.started");

    expect(result.reasoning_effort).toBe("xhigh");
    expect(receivedEfforts).toEqual(["xhigh", "xhigh"]);
    expect(types.indexOf("model.request_started")).toBeLessThan(types.indexOf("model.decision"));
    expect(types.indexOf("model.decision")).toBeLessThan(types.indexOf("tool.started"));
    expect(request?.data).toMatchObject({
      provider: "deepseek",
      requested_reasoning_effort: "xhigh",
      applied_reasoning_effort: "high",
      reasoning_configuration: "mapped",
    });
    expect(read).toMatchObject({
      summary: "Reading src/add.ts",
      data: { tool_name: "read_file", activity: "read", path: "src/add.ts" },
    });
    expect(JSON.stringify(result)).not.toContain("reasoning_content");
  });

  it("publishes a volatile public-process feed without persisting provider reasoning", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const model: ModelAdapter = {
      name: "live-activity-model",
      async decide(input) {
        if (input.observations.length === 0) {
          return {
            decision_id: "decision:live-activity-search",
            kind: "tool_call",
            public_reason: "Collect one bounded observation for the activity feed.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "The feed will include a completed read-only Tool call.",
            tool_call: {
              action_id: "action:live-activity-search",
              tool_name: "search",
              arguments: { pattern: "return left - right;" },
            },
          };
        }
        return {
          decision_id: "decision:live-activity-finish",
          kind: "finish",
          public_reason: "The bounded observation is sufficient.",
          evidence_refs: [],
          risk: "none",
          final_answer: "The activity feed was exercised.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });
    const started = await runtime.startRun({
      ...startInput(fixture.handle),
      mode: "execute",
    });
    const result = await waitForTerminal(runtime, started.run_id);

    const buffered = runtime.listLiveActivities(started.run_id);
    const sourceTypes = buffered.map((activity) => activity.source_event_type);
    expect(sourceTypes).toEqual(expect.arrayContaining([
      "context.built",
      "model.request_started",
      "model.decision",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]));
    expect(buffered.every((activity) => !("data" in activity))).toBe(true);
    expect(buffered.every((activity) => activity.summary.length <= 800)).toBe(true);
    expect(JSON.stringify(buffered)).not.toContain("reasoning_content");
    expect(JSON.stringify(buffered)).not.toContain("final_answer");
    expect(JSON.stringify(result)).not.toContain('"live:');
  });

  it("publishes replayable public model-surface snapshots without turning them into ledger events", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let beginDecision!: () => void;
    const decisionStarted = new Promise<void>((resolve) => { beginDecision = resolve; });
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => { releaseDecision = resolve; });
    const model: ModelAdapter = {
      name: "real-public-stream-model",
      async decide(input) {
        beginDecision();
        await decisionGate;
        input.onPublicProgress?.({ kind: "public_reason_delta", text: "I will read the project documentation first. " });
        input.onPublicProgress?.({ kind: "public_reason_delta", text: "The evidence is sufficient for a direct answer." });
        input.onPublicProgress?.({ kind: "final_answer_delta", text: "A streamed public answer preview." });
        return {
          decision_id: "decision:model-surface",
          kind: "finish",
          public_reason: "I will read the project documentation first. The evidence is sufficient for a direct answer.",
          evidence_refs: [],
          risk: "none",
          final_answer: "A streamed public answer preview.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });
    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    await decisionStarted;
    const received: Array<{ cursor: number; status: string; text: string }> = [];
    const unsubscribe = runtime.subscribeModelSurface(started.run_id, (event) => {
      received.push({ cursor: event.cursor, status: event.status, text: event.text });
    });

    releaseDecision();
    const terminal = await waitForTerminal(runtime, started.run_id);
    unsubscribe();
    const surface = runtime.listModelSurface(started.run_id);

    expect(terminal.status).toBe("completed");
    expect(surface).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "public_plan_snapshot",
        status: "completed",
        text: "I will read the project documentation first. The evidence is sufficient for a direct answer.",
      }),
      expect.objectContaining({
        type: "answer_snapshot",
        status: "completed",
        text: "A streamed public answer preview.",
      }),
    ]));
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed", text: "A streamed public answer preview." }),
    ]));
    expect(surface.map((event) => event.cursor)).toEqual([...surface.map((event) => event.cursor)].sort((left, right) => left - right));
    expect(runtime.listModelSurface(started.run_id, surface[0]!.cursor).every((event) => event.cursor > surface[0]!.cursor)).toBe(true);
    // The final answer remains part of the canonical Run outcome, but the
    // volatile stream frame/cursor itself is not a second durable ledger.
    const replay = JSON.stringify(await runtime.replay(started.run_id));
    expect(replay).toContain("A streamed public answer preview.");
    expect(replay).not.toContain("public_plan_snapshot");
    expect(replay).not.toContain("surface_event_id");
  });

  it("emits compaction events when only bounded tool evidence changes the Context", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    registry.register({
      ...search,
      async execute() {
        return {
          status: "success",
          code: "oversized_search_result",
          summary: "Search returned bounded evidence",
          facts: { output: "上下文工具结果".repeat(200) },
        };
      },
    } as ToolDefinition);
    let requests = 0;
    const model: ModelAdapter = {
      name: "tool-only-compaction-model",
      async decide() {
        requests += 1;
        if (requests === 1) {
          return {
            decision_id: "decision:tool-only-search",
            kind: "tool_call",
            public_reason: "Inspect a small amount of repository evidence first.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "A bounded result can inform the final response.",
            tool_call: {
              action_id: "action:tool-only-search",
              tool_name: "search",
              arguments: { pattern: "context" },
            },
          };
        }
        return {
          decision_id: "decision:tool-only-finish",
          kind: "finish",
          public_reason: "The bounded result has been inspected.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Done.",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      toolRegistry: registry,
      contextPolicy: {
        window_tokens: 1_024,
        reserved_output_tokens: 256,
        warning_ratio: 0.7,
        compression_ratio: 0.8,
        recent_history_messages: 16,
        history_checkpoint_tokens: 160,
        tool_budget_ratio: 0.1,
        token_estimator: "heuristic_v2",
        compaction: {
          tool_output_pruner: {
            enabled: true,
            threshold_tokens: 512,
            target_tokens: 256,
          },
          spill: {
            enabled: false,
            threshold_tokens: 512,
            preview_tokens: 64,
          },
          model_summary: {
            enabled: false,
            threshold_tokens: 512,
            target_tokens: 128,
            timeout_ms: 500,
            prompt_version: "tracegraph.context-summary.integration.v1",
          },
          tiered_checkpoint: {
            enabled: true,
            threshold_tokens: 512,
            target_tokens: 160,
          },
        },
      },
    });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "completed");
    const compactionStarted = result.timeline.find((event) => event.type === "context.compaction_started");
    const compactionCompleted = result.timeline.find((event) => event.type === "context.compaction_completed");
    const compactedContext = result.timeline
      .filter((event) => event.type === "context.built")
      .find((event) => {
        const compression = event.data.compression as { applied_strategy?: string } | undefined;
        return compression?.applied_strategy === "strategy_chain";
      });

    expect(result.status).toBe("completed");
    expect(compactionStarted?.data).toMatchObject({
      trigger: "hard_budget",
      strategies: ["tool_output_pruner", "tiered_checkpoint"],
    });
    expect(compactionCompleted?.data).toMatchObject({
      strategy: "none",
      applied_strategy: "strategy_chain",
      trigger: "hard_budget",
      steps: [expect.objectContaining({ strategy_id: "tool_output_pruner", section: "tool" })],
    });
    expect(compactedContext?.data.compression).toMatchObject({
      strategy: "none",
      applied_strategy: "strategy_chain",
    });
  });

  it("summarizes a 258K-plus history through the model and accounts for every compaction token", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const sourceMarker = "G02_LONG_HISTORY_SOURCE_ONLY";
    const conversationHistory = Array.from({ length: 160 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      // 160 * 2,100 conservative CJK tokens is safely above the 258K
      // product window while remaining below the Artifact wire-size ceiling.
      content: `${sourceMarker}:${index}:${"界".repeat(2_100)}`,
    }));
    let summaryCalls = 0;
    let runtime: Awaited<ReturnType<typeof createAgentRuntime>>;
    const model: ModelAdapter = {
      name: "g02-large-history-summary-model",
      async summarizeContext(input) {
        summaryCalls += 1;
        const duringSummary = await runtime.getProjection(input.runId);
        expect(duringSummary.timeline.some((event) => event.type === "context.compaction_started"))
          .toBe(true);
        expect(input.sourceText).toContain(`${sourceMarker}:0:`);
        expect(input.promptVersion).toBe("tracegraph.context-summary.integration.v1");
        input.onUsage?.({
          provider: "integration-provider",
          model: "integration-summary-model",
          input_tokens: 300_000,
          output_tokens: 64,
          total_tokens: 300_064,
          request_kind: "summary",
          request_sequence: 1,
          provider_reported_cost: { amount: 0.0042, currency: "USD" },
        });
        return {
          facts: ["The earlier discussion established the repository constraints."],
          open_questions: ["Confirm the final implementation choice."],
          refs: [{ path: "src/add.ts", lines: { start: 1, end: 3 } }],
        };
      },
      async decide() {
        return {
          decision_id: "decision:g02-large-history-finish",
          kind: "finish",
          public_reason: "The compacted history is sufficient to answer.",
          evidence_refs: [],
          risk: "none",
          final_answer: "The long conversation was summarized within the Context budget.",
        };
      },
    };
    runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      contextPolicy: g02ContextPolicy({
        windowTokens: 258_000,
        reservedOutputTokens: 32_000,
        summaryTimeoutMs: 1_000,
      }),
    });

    const started = await runtime.startRun({
      ...startInput(fixture.handle),
      mode: "execute",
      conversation_history: conversationHistory,
    });
    const result = await waitForStatus(runtime, started.run_id, "completed", 15_000);
    const contextBuilt = result.timeline.find((event) => event.type === "context.built");
    expect(contextBuilt).toBeDefined();
    const manifest = await contextManifestFor(runtime, result, contextBuilt!);
    const steps = manifest.compaction_steps ?? [];
    const compression = manifest.compression!;
    const explainedReduction = steps.reduce(
      (total, step) => total + step.tokens_before - step.tokens_after,
      0,
    );

    expect(result.status).toBe("completed");
    expect(summaryCalls).toBe(1);
    expect(compression.before_tokens).toBeGreaterThan(258_000);
    expect(manifest.input_tokens).toBeLessThanOrEqual(
      manifest.token_limit - manifest.reserved_output_tokens,
    );
    expect(steps.map((step) => step.strategy_id)).toContain("model_summary");
    expect(steps.every((step, index) => (
      index === 0 || steps[index - 1]!.tokens_after === step.tokens_before
    ))).toBe(true);
    expect(explainedReduction).toBe(compression.before_tokens - compression.after_tokens);
    const summaryCreated = result.timeline.find((event) => event.type === "context.summary_created");
    const summaryUsage = result.timeline.find((event) => (
      event.type === "model.usage_reported" && event.data.request_kind === "summary"
    ));
    expect(summaryCreated).toBeDefined();
    expect(result.timeline.findIndex((event) => event.type === "context.compaction_started"))
      .toBeLessThan(result.timeline.findIndex((event) => event.type === "context.summary_created"));
    expect(summaryUsage).toMatchObject({
      model_call_id: summaryCreated?.data.summary_model_call_id,
      data: {
        request_kind: "summary",
        provider: "integration-provider",
        model: "integration-summary-model",
        cost_status: "provider_reported",
      },
    });
    expect(JSON.stringify(result.timeline)).not.toContain(`${sourceMarker}:0:`);
    expect(await readTreeText(join(data.path, "events"))).not.toContain(`${sourceMarker}:0:`);
  }, 20_000);

  it("falls back to a tiered checkpoint when model summary output is invalid", async () => {
    const result = await runSummaryFallbackCase(async () => "{not-valid-json");

    expect(result.projection.status).toBe("completed");
    expect(result.failure?.data).toMatchObject({
      reason: "invalid_summary",
      fallback: "tiered_checkpoint",
    });
    expect(result.manifest.compaction_steps?.map((step) => step.strategy_id))
      .toContain("tiered_checkpoint");
  });

  it("falls back to a tiered checkpoint when model summary times out", async () => {
    const result = await runSummaryFallbackCase(async (input) => new Promise<never>((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
    }), 100);

    expect(result.projection.status).toBe("completed");
    expect(result.failure?.data).toMatchObject({
      reason: "timeout",
      fallback: "tiered_checkpoint",
    });
    expect(result.manifest.compaction_steps?.map((step) => step.strategy_id))
      .toContain("tiered_checkpoint");
  });

  it("closes a started unavailable-summary attempt with completed none when no strict reduction exists", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const model: ModelAdapter = {
      name: "g02-unavailable-summary-model",
      async decide() {
        return {
          decision_id: "decision:g02-unavailable-summary-finish",
          kind: "finish",
          public_reason: "No lossy replacement was needed.",
          evidence_refs: [],
          risk: "none",
          final_answer: "The original short history remained visible.",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      contextPolicy: {
        window_tokens: 1_024,
        reserved_output_tokens: 256,
        warning_ratio: 0.5,
        compression_ratio: 0.55,
        recent_history_messages: 1,
        history_checkpoint_tokens: 128,
        tool_budget_ratio: 0.1,
        token_estimator: "heuristic_v2",
        compaction: {
          tool_output_pruner: { enabled: false, threshold_tokens: 512, target_tokens: 128 },
          spill: { enabled: false, threshold_tokens: 512, preview_tokens: 64 },
          model_summary: {
            enabled: true,
            threshold_tokens: 1_000,
            target_tokens: 128,
            timeout_ms: 500,
            prompt_version: "tracegraph.context-summary.integration.v1",
          },
          tiered_checkpoint: { enabled: true, threshold_tokens: 1_000, target_tokens: 128 },
        },
      },
    });
    const started = await runtime.startRun({
      ...startInput(fixture.handle),
      task: "压".repeat(420),
      mode: "execute",
      conversation_history: [
        { role: "user", content: "old" },
        { role: "assistant", content: "recent" },
      ],
    });
    const result = await waitForStatus(runtime, started.run_id, "completed");
    const startedIndex = result.timeline.findIndex((event) => event.type === "context.compaction_started");
    const failedIndex = result.timeline.findIndex((event) => event.type === "context.summary_failed");
    const completedIndex = result.timeline.findIndex((event) => event.type === "context.compaction_completed");
    const completed = result.timeline[completedIndex];

    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(startedIndex);
    expect(completedIndex).toBeGreaterThan(failedIndex);
    expect(completed?.data).toMatchObject({ applied_strategy: "none", steps: [] });
    expect(result.timeline.flatMap((event) => event.artifact_refs)
      .some((artifact) => artifact.kind === "context_source_archive")).toBe(false);
  });

  it("spills an oversized tool observation and lets the model refetch it by opaque locator", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const rawMarker = "G02_SPILLED_RAW_OUTPUT_NEVER_IN_LEDGER";
    const oversizedOutput = `${"工具原文行\n".repeat(800)}tail:${rawMarker}`;
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    registry.register({
      ...search,
      async execute() {
        return {
          status: "success",
          code: "oversized_observation",
          summary: "Search produced an oversized observation",
          content: oversizedOutput,
          mimeType: "text/plain",
          // Runtime bounds the durable Observation fact, while the exact tool
          // output is stored only as an Artifact and is the source spill must
          // archive/refetch.
          facts: { output: "超大工具观察字段".repeat(1_000) },
        };
      },
    } as ToolDefinition);
    let requestNumber = 0;
    let locator: string | undefined;
    let refetchedHash: string | undefined;
    let tailSeen = false;
    let readCalls = 0;
    const model: ModelAdapter = {
      name: "g02-spill-refetch-model",
      async decide(input) {
        requestNumber += 1;
        if (requestNumber === 1) {
          return {
            decision_id: "decision:g02-spill-search",
            kind: "tool_call",
            public_reason: "Produce the large observation that must be externalized.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "The next Context should contain an opaque Artifact locator.",
            tool_call: {
              action_id: "action:g02-spill-search",
              tool_name: "search",
              arguments: { pattern: "context" },
            },
          };
        }
        const readObservations = input.observations.filter(
          (observation) => observation.facts.code === "artifact_read",
        );
        const latestRead = readObservations.at(-1);
        if (latestRead !== undefined) {
          refetchedHash = typeof latestRead.facts.content_hash === "string"
            ? latestRead.facts.content_hash
            : undefined;
          const excerpt = typeof latestRead.facts.content_excerpt === "string"
            ? latestRead.facts.content_excerpt
            : "";
          if (excerpt.includes(rawMarker)) {
            tailSeen = true;
            return {
              decision_id: "decision:g02-spill-finish",
              kind: "finish",
              public_reason: "The archived source tail was retrieved and verified.",
              evidence_refs: [],
              risk: "none",
              final_answer: "The externalized tool output was read successfully through bounded pages.",
            };
          }
          expect(latestRead.facts.truncated).toBe(true);
          expect(typeof latestRead.facts.next_offset).toBe("number");
        } else {
          locator = input.context.match(/artifact:artifact:[A-Za-z0-9_.:-]+/u)?.[0];
          expect(locator).toBeDefined();
        }
        const offset = latestRead === undefined ? 0 : Number(latestRead.facts.next_offset);
        readCalls += 1;
        return {
          decision_id: `decision:g02-spill-refetch:${readCalls}`,
          kind: "tool_call",
          public_reason: "Retrieve the next bounded page of the archived source.",
          evidence_refs: [],
          risk: "low",
          expected_effect: "The next UTF-8-safe Artifact page will be available to the next turn.",
          tool_call: {
            action_id: `action:g02-spill-refetch:${readCalls}`,
            tool_name: "read_artifact",
            arguments: { locator, offset, limit: 4_000 },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      toolRegistry: registry,
      contextPolicy: g02ContextPolicy({
        windowTokens: 8_192,
        reservedOutputTokens: 1_024,
        spillEnabled: true,
        summaryEnabled: false,
      }),
    });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "completed");
    const spillEvents = result.timeline.filter((event) => event.type === "context.tool_output_spilled");
    const spill = spillEvents.find((event) => event.data.locator === locator) ?? spillEvents[0];
    const spillRef = spill?.artifact_refs.find((artifact) => artifact.kind === "spilled_tool_output");
    const refetches = result.timeline.filter((event) => (
      event.type === "context.spill_refetched" && event.data.locator === locator
    ));

    expect(result.status).toBe("completed");
    expect(requestNumber).toBeGreaterThan(3);
    expect(readCalls).toBeGreaterThan(1);
    expect(tailSeen).toBe(true);
    expect(locator).toBeDefined();
    expect(spillRef).toBeDefined();
    expect(refetches.every((event) => event.data.content_hash === spillRef?.content_hash)).toBe(true);
    expect(refetchedHash).toBe(spillRef?.content_hash);
    expect(refetches[0]?.data.offset).toBe(0);
    expect(refetches.at(-1)?.data.truncated).toBe(false);
    for (let index = 1; index < refetches.length; index += 1) {
      const previous = refetches[index - 1]!;
      expect(refetches[index]?.data.offset).toBe(
        Number(previous.data.offset) + Number(previous.data.bytes_read),
      );
    }
    const archived = await runtime.getArtifact({
      artifactId: spillRef!.artifact_id,
      runId: result.run_id,
      projectId: result.project_id,
    });
    expect(archived.status).toBe("available");
    if (archived.status === "available") {
      expect(archived.content).toContain(rawMarker);
      expect(sha256(archived.content)).toBe(spillRef!.content_hash);
    }
    const readToolEvents = result.timeline.filter((event) => (
      event.type === "tool.completed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "read_artifact"
    ));
    expect(readToolEvents).toHaveLength(readCalls);
    expect(readToolEvents.every((event) => (
      event.artifact_refs.length === 1
      && event.artifact_refs[0]?.artifact_id === spillRef?.artifact_id
    ))).toBe(true);
    expect(JSON.stringify(result.timeline)).not.toContain(oversizedOutput);
    expect(await readTreeText(join(data.path, "events"))).not.toContain(oversizedOutput);
  });

  it("derives model-process events from checked Decision structure, not provider prose", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const model: ModelAdapter = {
      name: "untrusted-public-reason-model",
      async decide() {
        return {
          decision_id: "decision:untrusted-public-reason",
          kind: "finish",
          public_reason: "PRIVATE_CHAIN_OF_THOUGHT_DO_NOT_SHOW",
          evidence_refs: [],
          risk: "none",
          final_answer: "A safe final answer.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });
    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForTerminal(runtime, started.run_id);
    const decision = runtime.listLiveActivities(started.run_id)
      .find((activity) => activity.source_event_type === "model.decision");

    expect(decision).toMatchObject({ summary: "Prepared a direct response" });
    expect(JSON.stringify(runtime.listLiveActivities(started.run_id)))
      .not.toContain("PRIVATE_CHAIN_OF_THOUGHT_DO_NOT_SHOW");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CHAIN_OF_THOUGHT_DO_NOT_SHOW");
  });

  it("notifies a live subscriber as real model and terminal events occur", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let beginDecision!: () => void;
    const decisionStarted = new Promise<void>((resolve) => { beginDecision = resolve; });
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => { releaseDecision = resolve; });
    const model: ModelAdapter = {
      name: "live-gated-model",
      async decide() {
        beginDecision();
        await decisionGate;
        return {
          decision_id: "decision:live-finish",
          kind: "finish",
          public_reason: "The public explanation is ready.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Done.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });
    const started = await runtime.startRun({
      ...startInput(fixture.handle),
      mode: "execute",
    });
    await decisionStarted;
    const received: string[] = [];
    const unsubscribe = runtime.subscribeLive(started.run_id, (activity) => {
      received.push(activity.source_event_type);
    });
    releaseDecision();
    await waitForTerminal(runtime, started.run_id);
    unsubscribe();

    expect(received).toEqual(expect.arrayContaining(["model.decision", "run.completed"]));
  });

  it("runs four concurrency-safe reads together and preserves requested observation order", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    const finishes: number[] = [];
    registry.register({
      ...search,
      async execute(input: unknown) {
        starts.push(Date.now());
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        finishes.push(Date.now());
        return {
          status: "success" as const,
          code: "parallel_read_complete",
          summary: "Completed a bounded parallel read",
          facts: { pattern: (input as { pattern: string }).pattern },
        };
      },
    } as ToolDefinition);
    let observedOrder: string[] = [];
    const actionIds = ["action:parallel:1", "action:parallel:2", "action:parallel:3", "action:parallel:4"];
    const model: ModelAdapter = {
      name: "parallel-read-model",
      async decide(input) {
        if (input.observations.length === 0) {
          return {
            decision_id: "decision:parallel-reads",
            kind: "tool_call",
            public_reason: "Inspect four independent repository facts together.",
            evidence_refs: [],
            risk: "low",
            tool_calls: actionIds.map((actionId, index) => ({
              action_id: actionId,
              tool_name: "search" as const,
              arguments: { pattern: `parallel-${index}` },
            })),
          };
        }
        observedOrder = input.observations.map(({ facts }) => String(facts.pattern));
        return {
          decision_id: "decision:parallel-finish",
          kind: "finish",
          public_reason: "All independent reads completed.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Parallel reads completed.",
        };
      },
    };
    const sessionStore = new JsonlSessionStore(join(data.path, "sessions"));
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      toolRegistry: registry,
      sessionStore,
    });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "completed");
    const batchStarted = result.timeline.find((event) => event.type === "tool.batch_started");
    const batchCompleted = result.timeline.find((event) => event.type === "tool.batch_completed");
    if (result.session_id === undefined) throw new Error("parallel batch Run has no Session identity");
    const stored = await waitForSessionEntryCount(sessionStore, result.session_id, result.timeline.length);

    expect(peak).toBe(4);
    expect(Math.max(...finishes) - Math.min(...starts)).toBeLessThan(100);
    expect(observedOrder).toEqual(["parallel-0", "parallel-1", "parallel-2", "parallel-3"]);
    expect(result.timeline.filter((event) => event.type === "tool.started").map((event) => event.action_id)).toEqual(actionIds);
    expect(result.timeline.filter((event) => event.type === "tool.completed").map((event) => event.action_id)).toEqual(actionIds);
    expect(result.timeline.filter((event) => event.type === "tool.completed")).toEqual(
      actionIds.map((actionId) => expect.objectContaining({
        action_id: actionId,
        data: expect.objectContaining({
          receipt: expect.objectContaining({
            metadata: expect.objectContaining({ execution_parallel: true }),
          }),
        }),
      })),
    );
    expect(batchStarted?.data).toMatchObject({
      requested_count: 4,
      max_concurrency: 4,
      effective_concurrency: 4,
      action_ids: actionIds,
      parallel_action_ids: actionIds,
      serialized_actions: [],
    });
    expect(batchCompleted?.data).toMatchObject({
      requested_count: 4,
      completed_count: 4,
      failed_count: 0,
      max_concurrency: 4,
      effective_concurrency: 4,
      action_ids: actionIds,
      results: actionIds.map((actionId) => expect.objectContaining({ action_id: actionId, status: "success" })),
    });
    expect(batchCompleted?.operation_id).toBe(batchStarted?.operation_id);
    expect(stored.entries.map(({ event_ref: eventRef }) => eventRef.event_id)).toEqual(
      result.timeline.map(({ event_id: eventId }) => eventId),
    );
    expect(stored.entries.map(({ event_ref: eventRef }) => eventRef.sequence)).toEqual(
      result.timeline.map(({ sequence }) => sequence),
    );
    expect(new Set(stored.entries.map(({ entry_id: entryId }) => entryId)).size).toBe(stored.entries.length);
    expect(stored.entries.map(({ parent_entry_id: parentEntryId }) => parentEntryId)).toEqual(
      stored.entries.map((_, index, entries) => index === 0 ? undefined : entries[index - 1]?.entry_id),
    );
  });

  it("isolates a write-classified call between parallel-safe waves", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const readFileTool = registry.get("read_file")!;
    const searchTool = registry.get("search")!;
    let active = 0;
    let writeActive = false;
    let overlap = false;
    const trace: string[] = [];
    const run = async (label: string, write: boolean) => {
      if ((write && active > 0) || (!write && writeActive)) overlap = true;
      active += 1;
      if (write) writeActive = true;
      trace.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      trace.push(`end:${label}`);
      if (write) writeActive = false;
      active -= 1;
      return { status: "success" as const, code: "wave_complete", summary: `Completed ${label}` };
    };
    registry.register({
      ...readFileTool,
      async execute(input: unknown) {
        return run((input as { path: string }).path, false);
      },
    } as ToolDefinition);
    registry.register({
      ...searchTool,
      concurrencySafe: true,
      sideEffect: "write",
      async execute() {
        return run("write", true);
      },
    } as ToolDefinition);
    const actionIds = ["action:wave:r1", "action:wave:r2", "action:wave:w", "action:wave:r3", "action:wave:r4"];
    const model: ModelAdapter = {
      name: "serialized-write-model",
      async decide(input) {
        if (input.observations.length === 0) {
          return {
            decision_id: "decision:serialized-write",
            kind: "tool_call",
            public_reason: "Run safe reads around one isolated write-classified operation.",
            evidence_refs: [],
            risk: "medium",
            tool_calls: [
              { action_id: actionIds[0]!, tool_name: "read_file", arguments: { path: "safe-1" } },
              { action_id: actionIds[1]!, tool_name: "read_file", arguments: { path: "safe-2" } },
              { action_id: actionIds[2]!, tool_name: "search", arguments: { pattern: "write" } },
              { action_id: actionIds[3]!, tool_name: "read_file", arguments: { path: "safe-3" } },
              { action_id: actionIds[4]!, tool_name: "read_file", arguments: { path: "safe-4" } },
            ],
          };
        }
        return {
          decision_id: "decision:serialized-write-finish",
          kind: "finish",
          public_reason: "The isolated waves completed.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Serialized write completed.",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      toolRegistry: registry,
      approvalAnswerer: async () => "allowed-once" as const,
    });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "completed");
    const batchStarted = result.timeline.find((event) => event.type === "tool.batch_started");
    const batchCompleted = result.timeline.find((event) => event.type === "tool.batch_completed");

    expect(overlap).toBe(false);
    expect(trace.indexOf("start:write")).toBeGreaterThan(trace.indexOf("end:safe-1"));
    expect(trace.indexOf("start:write")).toBeGreaterThan(trace.indexOf("end:safe-2"));
    expect(trace.indexOf("end:write")).toBeLessThan(trace.indexOf("start:safe-3"));
    expect(trace.indexOf("end:write")).toBeLessThan(trace.indexOf("start:safe-4"));
    expect(batchStarted?.data).toMatchObject({
      requested_count: 5,
      serialized_actions: [{ action_id: "action:wave:w", reason: "write_side_effect" }],
    });
    expect(batchCompleted?.data).toMatchObject({ effective_concurrency: 2, completed_count: 5 });
  });

  it("prevalidates every batched call before executing the first member", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    let executions = 0;
    registry.register({
      ...search,
      async execute(input: unknown, context) {
        executions += 1;
        return search.execute(input, context);
      },
    } as ToolDefinition);
    const model: ModelAdapter = {
      name: "invalid-late-batch-member-model",
      async decide() {
        return {
          decision_id: "decision:invalid-late-member",
          kind: "tool_call",
          public_reason: "The second call is deliberately invalid.",
          evidence_refs: [],
          risk: "low",
          tool_calls: [
            { action_id: "action:valid-first", tool_name: "search", arguments: { pattern: "return" } },
            { action_id: "action:invalid-second", tool_name: "read_file", arguments: {} },
          ],
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model, toolRegistry: registry });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(executions).toBe(0);
    expect(result.failure_code).toBe("schema_invalid");
    expect(result.timeline.some((event) => event.type === "tool.started")).toBe(false);
    expect(result.timeline.some((event) => event.type === "tool.batch_started")).toBe(false);
    expect(result.timeline.find((event) => event.type === "action.rejected")?.data).toMatchObject({
      code: "schema_invalid",
      failure_class: "invalid_arguments",
    });
  });

  it("stops a batch at a successful preview approval barrier", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    let searchExecutions = 0;
    registry.register({
      ...search,
      async execute(input: unknown, context) {
        searchExecutions += 1;
        return search.execute(input, context);
      },
    } as ToolDefinition);
    const model: ModelAdapter = {
      name: "preview-barrier-model",
      async decide() {
        return {
          decision_id: "decision:preview-barrier",
          kind: "tool_call",
          public_reason: "Prepare the patch, then wait for its approval.",
          evidence_refs: [],
          risk: "high",
          tool_calls: [
            {
              action_id: "action:preview-barrier",
              tool_name: "preview_patch",
              arguments: { path: "src/add.ts", expected: "return left - right;", replacement: "return left + right;" },
            },
            { action_id: "action:must-not-run", tool_name: "search", arguments: { pattern: "after preview" } },
          ],
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model, toolRegistry: registry });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const completed = result.timeline.find((event) => event.type === "tool.batch_completed");

    expect(searchExecutions).toBe(0);
    expect(result.pending_approval?.action_id).toBe("action:preview-barrier");
    expect(result.timeline.filter((event) => event.type === "tool.started").map((event) => event.action_id)).toEqual(["action:preview-barrier"]);
    expect(result.timeline.find((event) => event.type === "tool.completed")?.data).toMatchObject({
      receipt: { metadata: { execution_parallel: false } },
    });
    expect(completed?.data).toMatchObject({ requested_count: 2, completed_count: 1, failed_count: 0 });
  });

  it("settles a failed parallel wave and reports the first failure in request order", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    let executions = 0;
    registry.register({
      ...search,
      async execute(input: unknown) {
        executions += 1;
        const pattern = (input as { pattern: string }).pattern;
        const delay = pattern === "failure-2" ? 5 : pattern === "failure-3" ? 1 : 30;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (pattern === "failure-2") return { status: "failure" as const, code: "requested_second_failed", summary: "The requested second call failed" };
        if (pattern === "failure-3") return { status: "failure" as const, code: "requested_third_failed", summary: "The requested third call failed first in wall time" };
        return { status: "success" as const, code: "parallel_success", summary: `Completed ${pattern}` };
      },
    } as ToolDefinition);
    const actionIds = ["action:settle:1", "action:settle:2", "action:settle:3", "action:settle:4"];
    const model: ModelAdapter = {
      name: "failed-parallel-wave-model",
      async decide() {
        return {
          decision_id: "decision:failed-parallel-wave",
          kind: "tool_call",
          public_reason: "Exercise deterministic parallel failure handling.",
          evidence_refs: [],
          risk: "low",
          tool_calls: actionIds.map((actionId, index) => ({
            action_id: actionId,
            tool_name: "search" as const,
            arguments: { pattern: index === 1 ? "failure-2" : index === 2 ? "failure-3" : `success-${index}` },
          })),
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model, toolRegistry: registry });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "failed");
    const completed = result.timeline.find((event) => event.type === "tool.batch_completed");
    const failed = result.timeline.find((event) => event.type === "run.failed");

    expect(executions).toBe(4);
    expect(result.failure_code).toBe("requested_second_failed");
    expect(result.timeline.filter((event) => ["tool.completed", "tool.failed"].includes(event.type)).map((event) => event.action_id)).toEqual(actionIds);
    expect((completed?.data.results as Array<{ action_id: string }>).map(({ action_id: actionId }) => actionId)).toEqual(actionIds);
    expect(completed!.sequence).toBeLessThan(failed!.sequence);
  });

  it("closes a started batch with zero executions when a concurrent stop wins", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    let executions = 0;
    registry.register({
      ...search,
      async execute() {
        executions += 1;
        return { status: "success" as const, code: "should_not_run", summary: "Unexpected execution" };
      },
    } as ToolDefinition);
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const model: ModelAdapter = {
      name: "stop-after-batch-start-model",
      async decide() {
        await decisionGate;
        return {
          decision_id: "decision:stop-race",
          kind: "tool_call",
          public_reason: "Expose the durable batch boundary before execution.",
          evidence_refs: [],
          risk: "low",
          tool_calls: [
            { action_id: "action:stop-race:1", tool_name: "search", arguments: { pattern: "one" } },
            { action_id: "action:stop-race:2", tool_name: "search", arguments: { pattern: "two" } },
          ],
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model, toolRegistry: registry });
    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    let stopPromise: Promise<Awaited<ReturnType<AgentRuntime["getProjection"]>>> | undefined;
    const unsubscribe = runtime.subscribe(started.run_id, (event) => {
      if (event.type !== "tool.batch_started" || stopPromise !== undefined) return;
      stopPromise = runtime.stop({
        type: "stop",
        command_id: "command:stop-batch-race",
        project_id: started.project_id,
        run_id: started.run_id,
        reason: "Exercise the zero-execution batch closure",
      });
    });

    releaseDecision();
    const result = await waitForStatus(runtime, started.run_id, "cancelled");
    await stopPromise;
    unsubscribe();
    const completed = result.timeline.find((event) => event.type === "tool.batch_completed");

    expect(executions).toBe(0);
    expect(result.timeline.some((event) => event.type === "tool.started")).toBe(false);
    expect(completed?.data).toMatchObject({
      requested_count: 2,
      completed_count: 0,
      failed_count: 0,
      effective_concurrency: 0,
      results: [],
    });
    expect(completed!.sequence).toBeLessThan(
      result.timeline.find((event) => event.type === "run.cancelled")!.sequence,
    );
  });

  it("shields a renamed patch from cancellation until its WAL and events settle", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let releaseAppliedBoundary!: () => void;
    let reachAppliedBoundary!: () => void;
    const appliedBoundary = new Promise<void>((resolve) => {
      reachAppliedBoundary = resolve;
    });
    const appliedBoundaryGate = new Promise<void>((resolve) => {
      releaseAppliedBoundary = resolve;
    });
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      async actionCommitFaultInjector(point) {
        if (point !== "after_apply_before_applied") return;
        reachAppliedBoundary();
        await appliedBoundaryGate;
      },
    });
    const started = await runtime.startRun(startInput(fixture.handle));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = waiting.pending_approval!;
    const approvePromise = runtime.approve({
      type: "approve",
      command_id: "command:approve-stop-after-rename",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });

    await appliedBoundary;
    expect(await source(fixture.handle.real_root)).toContain("return left + right;");
    const stopPromise = runtime.stop({
      type: "stop",
      command_id: "command:stop-after-rename",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      reason: "Stop while the renamed patch is crossing the applied WAL boundary",
    });
    releaseAppliedBoundary();
    await approvePromise;
    const cancelled = await stopPromise;
    const wal = new ActionWal(join(data.path, "wal"));
    const walAtCancellation = await wal.list(waiting.run_id);
    const latest = await wal.latestForAction(waiting.run_id, pending.action_id);
    const commitCompleted = cancelled.timeline.find((event) => (
      event.type === "tool.completed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ));
    const patchApplied = cancelled.timeline.find((event) => event.type === "patch.applied");
    const verified = cancelled.timeline.find((event) => event.type === "action.verified");
    const terminal = cancelled.timeline.find((event) => event.type === "run.cancelled");

    expect(cancelled.status).toBe("cancelled");
    expect(commitCompleted).toBeDefined();
    expect(cancelled.timeline.some((event) => (
      event.type === "tool.failed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ))).toBe(false);
    expect(JSON.stringify(cancelled.timeline)).not.toContain("tool_aborted");
    expect(latest?.phase).toBe("verified");
    expect(patchApplied!.sequence).toBeLessThan(verified!.sequence);
    expect(verified!.sequence).toBeLessThan(terminal!.sequence);

    // Awaiting approve + stop must also await the underlying mutation. Nothing
    // may continue advancing the WAL or ledger after the terminal projection.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await wal.list(waiting.run_id)).toEqual(walAtCancellation);
    expect((await runtime.getProjection(waiting.run_id)).timeline).toEqual(cancelled.timeline);
    expect(await source(fixture.handle.real_root)).toContain("return left + right;");
  });

  it("shields a renamed patch past its Tool timeout until durability settles", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const commitPatch = registry.get("commit_patch")!;
    registry.register({ ...commitPatch, timeoutMs: 250 } as ToolDefinition);
    let releaseAppliedBoundary!: () => void;
    let reachAppliedBoundary!: () => void;
    const appliedBoundary = new Promise<void>((resolve) => {
      reachAppliedBoundary = resolve;
    });
    const appliedBoundaryGate = new Promise<void>((resolve) => {
      releaseAppliedBoundary = resolve;
    });
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      toolRegistry: registry,
      async actionCommitFaultInjector(point) {
        if (point !== "after_apply_before_applied") return;
        reachAppliedBoundary();
        await appliedBoundaryGate;
      },
    });
    const started = await runtime.startRun(startInput(fixture.handle));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = waiting.pending_approval!;
    const approvePromise = runtime.approve({
      type: "approve",
      command_id: "command:approve-timeout-after-rename",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });

    await appliedBoundary;
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseAppliedBoundary();
    const completed = await approvePromise;
    const wal = new ActionWal(join(data.path, "wal"));
    const commitCompleted = completed.timeline.find((event) => (
      event.type === "tool.completed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ));

    expect(completed.status).toBe("completed");
    expect(commitCompleted).toBeDefined();
    expect(completed.timeline.some((event) => (
      event.type === "tool.failed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ))).toBe(false);
    expect(JSON.stringify(completed.timeline)).not.toContain("timeout");
    expect((await wal.latestForAction(waiting.run_id, pending.action_id))?.phase).toBe("verified");
    expect(completed.timeline.some((event) => event.type === "patch.applied")).toBe(true);
    expect(await source(fixture.handle.real_root)).toContain("return left + right;");
  });

  it("rejects dirty executor output at the Runtime boundary without persisting it", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    const dirtyMarker = "DIRTY_RUNTIME_OUTPUT_MUST_NOT_LEAK";
    let rendered = false;
    registry.register({
      ...search,
      outputSchema: z.object({ safe: z.string() }).strict(),
      async execute() {
        return { safe: "expected", secret_payload: dirtyMarker };
      },
      render() {
        rendered = true;
        return { status: "success", code: "unsafe", summary: dirtyMarker };
      },
    } as unknown as ToolDefinition<unknown, { safe: string }>);
    const model: ModelAdapter = {
      name: "dirty-output-model",
      async decide() {
        return {
          decision_id: "decision:dirty-output",
          kind: "tool_call",
          public_reason: "Exercise the Tool output contract.",
          evidence_refs: [],
          risk: "low",
          tool_call: {
            action_id: "action:dirty-output",
            tool_name: "search",
            arguments: { pattern: "contract" },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model, toolRegistry: registry });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "failed");
    const failed = result.timeline.find((event) => event.type === "tool.failed");

    expect(rendered).toBe(false);
    expect(failed?.data).toMatchObject({
      code: "output_contract_violation",
      business_code: "output_contract_violation",
    });
    expect(failed?.artifact_refs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(dirtyMarker);
    expect(await readTreeText(data.path)).not.toContain(dirtyMarker);
  });

  it("reports a Runtime Tool timeout with the generic failure class", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    registry.register({
      ...search,
      timeoutMs: 20,
      async execute() {
        return new Promise<never>(() => undefined);
      },
    } as ToolDefinition);
    const model: ModelAdapter = {
      name: "runtime-timeout-model",
      async decide() {
        return {
          decision_id: "decision:runtime-timeout",
          kind: "tool_call",
          public_reason: "Exercise the bounded Tool deadline.",
          evidence_refs: [],
          risk: "low",
          tool_call: {
            action_id: "action:runtime-timeout",
            tool_name: "search",
            arguments: { pattern: "deadline" },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model, toolRegistry: registry });

    const started = await runtime.startRun({ ...startInput(fixture.handle), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "failed");
    const failed = result.timeline.find((event) => event.type === "tool.failed");

    expect(result.failure_code).toBe("timeout");
    expect(failed?.data).toMatchObject({ code: "timeout", business_code: "timeout" });
    expect(failed?.artifact_refs).toEqual([]);
  });

  it("lists current-Run Artifact metadata in a zero-capability workspace without creating a listing Artifact", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const workspace = {
      ...fixture.handle,
      workspace_kind: "readonly_local" as const,
      capabilities: {
        index: false,
        read: false,
        search: false,
        run_command: false,
        preview_patch: false,
        commit_patch: false,
        test: false,
      },
    };
    let visibleArtifacts: unknown;
    const model: ModelAdapter = {
      name: "plain-chat-artifact-index-model",
      async decide(input) {
        if (input.observations.length === 0) {
          return {
            decision_id: "decision:list-current-run-artifacts",
            kind: "tool_call",
            public_reason: "Inspect this Run's public Artifact metadata.",
            evidence_refs: [],
            risk: "low",
            tool_call: {
              action_id: "action:list-current-run-artifacts",
              tool_name: "list_artifacts",
              arguments: { offset: 0, limit: 100 },
            },
          };
        }
        visibleArtifacts = input.observations.at(-1)?.facts.artifacts;
        return {
          decision_id: "decision:list-current-run-artifacts-finish",
          kind: "finish",
          public_reason: "The current Run Artifact index is visible.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Artifact metadata listed.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun({ ...startInput(workspace), mode: "execute" });
    const result = await waitForStatus(runtime, started.run_id, "completed");
    const listed = result.timeline.find((event) => (
      event.type === "tool.completed" && event.action_id === "action:list-current-run-artifacts"
    ));
    const artifacts = visibleArtifacts as Array<{
      artifact_id: string;
      created_at: string;
      kind: string;
    }>;

    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every(({ kind }) => kind !== "recovery_state")).toBe(true);
    expect(artifacts.map(({ artifact_id: artifactId }) => artifactId)).toEqual(
      [...artifacts]
        .sort((left, right) => left.created_at.localeCompare(right.created_at)
          || left.artifact_id.localeCompare(right.artifact_id))
        .map(({ artifact_id: artifactId }) => artifactId),
    );
    expect(listed?.artifact_refs).toEqual([]);
    expect((listed?.data.receipt as { artifact_refs: unknown[] }).artifact_refs).toEqual([]);
    expect((listed?.data.observation as { facts: { artifacts: unknown[] } }).facts.artifacts).toEqual(artifacts);
  });

  it("runs the observation loop through preview, approval, patch, and test", async () => {
    const setup = await setupRuntime();
    const started = await setup.runtime.startRun(startInput(setup.fixture.handle));
    const waiting = await waitForStatus(setup.runtime, started.run_id, "awaiting_approval");

    expect(waiting.status).toBe("awaiting_approval");
    expect(await source(setup.fixture.handle.real_root)).toContain("return left - right;");
    expect(waiting.pending_approval).toBeDefined();

    const pending = waiting.pending_approval!;
    const completed = await setup.runtime.approve({
      type: "approve",
      command_id: "command:approve",
      project_id: setup.fixture.handle.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });

    expect(completed.status).toBe("completed");
    expect(await source(setup.fixture.handle.real_root)).toContain("return left + right;");
    expect(completed.timeline.map((event) => event.type)).toEqual(expect.arrayContaining([
      "patch.preview_created",
      "approval.requested",
      "approval.granted",
      "patch.applied",
      "test.completed",
      "run.completed",
    ]));
    const patchEvent = completed.timeline.find((event) => event.type === "patch.applied");
    const testEvent = completed.timeline.find((event) => event.type === "test.completed");
    expect(patchEvent).toBeDefined();
    expect(testEvent?.patch_event_id).toBe(patchEvent?.event_id);
    const diffArtifact = completed.artifact_refs.find((artifact) => artifact.kind === "diff");
    expect(diffArtifact).toBeDefined();
    await expect(setup.runtime.getArtifact({
      artifactId: diffArtifact!.artifact_id,
      runId: completed.run_id,
      projectId: completed.project_id,
    })).resolves.toMatchObject({ status: "available" });
    await expect(setup.runtime.getArtifact({
      artifactId: "artifact:not-linked",
      runId: completed.run_id,
      projectId: completed.project_id,
    })).resolves.toEqual({
      status: "unavailable",
      artifact_id: "artifact:not-linked",
      reason: "out_of_scope",
    });
  });

  it("records rejection without modifying the fixture", async () => {
    const setup = await setupRuntime();
    const started = await setup.runtime.startRun(startInput(setup.fixture.handle));
    const waiting = await waitForStatus(setup.runtime, started.run_id, "awaiting_approval");
    const pending = waiting.pending_approval!;
    const rejected = await setup.runtime.reject({
      type: "reject",
      command_id: "command:reject",
      project_id: setup.fixture.handle.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
      reason: "reviewer rejected the patch",
    });

    expect(rejected.status).toBe("cancelled");
    expect(await source(setup.fixture.handle.real_root)).toContain("return left - right;");
    expect(rejected.timeline.some((event) => event.type === "patch.applied")).toBe(false);
  });

  it("rejects a stale base hash at commit time", async () => {
    const setup = await setupRuntime();
    const started = await setup.runtime.startRun(startInput(setup.fixture.handle));
    const waiting = await waitForStatus(setup.runtime, started.run_id, "awaiting_approval");
    const path = join(setup.fixture.handle.real_root, "src/add.ts");
    await writeFile(path, `${await readFile(path, "utf8")}\n// external change\n`);
    const pending = waiting.pending_approval!;
    const result = await setup.runtime.approve({
      type: "approve",
      command_id: "command:stale-approve",
      project_id: setup.fixture.handle.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });

    expect(result.status).toBe("failed");
    expect(result.failure_code).toBe("stale_base");
    expect(await source(setup.fixture.handle.real_root)).toContain("return left - right;");
    expect(result.timeline.some((event) => event.type === "action.stale")).toBe(true);
  });

  it("expires a one-time approval before any patch is committed", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let now = new Date("2026-09-16T00:00:00.000Z");
    const runtime = await createAgentRuntime({ dataDir: data.path, now: () => now });
    const started = await runtime.startRun(startInput(fixture.handle));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = waiting.pending_approval!;
    now = new Date("2026-09-16T00:06:00.000Z");

    const result = await runtime.approve({
      type: "approve",
      command_id: "command:expired-approval",
      project_id: fixture.handle.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });

    expect(result.status).toBe("failed");
    expect(result.failure_code).toBe("approval_expired");
    expect(result.timeline.some((event) => event.type === "approval.expired")).toBe(true);
    expect(result.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await source(fixture.handle.real_root)).toContain("return left - right;");
  });

  it("stops rather than retrying an unknown tool receipt", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let executions = 0;
    const registry = createDefaultToolRegistry();
    const original = registry.get("search")!;
    registry.register({
      ...original,
      async execute() {
        executions += 1;
        return { status: "unknown", code: "external_state_unknown", summary: "Search transport state is unknown" };
      },
    } as ToolDefinition);
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      toolRegistry: registry,
      idFactory: createSequentialIdFactory(),
    });
    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(result.status).toBe("failed");
    expect(result.failure_code).toBe("unknown_side_effect");
    expect(executions).toBe(1);
    expect(result.timeline.filter((event) => event.type === "tool.unknown")).toHaveLength(1);
  });

  it("commits exactly one terminal event under repeated stop commands", async () => {
    const setup = await setupRuntime();
    const waiting = await setup.runtime.startRun(startInput(setup.fixture.handle));
    await setup.runtime.stop({
      type: "stop",
      command_id: "command:stop-1",
      project_id: setup.fixture.handle.project_id,
      run_id: waiting.run_id,
      reason: "stop once",
    });
    const result = await setup.runtime.stop({
      type: "stop",
      command_id: "command:stop-2",
      project_id: setup.fixture.handle.project_id,
      run_id: waiting.run_id,
      reason: "stop twice",
    });
    const terminal = result.timeline.filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.type).toBe("run.cancelled");
  });

  it("replays projection without calling a tool again", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let executions = 0;
    const registry = new ToolRegistry();
    for (const definition of createDefaultToolRegistry().list()) {
      registry.register({
        ...definition,
        async execute(input: unknown, context) {
          executions += 1;
          return definition.execute(input, context);
        },
      } as ToolDefinition);
    }
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      toolRegistry: registry,
      idFactory: createSequentialIdFactory(),
    });
    const started = await runtime.startRun(startInput(fixture.handle));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = waiting.pending_approval!;
    const completed = await runtime.approve({
      type: "approve",
      command_id: "command:approve-replay",
      project_id: fixture.handle.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });
    const beforeReplay = executions;
    const replayed = await runtime.replay(completed.run_id);

    expect(replayed).toEqual(completed);
    expect(executions).toBe(beforeReplay);
  });

  it("returns a run id and cancels a model adapter that never resolves", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const model: ModelAdapter = {
      name: "slow-model",
      decide: async () => new Promise<never>(() => undefined),
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await Promise.race([
      runtime.startRun(startInput(fixture.handle)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startRun blocked")), 250)),
    ]);
    expect(["indexing", "running"]).toContain(started.status);
    const stoppedPromise = runtime.stop({
      type: "stop",
      command_id: "command:stop-slow-model",
      project_id: fixture.handle.project_id,
      run_id: started.run_id,
      reason: "verify asynchronous stop",
    });
    const stopped = await Promise.race([
      stoppedPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stop blocked on model")), 500)),
    ]);
    expect(stopped.status).toBe("cancelled");
    expect(stopped.timeline.filter((event) => [
      "run.completed",
      "run.failed",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);
  });

  it("cancels an in-flight commit before its atomic rename and never continues to tests", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const registry = createDefaultToolRegistry();
    const commit = registry.get("commit_patch")!;
    let markCommitStarted: (() => void) | undefined;
    let releaseCommit: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    registry.register({
      ...commit,
      async execute(input: unknown, context) {
        markCommitStarted?.();
        await commitRelease;
        return commit.execute(input, context);
      },
    } as ToolDefinition);
    const runtime = await createAgentRuntime({ dataDir: data.path, toolRegistry: registry });
    const started = await runtime.startRun(startInput(fixture.handle));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = waiting.pending_approval!;
    const approving = runtime.approve({
      type: "approve",
      command_id: "command:race-approve",
      project_id: fixture.handle.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });
    await commitStarted;
    const stopping = runtime.stop({
      type: "stop",
      command_id: "command:race-stop",
      project_id: fixture.handle.project_id,
      run_id: waiting.run_id,
      reason: "stop while commit is in flight",
    });
    releaseCommit?.();
    await approving;
    const stopped = await stopping;

    expect(stopped.status).toBe("cancelled");
    expect(await source(fixture.handle.real_root)).toContain("return left - right;");
    expect(stopped.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(stopped.timeline.some((event) => event.type === "test.completed")).toBe(false);
    expect(stopped.timeline.filter((event) => [
      "run.completed",
      "run.failed",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);
  });

  it("binds command ids to the original payload", async () => {
    const setup = await setupRuntime();
    const input = startInput(setup.fixture.handle);
    const started = await setup.runtime.startRun(input);

    await expect(setup.runtime.startRun({ ...input, task: "a different task" })).rejects.toMatchObject({
      code: "command_id_conflict",
    });
    await setup.runtime.stop({
      type: "stop",
      command_id: "command:stop-after-conflict",
      project_id: setup.fixture.handle.project_id,
      run_id: started.run_id,
    });
  });

  it.each(["approve", "reject"] as const)(
    "replays the same failed %s command as the same error",
    async (type) => {
      const setup = await setupRuntime();
      const started = await setup.runtime.startRun(startInput(setup.fixture.handle));
      const waiting = await waitForStatus(setup.runtime, started.run_id, "awaiting_approval");
      const pending = waiting.pending_approval!;
      const command = {
        type,
        command_id: `command:invalid-${type}`,
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        approval_id: "approval:does-not-match",
        action_id: pending.action_id,
      };
      const invoke = () => type === "approve"
        ? setup.runtime.approve(command)
        : setup.runtime.reject(command);

      await expect(invoke()).rejects.toMatchObject({ code: "approval_binding_mismatch" });
      await expect(invoke()).rejects.toMatchObject({ code: "approval_binding_mismatch" });

      const unchanged = await setup.runtime.getProjection(waiting.run_id);
      expect(unchanged.status).toBe("awaiting_approval");
      expect(unchanged.timeline.some((event) => [
        "approval.granted",
        "approval.denied",
      ].includes(event.type))).toBe(false);
      await setup.runtime.stop({
        type: "stop",
        command_id: `command:stop-after-invalid-${type}`,
        project_id: unchanged.project_id,
        run_id: unchanged.run_id,
      });
    },
  );

  it("accepts and safely retries a maximum-length command id", async () => {
    const setup = await setupRuntime();
    const input = {
      ...startInput(setup.fixture.handle),
      command_id: "c".repeat(160),
    };

    const [started, retried] = await Promise.all([
      setup.runtime.startRun(input),
      setup.runtime.startRun(input),
    ]);

    expect(retried.run_id).toBe(started.run_id);
    expect(retried.timeline.filter((event) => event.type === "run.created")).toHaveLength(1);
    await setup.runtime.stop({
      type: "stop",
      command_id: "command:stop-max-length-id",
      project_id: setup.fixture.handle.project_id,
      run_id: started.run_id,
    });
  });

  it("rejects a patch whose exact bytes cannot be displayed after redaction", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const model: ModelAdapter = {
      name: "sensitive-patch-model",
      async decide() {
        return {
          decision_id: "decision:sensitive-patch",
          kind: "tool_call",
          public_reason: "Exercise the exact-diff approval boundary.",
          evidence_refs: [],
          risk: "high",
          expected_effect: "The preview must be rejected before approval.",
          tool_call: {
            action_id: "action:sensitive-patch",
            tool_name: "preview_patch",
            arguments: {
              path: "src/add.ts",
              expected: "return left - right;",
              replacement: "return \"/etc/passwd\";",
            },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(result.failure_code).toBe("patch_sensitive_content");
    expect(result.timeline.some((event) => event.type === "approval.requested")).toBe(false);
    expect(await source(fixture.handle.real_root)).toContain("return left - right;");
  });

  it("rejects nested credential-like Decision arguments before they reach the event ledger", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const model: ModelAdapter = {
      name: "credential-leak-model",
      async decide() {
        return {
          decision_id: "decision:credential-leak",
          kind: "tool_call",
          public_reason: "Exercise credential rejection.",
          evidence_refs: [],
          risk: "low",
          expected_effect: "No secret reaches a canonical event.",
          tool_call: {
            action_id: "action:credential-leak",
            tool_name: "search",
            arguments: {
              pattern: "return left - right;",
              nested: [{ githubToken: "ghp_never-persist-this" }],
            },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "failed");
    const serialized = JSON.stringify(result);

    expect(result.failure_code).toBe("model_output_invalid");
    expect(result.timeline.some((event) => event.type === "model.decision")).toBe(false);
    expect(serialized).not.toContain("ghp_never-persist-this");
  });

  it("blocks sensitive workspace files before their contents reach Artifact or Context", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    await writeFile(join(fixture.handle.real_root, ".env"), "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\n");
    const model: ModelAdapter = {
      name: "sensitive-file-model",
      async decide() {
        return {
          decision_id: "decision:read-env",
          kind: "tool_call",
          public_reason: "Exercise the sensitive-file policy.",
          evidence_refs: [],
          risk: "low",
          expected_effect: "The read must fail before content capture.",
          tool_call: {
            action_id: "action:read-env",
            tool_name: "read_file",
            arguments: { path: ".env" },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(result.failure_code).toBe("sensitive_file_blocked");
    expect(JSON.stringify(result)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    for (const ref of result.artifact_refs) {
      const artifact = await runtime.getArtifact({
        artifactId: ref.artifact_id,
        runId: result.run_id,
        projectId: result.project_id,
      });
      expect(JSON.stringify(artifact)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    }
  });

  it("skips sensitive files during repository search", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const searchMarker = "sensitive_search_marker_1234567890";
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    await writeFile(
      join(fixture.handle.real_root, ".env"),
      `GITHUB_TOKEN=${secret}\nMARKER=${searchMarker}\n`,
    );
    const model: ModelAdapter = {
      name: "sensitive-search-model",
      async decide(input) {
        if (input.observations.length === 0) {
          return {
            decision_id: "decision:search-secret",
            kind: "tool_call",
            public_reason: "Verify sensitive paths are excluded from search.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "No match should be returned.",
            tool_call: {
              action_id: "action:search-secret",
              tool_name: "search",
              arguments: { pattern: searchMarker },
            },
          };
        }
        return {
          decision_id: "decision:finish-sensitive-search",
          kind: "finish",
          public_reason: "Search policy was evaluated.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Sensitive paths were excluded.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "completed");

    expect(JSON.stringify(result)).not.toContain(secret);
    const searchEvent = result.timeline.find(
      (event) => event.type === "tool.completed" && event.data.receipt,
    );
    expect(searchEvent?.summary).toContain("No matches for sensitive_search_marker_1234567890; broaden the query or inspect the repository structure");
    for (const ref of result.artifact_refs) {
      const artifact = await runtime.getArtifact({
        artifactId: ref.artifact_id,
        runId: result.run_id,
        projectId: result.project_id,
      });
      expect(JSON.stringify(artifact)).not.toContain(secret);
    }
  });

  it("does not execute a repeated model action_id twice", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let searchExecutions = 0;
    const registry = createDefaultToolRegistry();
    const search = registry.get("search")!;
    registry.register({
      ...search,
      async execute(input: unknown, context) {
        searchExecutions += 1;
        return search.execute(input, context);
      },
    } as ToolDefinition);
    const model: ModelAdapter = {
      name: "duplicate-action-model",
      async decide() {
        return {
          decision_id: "decision:duplicate-action",
          kind: "tool_call",
          public_reason: "Return the same action twice.",
          evidence_refs: [],
          risk: "low",
          expected_effect: "Only the first action may execute.",
          tool_call: {
            action_id: "action:reused",
            tool_name: "search",
            arguments: { pattern: "return left - right;" },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model, toolRegistry: registry });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(result.failure_code).toBe("action_id_duplicate");
    expect(searchExecutions).toBe(1);
    expect(result.timeline.filter((event) => event.type === "action.rejected")).toHaveLength(1);
  });

  it("repairs a reused model action_id when the next call is different", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const model: ModelAdapter = {
      name: "conflicting-action-model",
      async decide(input) {
        if (input.observations.length === 0) {
          return {
            decision_id: "decision:conflict-list",
            kind: "tool_call",
            public_reason: "Inspect the repository structure before searching.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "The bounded listing will establish the workspace shape.",
            tool_call: {
              action_id: "action:1",
              tool_name: "list_dir",
              arguments: { path: ".", depth: 1 },
            },
          };
        }
        if (input.observations.length === 1) {
          return {
            decision_id: "decision:conflict-search",
            kind: "tool_call",
            public_reason: "The listing was partial, so search the repository for the implementation.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "The search will identify the relevant source file.",
            tool_call: {
              // Simulates providers that restart a turn-local counter. The
              // runtime must distinguish this new call from the prior one.
              action_id: "action:1",
              tool_name: "search",
              arguments: { pattern: "return left - right;" },
            },
          };
        }
        return {
          decision_id: "decision:conflict-finish",
          kind: "finish",
          public_reason: "The repository evidence is sufficient to answer.",
          evidence_refs: [],
          risk: "none",
          final_answer: "The repository was inspected successfully.",
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, model });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "completed");

    expect(result.failure_code).toBeUndefined();
    expect(result.timeline.filter((event) => event.type === "tool.completed")).toHaveLength(2);
    const repairedDecision = result.timeline.find(
      (event) => event.type === "model.decision" && event.data.action_id_repaired === true,
    );
    expect(repairedDecision).toMatchObject({
      action_id: "action:runtime:2:1",
      data: {
        action_id_repaired: true,
        model_action_id: "action:1",
        canonical_action_id: "action:runtime:2:1",
        action_id_repair_code: "action_id_conflict",
      },
    });
  });

  it("cancels graph indexing that never resolves", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const codeGraph: CodeGraphProvider = {
      createSnapshot: async () => new Promise<never>(() => undefined),
      createDelta: async () => { throw new Error("not reached"); },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, codeGraph });
    const started = await runtime.startRun(startInput(fixture.handle));

    const stopped = await Promise.race([
      runtime.stop({
        type: "stop",
        command_id: "command:stop-slow-index",
        project_id: fixture.handle.project_id,
        run_id: started.run_id,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stop blocked on index")), 500)),
    ]);

    expect(stopped.status).toBe("cancelled");
    expect(stopped.timeline.filter((event) => [
      "run.completed",
      "run.failed",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);
  });

  it("skips graph indexing and denies repository tools for a zero-capability chat workspace", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let snapshotCalls = 0;
    const codeGraph: CodeGraphProvider = {
      async createSnapshot() {
        snapshotCalls += 1;
        throw new Error("chat workspace must not be indexed");
      },
      createDelta: async () => { throw new Error("not reached"); },
    };
    const model: ModelAdapter = {
      name: "chat-tool-attempt-model",
      async decide() {
        return {
          decision_id: "decision:chat-read-attempt",
          kind: "tool_call",
          public_reason: "Try to inspect a repository file.",
          evidence_refs: [],
          risk: "low",
          expected_effect: "The zero-capability workspace must reject this request.",
          tool_call: {
            action_id: "action:chat-read-attempt",
            tool_name: "read_file",
            arguments: { path: "src/add.ts" },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, codeGraph, model });
    const workspace = {
      ...fixture.handle,
      workspace_kind: "readonly_local" as const,
      capabilities: {
        index: false,
        read: false,
        search: false,
        run_command: false,
        preview_patch: false,
        commit_patch: false,
        test: false,
      },
    };

    const started = await runtime.startRun({
      command_id: "command:start-chat",
      project_id: workspace.project_id,
      task: "Explain memory without using repository tools.",
      mode: "execute",
      workspace,
    });
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(snapshotCalls).toBe(0);
    expect(result.failure_code).toBe("capability_denied");
    expect(result.timeline.some((event) => event.type === "graph.snapshot_created")).toBe(false);
    expect(result.timeline.find((event) => event.type === "run.started")).toMatchObject({
      summary: "Conversation started without workspace indexing",
      data: { phase: "conversation" },
    });
    expect(result.timeline.find((event) => event.type === "policy.evaluated")).toMatchObject({
      data: {
        decision: {
          kind: "deny",
          source: "hard-constraint",
          explanation: expect.stringContaining("Workspace capability does not allow read_file"),
        },
      },
    });
    expect(result.timeline.find((event) => event.type === "policy.denied")).toMatchObject({
      data: {
        code: "capability_denied",
        decision: {
          kind: "deny",
          explanation: expect.stringContaining("Workspace capability does not allow read_file"),
        },
      },
    });
  });

  it("fails indexing when a CodeGraph adapter returns an invalid snapshot", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    const codeGraph: CodeGraphProvider = {
      createSnapshot: async () => ({ project_id: fixture.handle.project_id } as never),
      createDelta: async () => { throw new Error("not reached"); },
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, codeGraph });

    const started = await runtime.startRun(startInput(fixture.handle));
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(result.failure_code).toBe("indexing_failed");
    expect(result.timeline.some((event) => event.type === "graph.snapshot_created")).toBe(false);
  });

  it("fails the run when a CodeGraph adapter returns an invalid delta", async () => {
    const fixture = await createFailingTypescriptFixture();
    const data = await createTemporaryDataDir();
    cleanups.push(fixture.cleanup, data.cleanup);
    let snapshotNumber = 0;
    const codeGraph: CodeGraphProvider = {
      async createSnapshot({ projectId }) {
        snapshotNumber += 1;
        return {
          snapshot_id: `snapshot:${snapshotNumber}`,
          project_id: projectId,
          workspace_hash: `sha256:${"a".repeat(64)}`,
          created_at: "2026-09-16T00:00:00.000Z",
          nodes: [],
          edges: [],
          diagnostics: [],
        };
      },
      createDelta: async () => ({ change: "invented" } as never),
    };
    const runtime = await createAgentRuntime({ dataDir: data.path, codeGraph });
    const started = await runtime.startRun(startInput(fixture.handle));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = waiting.pending_approval!;

    const result = await runtime.approve({
      type: "approve",
      command_id: "command:invalid-graph-delta",
      project_id: fixture.handle.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });

    expect(result.status).toBe("failed");
    expect(result.failure_code).toBe("graph_delta_failed");
    expect(result.timeline.some((event) => event.type === "graph.delta_created")).toBe(false);
  });
});

async function setupRuntime() {
  const fixture = await createFailingTypescriptFixture();
  const data = await createTemporaryDataDir();
  cleanups.push(fixture.cleanup, data.cleanup);
  const runtime = await createAgentRuntime({
    dataDir: data.path,
    idFactory: createSequentialIdFactory(),
    // This legacy vertical-flow helper verifies orchestration rather than the
    // platform backend. G13 isolation has dedicated injected/native suites.
    sandboxMode: "danger-full-access",
  });
  return { fixture, data, runtime };
}

function g02ContextPolicy(options: {
  windowTokens: number;
  reservedOutputTokens: number;
  summaryTimeoutMs?: number;
  spillEnabled?: boolean;
  summaryEnabled?: boolean;
}): ContextPolicy {
  return {
    window_tokens: options.windowTokens,
    reserved_output_tokens: options.reservedOutputTokens,
    warning_ratio: 0.7,
    compression_ratio: 0.8,
    recent_history_messages: 16,
    history_checkpoint_tokens: 1_024,
    tool_budget_ratio: 0.1,
    token_estimator: "heuristic_v2",
    compaction: {
      tool_output_pruner: {
        enabled: false,
        threshold_tokens: 512,
        target_tokens: 128,
      },
      spill: {
        enabled: options.spillEnabled ?? false,
        threshold_tokens: 512,
        preview_tokens: 64,
      },
      model_summary: {
        enabled: options.summaryEnabled ?? true,
        threshold_tokens: 4_000,
        target_tokens: 1_024,
        timeout_ms: options.summaryTimeoutMs ?? 500,
        prompt_version: "tracegraph.context-summary.integration.v1",
      },
      tiered_checkpoint: {
        enabled: true,
        threshold_tokens: 4_000,
        target_tokens: 1_024,
      },
    },
  };
}

async function runSummaryFallbackCase(
  summarizeContext: NonNullable<ModelAdapter["summarizeContext"]>,
  timeoutMs = 500,
): Promise<{
  projection: Awaited<ReturnType<AgentRuntime["getProjection"]>>;
  manifest: ContextManifest;
  failure: Awaited<ReturnType<AgentRuntime["getProjection"]>>["timeline"][number] | undefined;
}> {
  const fixture = await createFailingTypescriptFixture();
  const data = await createTemporaryDataDir();
  cleanups.push(fixture.cleanup, data.cleanup);
  const model: ModelAdapter = {
    name: "g02-summary-fallback-model",
    summarizeContext,
    async decide() {
      return {
        decision_id: "decision:g02-summary-fallback-finish",
        kind: "finish",
        public_reason: "The deterministic fallback retained enough Context.",
        evidence_refs: [],
        risk: "none",
        final_answer: "The run completed with the tiered checkpoint fallback.",
      };
    },
  };
  const runtime = await createAgentRuntime({
    dataDir: data.path,
    model,
    contextPolicy: {
      ...g02ContextPolicy({
        windowTokens: 16_000,
        reservedOutputTokens: 2_000,
        summaryTimeoutMs: timeoutMs,
      }),
      recent_history_messages: 4,
    },
  });
  const conversationHistory = Array.from({ length: 32 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `fallback-source-${index}:${"回".repeat(1_200)}`,
  }));

  const started = await runtime.startRun({
    ...startInput(fixture.handle),
    mode: "execute",
    conversation_history: conversationHistory,
  });
  const projection = await waitForStatus(runtime, started.run_id, "completed");
  const contextBuilt = projection.timeline.find((event) => event.type === "context.built");
  if (contextBuilt === undefined) throw new Error("G02 fallback Run did not emit context.built");
  return {
    projection,
    manifest: await contextManifestFor(runtime, projection, contextBuilt),
    failure: projection.timeline.find((event) => event.type === "context.summary_failed"),
  };
}

async function contextManifestFor(
  runtime: AgentRuntime,
  projection: Awaited<ReturnType<AgentRuntime["getProjection"]>>,
  event: Awaited<ReturnType<AgentRuntime["getProjection"]>>["timeline"][number],
): Promise<ContextManifest> {
  const ref = event.artifact_refs.find((artifact) => artifact.kind === "context_manifest");
  if (ref === undefined) throw new Error("context.built did not reference a Context Manifest Artifact");
  const artifact = await runtime.getArtifact({
    artifactId: ref.artifact_id,
    runId: projection.run_id,
    projectId: projection.project_id,
  });
  if (artifact.status !== "available") {
    throw new Error(`Context Manifest Artifact is ${artifact.status}`);
  }
  return ContextManifestSchema.parse(JSON.parse(artifact.content));
}

function startInput(workspace: Awaited<ReturnType<typeof createFailingTypescriptFixture>>["handle"]) {
  return {
    command_id: "command:start",
    project_id: workspace.project_id,
    task: "Fix the failing test and explain the architecture impact.",
    mode: "execute" as const,
    workspace,
  };
}

async function source(root: string): Promise<string> {
  return readFile(join(root, "src/add.ts"), "utf8");
}

async function readTreeText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) chunks.push(await readTreeText(path));
    else if (entry.isFile()) chunks.push(await readFile(path, "utf8"));
  }
  return chunks.join("\n");
}

async function waitForSessionEntryCount(
  store: JsonlSessionStore,
  sessionId: string,
  count: number,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stored = await store.readAll(sessionId);
    if (stored.entries.length >= count) return stored;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} Session event references`);
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: "awaiting_approval" | "completed" | "failed" | "cancelled",
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<AgentRuntime["getProjection"]>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === status) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

async function waitForTerminal(
  runtime: AgentRuntime,
  runId: string,
): Promise<Awaited<ReturnType<AgentRuntime["getProjection"]>>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (["completed", "failed", "cancelled"].includes(projection.status)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a terminal status");
}
