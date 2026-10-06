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
    const html = renderToStaticMarkup(<LanguageProvider><ProjectReady connection={{ state: "live", message: "Connected", lastSequence: 0 }} projectName="fixture"
      onReasoningEffortChange={vi.fn()}
      onStart={vi.fn()}
      readonly
      reasoningEffort="low"
    /></LanguageProvider>);
    expect(html).toContain('>Plan</button>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Execute is unavailable for a read-only project"[^>]*>.*Execute<\/button>/u);
  });

  it("keeps a selected project's empty state aligned with the shared bottom composer", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ProjectReady connection={{ state: "live", message: "Connected", lastSequence: 0 }} projectName="fixture"
      composer={<div className="unified-composer" />}
      readonly={false}
      onReasoningEffortChange={vi.fn()}
      onStart={vi.fn()}
      reasoningEffort="low"
    /></LanguageProvider>);
    expect(html).toContain("Start using Outlive");
    expect(html).toContain('class="unified-composer"');
    expect(html).not.toContain("entry-suggestions");
    expect(html).not.toContain("Your permission policy applies to every tool call");
    expect(html).not.toContain("Describe a task. Your agent can inspect");
  });

  it("renders actual durable tool facts without inventing a model thought narration", () => {
    const events: TraceEvent[] = [{
      id: "event-read-started",
      sequence: 4,
      kind: "tool",
      sourceType: "tool.started",
      title: "Tool started",
      summary: "Reading apps/web/src/App.tsx",
      timestamp: "04:12:03",
      state: "running",
      operationId: "operation-read",
      toolName: "read_file",
      target: "apps/web/src/App.tsx",
      input: "do-not-render-tool-input",
      output: "do-not-render-tool-output",
    }, {
      id: "event-read-completed",
      sequence: 5,
      kind: "tool",
      sourceType: "tool.completed",
      title: "Tool completed",
      summary: "Read 120 lines",
      timestamp: "04:12:04",
      state: "succeeded",
      operationId: "operation-read",
      toolName: "read_file",
    }];
    const html = renderToStaticMarkup(<LanguageProvider><ChatView changedFiles={[]} conversation={[]} dataSource="live" events={events} evidence={emptyEvidence} outcome="Done" status="completed" task="Introduce the project" /></LanguageProvider>);
    expect(html).toContain("Task process");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Read 120 lines"); // completed process is closed and lazy by default
    expect(html).not.toContain("do-not-render-tool-input");
    expect(html).not.toContain("do-not-render-tool-output");
    expect(html).not.toContain("Only explicit public plans and observed tool facts are shown");
    expect(html).not.toContain("I have read apps/web/src/App.tsx");
  });

  it("places copy and feedback actions outside the message bubbles", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ChatView
      changedFiles={[]} conversation={[]} dataSource="live" events={[]} evidence={emptyEvidence}
      outcome="A verified answer." status="completed" task="A question"
    /></LanguageProvider>);
    const userMessage = html.match(/<article class="chat-message user-message"[\s\S]*?<\/article>/u)?.[0];
    const agentMessage = html.match(/<article class="chat-message agent-message[^"]*"[\s\S]*?<\/article>/u)?.[0];
    expect(userMessage).toMatch(/<div class="chat-turn-body">[\s\S]*?<\/div><div class="message-actions">/u);
    expect(agentMessage).toMatch(/<div class="chat-turn-body">[\s\S]*?<\/div><div class="message-actions">/u);
  });

  it("offers the exact supported reasoning effort values with readable labels", () => {
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
      sourceType: "model.request_started",
      operationId: "model-call-1",
    }, {
      id: "decision",
      sequence: 2,
      kind: "decision",
      title: "Model decision",
      summary: "Inspect the repository before answering",
      rationale: "Inspect the repository before answering",
      publicPlan: "Inspect the repository before answering",
      timestamp: "04:12:04",
      state: "succeeded",
      sourceType: "model.decision",
      operationId: "model-call-1",
    }];
    const html = renderToStaticMarkup(<LanguageProvider><ChatView changedFiles={[]} conversation={[]} dataSource="live" events={events} evidence={emptyEvidence} outcome="Done" status="running" task="Introduce the project" /></LanguageProvider>);
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
    expect(html).not.toContain("Searching the repository for ContextBuilder"); // no narration inferred from generic summary
    expect(html).toContain("streaming");
    expect(html).toContain("chat-public-statement");
    expect(html).not.toContain("I found the context boundary and will verify its budget calculation.");
    expect(html).toContain("<h2>Context</h2>");
    expect(html).toContain("chat-live-answer");
    expect(html).not.toContain("Only explicit public plans and observed tool facts are shown");
    expect(html).not.toContain("I am first understanding your question");
  });

  it("renders multiple public statements in order with collapsed tool groups", () => {
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
        publicPlan: "Inspect the repository structure",
        timestamp: "04:12:03",
        state: "succeeded",
        sourceType: "model.decision",
        operationId: "model-call-1",
      }, {
        id: "tool-1",
        sequence: 2,
        kind: "tool",
        sourceType: "tool.completed",
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
        publicPlan: "Validate the answer against the source",
        timestamp: "04:12:05",
        state: "succeeded",
        sourceType: "model.decision",
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
      status="running"
      task="Inspect the context implementation"
    /></LanguageProvider>);

    expect(html.match(/class="chat-public-statement"/gu)).toHaveLength(2);
    expect(html).toContain("Inspect the repository structure");
    expect(html).toContain("Validate the answer against the source");
    expect(html).not.toContain("Read 24 lines");
    expect(html).toContain('class="chat-process');
  });

  it("does not turn policy explanations into model plans", () => {
    const html = renderToStaticMarkup(<LanguageProvider><ChatView
      changedFiles={[]}
      conversation={[]}
      dataSource="live"
      events={[{
        id: "policy",
        sequence: 1,
        kind: "decision",
        title: "Policy evaluated",
        summary: "Permission preset workspace-write allows this Tool action",
        rationale: "Permission preset workspace-write allows this Tool action",
        sourceType: "policy.evaluated",
        timestamp: "04:12:03",
        state: "succeeded",
      }, {
        id: "model",
        sequence: 2,
        kind: "decision",
        title: "Model decision",
        summary: "Inspect the repository before answering",
        publicPlan: "Inspect the repository before answering",
        sourceType: "model.decision",
        timestamp: "04:12:04",
        state: "succeeded",
        operationId: "model-call-1",
      }]}
      evidence={emptyEvidence}
      outcome="Done"
      status="completed"
      task="Inspect the project"
    /></LanguageProvider>);

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Policy");
    expect(html).not.toContain("深度思考");
  });

  it("shows runtime and context usage before collapsible task diagnostics", () => {
    const contextBudget: ContextBudgetSnapshot = {
      modelCallId: "model_call_usage",
      windowTokens: 8_192,
      inputBudgetTokens: 7_168,
      usedTokens: 1_000,
      reservedOutputTokens: 1_024,
      warningThresholdTokens: 5_000,
      compressionThresholdTokens: 6_000,
      estimator: "heuristic_v2",
      status: "compressed",
      estimate: {
        estimatorId: "heuristic:openai:gpt-test:r3",
        confidence: "calibrated",
        inputTokens: 1_000,
        outputTokens: 512,
        cachedTokens: 120,
        perSection: { system: 100, goal: 100, history: 200, tool: 100, repo: 400, memory: 100, experience: 0 },
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
      elapsed="00:05"
      outcome="Done"
      runDetails={<p>Full run diagnostics</p>}
      status="completed"
      task="Inspect usage"
    /></LanguageProvider>);

    expect(html).toContain('class="chat-run-summary"');
    expect(html).toContain("Run 00:05");
    expect(html).toContain("Context 1K / 7.2K");
    expect(html).toContain("Compressed");
    expect(html).not.toContain("context-budget-strip");
    expect(html).not.toContain("Budget estimate");
    expect(html).not.toContain("Provider reported usage");
    expect(html).not.toContain("heuristic:openai:gpt-test:r3");
    expect(html).not.toContain("Usage anomaly");
    const diagnosticsStart = html.indexOf('<details class="turn-diagnostics">');
    const diagnosticsEnd = html.indexOf("</details>", diagnosticsStart);
    expect(html.indexOf('class="chat-run-summary"')).toBeGreaterThan(html.indexOf('class="chat-answer"'));
    expect(html.indexOf('class="chat-run-summary"')).toBeGreaterThan(html.indexOf('class="chat-evidence"'));
    expect(diagnosticsStart).toBeGreaterThan(html.indexOf('class="chat-run-summary"'));
    expect(diagnosticsStart).toBeGreaterThanOrEqual(0);
    expect(html.slice(diagnosticsStart, diagnosticsEnd)).toContain("Full run diagnostics");
    expect(html.slice(diagnosticsStart, diagnosticsEnd)).not.toContain("chat-run-summary");
    expect(html.slice(diagnosticsStart, diagnosticsEnd)).not.toContain("open=");
  });
});
