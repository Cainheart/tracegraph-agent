import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import type { ContextBudgetSnapshot, EvidenceSnapshot, TraceEvent } from "../model";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import { ChatView, ProjectReady, shouldUseProgressiveAnswer } from "./WorkbenchStates";

const emptyEvidence: EvidenceSnapshot = {
  context: { status: "not_present", message: "none" },
  diff: { status: "not_present", message: "none" },
  graph: { status: "not_present", message: "none" },
  test: { status: "not_present", message: "none" },
};

describe("Chat workbench", () => {
  it("does not replay a persisted answer when returning to Chat from Trajectory", () => {
    expect(shouldUseProgressiveAnswer("completed", true)).toBe(false);
    expect(shouldUseProgressiveAnswer("failed", true)).toBe(false);
    expect(shouldUseProgressiveAnswer("running", true)).toBe(true);
  });

  it("keeps execute unavailable for a read-only project while leaving Plan selectable", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ProjectReady
      onReasoningEffortChange={vi.fn()}
      onStart={vi.fn()}
      readonly
      reasoningEffort="low"
    /></LanguageProvider>);
    expect(html).toContain('>Plan</button>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Execute is unavailable for a read-only project"[^>]*>.*Execute<\/button>/u);
  });

  it("renders actual durable tool facts without inventing a model thought narration", () => {
    const events: TraceEvent[] = [{
      id: "event-read-started",
      sequence: 4,
      kind: "tool",
      title: "Tool started",
      summary: "Reading apps/web/src/App.tsx",
      timestamp: "04:12:03",
      state: "running",
      operationId: "operation-read",
      toolName: "read_file",
      target: "apps/web/src/App.tsx",
    }, {
      id: "event-read-completed",
      sequence: 5,
      kind: "tool",
      title: "Tool completed",
      summary: "Read 120 lines",
      timestamp: "04:12:04",
      state: "succeeded",
      operationId: "operation-read",
      toolName: "read_file",
    }];
    const html = renderToStaticMarkup(<LanguageProvider><ChatView changedFiles={[]} conversation={[]} dataSource="live" events={events} evidence={emptyEvidence} outcome="Done" status="completed" task="Introduce the project" /></LanguageProvider>);
    expect(html).toContain("Reasoning process");
    expect(html).toContain("public-progress-item is-event is-running");
    expect(html).toContain("apps/web/src/App.tsx");
    expect(html).toContain("Only explicit public plans and observed tool facts are shown");
    expect(html).not.toContain("I have read apps/web/src/App.tsx");
  });

  it("offers the exact supported reasoning effort values", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ReasoningEffortPicker onChange={vi.fn()} value="xhigh" /></LanguageProvider>);
    for (const value of ["default", "low", "medium", "high", "xhigh", "max"]) expect(html).toContain(value);
    expect(html).toContain('data-supported-values="default,low,medium,high,xhigh,max"');
  });

  it("uses a durable public decision as the recorded fallback only", () => {
    const events: TraceEvent[] = [{
      id: "request",
      sequence: 1,
      kind: "decision",
      title: "Model request started",
      summary: "Requesting a model decision",
      timestamp: "04:12:03",
      state: "running",
      operationId: "model-call-1",
    }, {
      id: "decision",
      sequence: 2,
      kind: "decision",
      title: "Model decision",
      summary: "Inspect the repository before answering",
      rationale: "Inspect the repository before answering",
      timestamp: "04:12:04",
      state: "succeeded",
      operationId: "model-call-1",
    }];
    const html = renderToStaticMarkup(<LanguageProvider><ChatView changedFiles={[]} conversation={[]} dataSource="live" events={events} evidence={emptyEvidence} outcome="Done" status="completed" task="Introduce the project" /></LanguageProvider>);
    expect(html).toContain("Inspect the repository before answering");
    expect(html).not.toContain("My next public step is:");
  });

  it("renders WAL divergence as a static manual-review state", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ChatView
      changedFiles={[]}
      conversation={[]}
      dataSource="live"
      events={[]}
      evidence={emptyEvidence}
      status="needs_manual_review"
      task="Apply a safe patch"
    /></LanguageProvider>);

    expect(html).toContain("The workspace state differs from the Action WAL");
    expect(html).toContain("Automatic changes stopped");
    expect(html).not.toContain("The Agent is processing the task");
  });

  it("renders model-authored streaming snapshots and keeps tool facts separate", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ChatView
      changedFiles={[]}
      conversation={[]}
      dataSource="live"
      events={[]}
      evidence={emptyEvidence}
      publicActivities={[{
        id: "live:event-search",
        sourceEventId: "event-search",
        sourceEventType: "tool.started",
        sequence: 3,
        timestamp: "04:12:03",
        kind: "tool",
        status: "started",
        summary: "Searching the repository for ContextBuilder",
      }]}
      modelSurface={[{
        id: "surface:1",
        modelCallId: "model-call-1",
        cursor: 1,
        timestamp: "04:12:03",
        type: "public_plan_snapshot",
        status: "streaming",
        text: "I will inspect the context implementation before answering.",
      }, {
        id: "surface:thinking",
        modelCallId: "model-call-1",
        cursor: 2,
        timestamp: "04:12:03",
        type: "thinking_snapshot",
        status: "streaming",
        text: "I found the context boundary and will verify its budget calculation.",
      }, {
        id: "surface:2",
        modelCallId: "model-call-1",
        cursor: 3,
        timestamp: "04:12:04",
        type: "answer_snapshot",
        status: "streaming",
        text: "## Context\nA bounded input set",
      }]}
      status="running"
      task="Inspect the context implementation"
    /></LanguageProvider>);
    expect(html).toContain("Searching the repository for ContextBuilder");
    expect(html).toContain("streaming");
    expect(html).toContain("public-progress-item is-plan is-streaming");
    expect(html).not.toContain("I found the context boundary and will verify its budget calculation.");
    expect(html).toContain("<h2>Context</h2>");
    expect(html).toContain("chat-live-answer");
    expect(html).toContain("Only explicit public plans and observed tool facts are shown");
    expect(html).not.toContain("I am first understanding your question");
  });

  it("renders multiple public plans as an inline progress timeline", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ChatView
      changedFiles={[]}
      conversation={[]}
      dataSource="live"
      events={[{
        id: "decision-1",
        sequence: 1,
        kind: "decision",
        title: "Model decision",
        summary: "Inspect the repository structure",
        rationale: "Inspect the repository structure",
        timestamp: "04:12:03",
        state: "succeeded",
        operationId: "model-call-1",
      }, {
        id: "tool-1",
        sequence: 2,
        kind: "tool",
        title: "Tool completed",
        summary: "Read 24 lines",
        timestamp: "04:12:04",
        state: "succeeded",
        operationId: "operation-read",
      }, {
        id: "decision-2",
        sequence: 3,
        kind: "decision",
        title: "Model decision",
        summary: "Validate the answer against the source",
        rationale: "Validate the answer against the source",
        timestamp: "04:12:05",
        state: "succeeded",
        operationId: "model-call-2",
      }]}
      evidence={emptyEvidence}
      modelSurface={[{
        id: "surface:2",
        modelCallId: "model-call-2",
        cursor: 2,
        timestamp: "04:12:05",
        type: "public_plan_snapshot",
        status: "completed",
        text: "Validate the answer against the source",
      }]}
      outcome="Done"
      status="completed"
      task="Inspect the context implementation"
    /></LanguageProvider>);

    expect(html.match(/class="public-progress-item is-plan is-completed"/gu)).toHaveLength(2);
    expect(html).toContain("Inspect the repository structure");
    expect(html).toContain("Validate the answer against the source");
    expect(html).toContain("Read 24 lines");
    expect(html).not.toContain('class="chat-process');
  });

  it("keeps calibrated budget estimates distinct from provider-reported usage", () => {
    const contextBudget: ContextBudgetSnapshot = {
      modelCallId: "model_call_usage",
      windowTokens: 8_192,
      inputBudgetTokens: 7_168,
      usedTokens: 1_000,
      reservedOutputTokens: 1_024,
      warningThresholdTokens: 5_000,
      compressionThresholdTokens: 6_000,
      estimator: "heuristic_v2",
      status: "healthy",
      estimate: {
        estimatorId: "heuristic:openai:gpt-test:r3",
        confidence: "calibrated",
        inputTokens: 1_000,
        outputTokens: 512,
        cachedTokens: 120,
        perSection: { system: 100, goal: 100, history: 200, tool: 100, repo: 400, memory: 100 },
      },
      providerUsage: {
        modelCallId: "model_call_usage",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 1_320,
        outputTokens: 280,
        cachedInputTokens: 420,
        reasoningOutputTokens: 90,
        totalTokens: 1_600,
        requestKind: "initial",
        requestSequence: 1,
        estimatedInputTokens: 1_000,
        deltaRatio: 1.32,
        cost: { status: "provider_reported", amount: 0.0042, currency: "USD" },
        anomaly: true,
      },
    };
    const html = renderToStaticMarkup(<LanguageProvider><ChatView
      changedFiles={[]}
      contextBudget={contextBudget}
      conversation={[]}
      dataSource="live"
      events={[]}
      evidence={emptyEvidence}
      outcome="Done"
      status="completed"
      task="Inspect usage"
    /></LanguageProvider>);

    expect(html).toContain("Budget estimate");
    expect(html).toContain("Calibrated estimate");
    expect(html).toContain("heuristic:openai:gpt-test:r3");
    expect(html).toContain("Provider reported usage");
    expect(html).toContain("Cached input");
    expect(html).toContain("Reasoning output");
    expect(html).toContain("Reported cost");
    expect(html).toContain("0.0042 USD");
    expect(html).toContain("Usage anomaly");
  });
});
