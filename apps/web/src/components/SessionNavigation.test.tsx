import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StateNotice } from "../App";
import { createDemoSnapshot } from "../demo";
import { LanguageProvider } from "../i18n";
import { Sidebar } from "./Sidebar";

describe("durable session navigation", () => {
  it("renders session search, the selected durable session, resume, and delete controls", () => {
    const base = createDemoSnapshot("interrupted");
    const snapshot = {
      ...base,
      sessions: [{
        session_id: "session-durable",
        project_id: "project_fixture",
        created_at: "2026-09-18T00:00:00.000Z",
        updated_at: "2026-09-18T00:05:00.000Z",
        title: "Recover checkout investigation",
        run_ids: ["run-one"],
        entry_count: 3,
      }],
      selectedSessionId: "session-durable",
      sessionViewState: "restored" as const,
    };

    const html = renderToStaticMarkup(<LanguageProvider><Sidebar
      onChooseProject={vi.fn()}
      onDeleteSession={vi.fn()}
      onPreviewState={vi.fn()}
      onRemoveProject={vi.fn()}
      onResumeSession={vi.fn()}
      onReturnHome={vi.fn()}
      onSearchSessions={vi.fn()}
      onSelectProject={vi.fn()}
      onSelectSession={vi.fn()}
      snapshot={snapshot}
    /></LanguageProvider>);

    expect(html).toContain("Search sessions");
    expect(html).toContain("Recover checkout investigation");
    expect(html).toContain('aria-label="Resume session: Recover checkout investigation"');
    expect(html).toContain('aria-label="Delete session: Recover checkout investigation"');
  });

  it("makes interruption and restored-view state explicit without claiming a tool rerun", () => {
    const interrupted = renderToStaticMarkup(<LanguageProvider><StateNotice
      connectionMessage="connected"
      currentStep="Recovered after restart"
      indexedFiles={undefined}
      lastSequence={8}
      onRefresh={vi.fn()}
      onResumeSession={vi.fn()}
      onReview={vi.fn()}
      scanScope={undefined}
      sessionViewState="restored"
      status="interrupted"
    /></LanguageProvider>);
    expect(interrupted).toContain("Last session was interrupted");
    expect(interrupted).toContain("No tool was rerun automatically");
    expect(interrupted).toContain("Resume session");

    const restored = renderToStaticMarkup(<LanguageProvider><StateNotice
      connectionMessage="connected"
      currentStep="Completed"
      indexedFiles={undefined}
      lastSequence={9}
      onRefresh={vi.fn()}
      onResumeSession={vi.fn()}
      onReview={vi.fn()}
      scanScope={undefined}
      sessionViewState="restored"
      status="completed"
    /></LanguageProvider>);
    expect(restored).toContain("Recovered session view");
    expect(restored).toContain("Opening it did not execute tools");

    const diverged = renderToStaticMarkup(<LanguageProvider><StateNotice
      connectionMessage="connected"
      currentStep="Action hash diverged"
      indexedFiles={undefined}
      lastSequence={10}
      onRefresh={vi.fn()}
      onResumeSession={vi.fn()}
      onReview={vi.fn()}
      scanScope={undefined}
      sessionViewState={null}
      status="needs_manual_review"
    /></LanguageProvider>);
    expect(diverged).toContain("Needs manual review");
    expect(diverged).toContain("TraceGraph did not change files automatically");
    expect(diverged).not.toContain("Resume session");
  });
});
