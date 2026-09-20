import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import { PlanApprovalBanner } from "./PlanApprovalBanner";
import { TodoPanel } from "./TodoPanel";

const todos = [
  {
    todo_id: "todo_inspect",
    title: "Inspect the current behavior",
    state: "done" as const,
    depends_on: [],
    evidence_event_ids: ["event_read"],
    created_by: "model" as const,
  },
  {
    todo_id: "todo_verify",
    title: "Verify the change",
    detail: "Run the bounded test suite.",
    state: "in_progress" as const,
    depends_on: ["todo_inspect"],
    evidence_event_ids: ["event_test"],
    created_by: "user" as const,
  },
];

describe("TodoPanel", () => {
  it("renders state, dependencies, evidence links, and user update controls", () => {
    const html = renderToStaticMarkup(<LanguageProvider><TodoPanel
      onSelectEvidence={vi.fn()}
      onStateChange={vi.fn()}
      todos={todos}
    /></LanguageProvider>);

    expect(html).toContain("Inspect the current behavior");
    expect(html).toContain("Verify the change");
    expect(html).toContain("event_test");
    expect(html).toContain("todo-state-in_progress");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("<select");
  });

  it("shows the exact plan revision in the approval banner", () => {
    const html = renderToStaticMarkup(<LanguageProvider><PlanApprovalBanner
      busy={false}
      eventId="event_plan_ready"
      onApprove={vi.fn()}
      todos={todos}
    /></LanguageProvider>);

    expect(html).toContain("event_plan_ready");
    expect(html).toContain("Approve and execute");
    expect(html).toContain("2");
  });

  it("explains why Todo controls are disabled after a Run stops", () => {
    const reason = "Todo changes are unavailable after the Run has stopped.";
    const html = renderToStaticMarkup(<LanguageProvider><TodoPanel
      disabled
      disabledReason={reason}
      onSelectEvidence={vi.fn()}
      onStateChange={vi.fn()}
      todos={todos}
    /></LanguageProvider>);

    expect(html).toContain(reason);
    expect(html).toContain("role=\"status\"");
    expect(html.match(/disabled=""/gu)).toHaveLength(4);
  });

  it("disables exact plan approval while a Todo mutation is in flight", () => {
    const html = renderToStaticMarkup(<LanguageProvider><PlanApprovalBanner
      busy={false}
      disabled
      eventId="event_plan_ready"
      onApprove={vi.fn()}
      todos={todos}
    /></LanguageProvider>);

    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Approve and execute");
  });
});
