// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchClient } from "../client";
import { LanguageProvider } from "../i18n";
import type { EvidenceSnapshot, ModelSurfaceSnapshot, RunStatus, TraceEvent } from "../model";
import { ChatView } from "./WorkbenchStates";

const evidence: EvidenceSnapshot = {
  context: { status: "not_present", message: "none" }, diff: { status: "not_present", message: "none" },
  graph: { status: "not_present", message: "none" }, test: { status: "not_present", message: "none" },
};
const candidate = (modelCallId = "candidate-call", text = "Everything is implemented and verified."): ModelSurfaceSnapshot => ({
  id: `answer:${modelCallId}`, modelCallId, type: "answer_snapshot", status: "completed", text,
  cursor: 90_000, timestamp: "2026-10-05T01:00:00Z",
});
const event = (sequence: number, sourceType: string, operationId?: string): TraceEvent => ({
  id: `event:${sequence}`, sequence, sourceType, kind: sourceType.startsWith("model.") ? "decision" : "run",
  title: sourceType === "workbench.command_completed" ? "Delivery review" : sourceType,
  summary: sourceType === "workbench.command_completed" ? "Independent readonly delivery review requested" : "Public operation recorded",
  timestamp: "01:00:00", state: sourceType === "model.request_started" ? "running" : "succeeded",
  ...(operationId ? { operationId } : {}),
});
const view = (status: RunStatus, options: { outcome?: string; events?: TraceEvent[]; modelSurface?: ModelSurfaceSnapshot[]; progressive?: boolean; client?: WorkbenchClient } = {}) => <LanguageProvider><ChatView
  runId="run:answer-authority" conversation={[]} changedFiles={[]} dataSource="live" evidence={evidence} task="Explain the result"
  status={status} events={options.events ?? []} modelSurface={options.modelSurface ?? [candidate()]} feedbackReadable feedbackWritable
  {...(options.outcome === undefined ? {} : { outcome: options.outcome })} {...(options.client ? { client: options.client } : {})}
  {...(options.progressive === undefined ? {} : { progressive: options.progressive })}
/></LanguageProvider>;
const markup = (status: RunStatus, options: Parameters<typeof view>[1] = {}) => {
  const node = document.createElement("div"); node.innerHTML = renderToStaticMarkup(view(status, options)); return node;
};
let node: HTMLDivElement | undefined, root: Root | undefined;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); localStorage.setItem("tracegraph.language", "en"); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; node?.remove(); node = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Public answer authority", () => {
  it.each(["completed", "historical", "ready_for_review"] as const)("renders durable %s output instead of a conflicting volatile answer", (status) => {
    const html = markup(status, { outcome: "Durable verified answer", progressive: true });
    expect(html.querySelector(".chat-answer")?.textContent).toBe("Durable verified answer");
    expect(html.textContent).not.toContain(candidate().text);
    expect(html.querySelector(".chat-live-answer")).toBeNull();
  });
  it.each(["completed", "historical", "ready_for_review"] as const)("does not infer verified results from a canonical %s state without an outcome", (status) => {
    const completion = event(1, "run.completed");
    for (const language of ["en", "zh-CN"] as const) {
      localStorage.setItem("tracegraph.language", language);
      const html = markup(status, { events: [completion], progressive: true });
      expect(html.querySelector(".chat-answer")?.textContent).toBe(language === "zh-CN"
        ? "暂无最终回答，请查看已记录的任务活动。"
        : "The final response is unavailable. Inspect recorded task activity.");
      expect(html.textContent).not.toContain(candidate().text);
      expect(html.querySelector(".chat-live-answer")).toBeNull();
      expect(html.querySelector(".chat-answer")?.textContent).not.toMatch(/verified|已验证|并验证/u);
    }
  });
  it.each(["failed", "cancelled", "interrupted", "needs_manual_review"] as const)("keeps the durable %s error instead of an earlier success candidate", (status) => {
    const html = markup(status, { outcome: "Verification failed; human continuation is required.", progressive: true });
    expect(html.querySelector(".chat-turn-failure pre")?.textContent).toBe("Verification failed; human continuation is required.");
    expect(html.textContent).not.toContain(candidate().text);
    expect(html.querySelector('[aria-label="Helpful answer"]')).toBeNull();
  });
  it("hides the first finish candidate while its canonical decision is followed by blocked delivery review", () => {
    const html = markup("running", { events: [event(1, "model.request_started", "candidate-call"), event(2, "model.decision", "candidate-call"), event(3, "workbench.command_completed")] });
    expect(html.textContent).not.toContain("Independent readonly delivery review requested"); // Internal command lifecycle is diagnostic, never public narration.
    expect(html.textContent).not.toContain(candidate().text);
    expect(html.querySelector(".agent-message .message-actions")).toBeNull();
    expect(html.querySelector(".chat-live-answer")).toBeNull();
  });
  it("does not reuse a delayed earlier surface after a newer canonical model request", () => {
    const html = markup("running", { events: [event(1, "model.request_started", "candidate-call"), event(2, "model.request_started", "repair-call")] });
    expect(html.textContent).not.toContain(candidate().text);
    // The surface cursor is intentionally far larger than ledger sequence: they are different clocks.
    const current = markup("running", { events: [event(1, "model.request_started", "candidate-call"), event(2, "model.decision", "candidate-call"), event(3, "model.request_started", "repair-call")], modelSurface: [candidate(), { ...candidate("repair-call", "I am checking the updated answer."), cursor: 1, status: "streaming" }] });
    expect(current.querySelector(".chat-live-answer")?.textContent).toContain("I am checking the updated answer.");
    expect(current.textContent).not.toContain(candidate().text);
  });
  it.each(["model.output_invalid", "model.request_failed"])("discards a candidate whose own call has %s", (type) => {
    const html = markup("running", { events: [event(1, "model.request_started", "candidate-call"), event(2, type, "candidate-call")] });
    expect(html.querySelector(".chat-live-answer")).toBeNull();
    expect(html.textContent).not.toContain(candidate().text);
  });
  it("keeps an ordinary knowledge stream clearly provisional and uses its durable result on completion", () => {
    const answer = "A bounded context contains only selected inputs.";
    const html = markup("running", { events: [event(1, "model.request_started", "candidate-call")], modelSurface: [{ ...candidate("candidate-call", answer), status: "streaming" }] });
    expect(html.querySelector(".chat-live-answer")?.textContent).toContain(answer);
    expect(html.querySelector(".chat-live-answer")?.textContent).toContain("Answer draft — not verified");
    expect(html.querySelector(".agent-message .message-actions")).toBeNull();
    expect(markup("completed", { outcome: answer }).querySelector(".chat-answer")?.textContent).toBe(answer);
  });
  it("allows explicitly labelled compatibility drafts without model-operation history but never private thinking", () => {
    const html = markup("running", { modelSurface: [{ ...candidate(), status: "streaming" }, { ...candidate("private", "PRIVATE_REASONING_SENTINEL"), type: "thinking_snapshot" }] });
    expect(html.querySelector(".chat-live-answer")?.textContent).toContain(candidate().text);
    expect(html.textContent).toContain("Answer draft — not verified");
    expect(html.textContent).not.toContain("PRIVATE_REASONING_SENTINEL");
    expect(html.querySelector(".agent-message .message-actions")).toBeNull();
  });
  it("does not revive a failed surface or place a stale answer over an exact approval gate", () => {
    expect(markup("running", { modelSurface: [{ ...candidate(), status: "failed" }] }).querySelector(".chat-live-answer")).toBeNull();
    const html = markup("needs_approval");
    expect(html.textContent).toContain("A scoped patch preview is waiting");
    expect(html.textContent).not.toContain(candidate().text);
  });
  it("replaces a mounted progressive draft immediately on review and terminal changes without copying or rating it", async () => {
    vi.useFakeTimers(); const getFeedback = vi.fn(async () => ({ run_id: "run:answer-authority", value: "clear" as const }));
    const client = { getAnswerFeedback: getFeedback } as unknown as WorkbenchClient;
    node = document.createElement("div"); document.body.append(node); root = createRoot(node);
    await act(async () => root!.render(view("running", { progressive: true, client })));
    await act(async () => { await vi.advanceTimersByTimeAsync(280); });
    expect(node.querySelector(".chat-live-answer")?.textContent).toContain("Answer draft — not verified");
    expect(node.querySelector(".agent-message .message-actions")).toBeNull(); expect(getFeedback).not.toHaveBeenCalled();
    await act(async () => root!.render(view("running", { progressive: true, client, events: [event(1, "model.decision", "candidate-call"), event(2, "workbench.command_completed")] })));
    expect(node.querySelector(".chat-answer")?.textContent).toBe("");
    await act(async () => root!.render(view("failed", { progressive: true, client, outcome: "Canonical verification error" })));
    expect(node.querySelector(".chat-turn-failure pre")?.textContent).toBe("Canonical verification error");
    expect(node.textContent).not.toContain(candidate().text); expect(getFeedback).not.toHaveBeenCalled();
    await act(async () => root!.render(view("completed", { progressive: true, client, outcome: "Canonical final answer" })));
    expect(node.querySelector(".chat-answer")?.textContent).toBe("Canonical final answer");
    expect(node.querySelector(".chat-live-answer")).toBeNull(); expect(getFeedback).toHaveBeenCalledOnce();
  });
});
