import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, hasTestOutput, replayDirectionForKeyboard, replayTargetForEventSelection } from "./App";
import type { WorkbenchClient } from "./client";
import { createDemoSnapshot } from "./demo";
import type { RunStatus, WorkspaceKind } from "./model";

function staticClient(status: RunStatus, workspaceKind: WorkspaceKind = "disposable_fixture"): WorkbenchClient {
  const snapshot = createDemoSnapshot(status, workspaceKind, status === "awaiting_plan_approval" ? "plan" : "execute");
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  } as unknown as WorkbenchClient;
}

describe("G14 runtime composer", () => {
  it("shows test output only for actual available content or a readable artifact", () => {
    expect(hasTestOutput({ status: "available", message: "Verified", content: "" })).toBe(true);
    expect(hasTestOutput({ status: "available", message: "Verified", artifactId: "artifact:log" })).toBe(true);
    for (const status of ["loading", "corrupt", "unavailable", "not_present"] as const) expect(hasTestOutput({ status, message: "Not readable", artifactId: "artifact:unreadable" })).toBe(false);
    const snapshot = createDemoSnapshot("completed");
    const client = { getSnapshot: () => ({ ...snapshot, evidence: { ...snapshot.evidence, test: { status: "not_present" as const, message: "No test" } } }), subscribe: () => () => undefined } as unknown as WorkbenchClient;
    expect(renderToStaticMarkup(<App client={client} />)).not.toContain("Test output");
  });
  it("marks deterministic workbench state as Preview instead of local Host state", () => {
    const html = renderToStaticMarkup(<App client={staticClient("needs_approval")} />);
    expect(html).toContain("Preview");
    expect(html).toContain("Preview · deterministic example data");
    expect(html).toContain("Outlive");
    expect(html).not.toContain('aria-label="Workbench views"');
    expect(html).not.toContain('aria-label="Pinned sessions"');
    expect(html).not.toContain("compact-gate");
    expect(html).not.toMatch(/host-chip connection-live[^>]*><i \/>Local/u);
  });

  it.each(["running", "indexing", "awaiting_plan_approval", "needs_approval"] as const)(
    "opens the conversation and anchored steering controls while the Run is %s",
    (status) => {
      const html = renderToStaticMarkup(<App client={staticClient(status)} />);
      expect(html).toContain('aria-label="Steer this run"');
      expect(html).not.toContain('aria-label="New task"');
      expect(html).not.toContain("Attach image or PDF");
    },
  );

  it("allows guidance for a read-only project without enabling file writes", () => {
    const html = renderToStaticMarkup(<App client={staticClient("running", "readonly_local")} />);
    expect(html).toContain('aria-label="Steer this run"');
    expect(html).not.toContain('aria-label="New task"');
  });

  it.each(["interrupted", "needs_manual_review"] as const)(
    "keeps recovered conversation visible and disables guidance while the Run is %s",
    (status) => {
      const html = renderToStaticMarkup(<App client={staticClient(status)} />);
      expect(html).toContain('aria-label="Steer this run"');
    },
  );

  it("keeps reconnecting conversation visible while disabling stop and guidance", () => {
    const html = renderToStaticMarkup(<App client={staticClient("reconnecting")} />);
    expect(html).toContain('aria-label="Steer this run"');
    expect(html).toMatch(/class="composer-stop" disabled=""/u);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "renders a follow-up composer for a terminal %s Run",
    (status) => {
      const html = renderToStaticMarkup(<App client={staticClient(status)} />);
      expect(html).not.toContain('aria-label="Steer this run"');
      expect(html).toContain('aria-label="New task"');
    },
  );
});

describe("G23 replay workbench", () => {
  it("renders a prominent read-only replay surface and disables Run mutations", () => {
    const snapshot = {
      ...createDemoSnapshot("needs_approval", "disposable_fixture", "execute"),
      dataSource: "live" as const,
      replay: {
        state: "active" as const,
        runId: "run-demo",
        requestedSequence: 4,
        headSequence: 8,
        availableSequences: [1, 2, 3, 4, 5, 6, 7, 8],
        projectionHash: `sha256:${"b".repeat(64)}`,
      },
    };
    const client = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    } as unknown as WorkbenchClient;

    const html = renderToStaticMarkup(<App client={client} />);

    expect(html).toContain('aria-label="Replay mode"');
    expect(html).toContain("#4 / #8");
    expect(html).toContain("Return to now");
    expect(html).toMatch(/class="composer-stop" disabled=""/u);
    expect(html).toMatch(/class="button danger" disabled=""/u);
    expect(html).toContain('aria-label="Steer this run"');
    expect(html).toContain('textarea aria-label="Steer this run" disabled=""');
    expect(html).toContain("Replay is read-only. Return to now to make changes.");
  });

  it("maps unmodified arrow keys to replay steps without hijacking editors or IME", () => {
    expect(replayDirectionForKeyboard({ key: "ArrowLeft" })).toBe(-1);
    expect(replayDirectionForKeyboard({ key: "ArrowRight" })).toBe(1);
    expect(replayDirectionForKeyboard({ key: "ArrowRight", targetTagName: "textarea" })).toBeNull();
    expect(replayDirectionForKeyboard({ key: "ArrowLeft", targetContentEditable: true })).toBeNull();
    expect(replayDirectionForKeyboard({ key: "ArrowLeft", isComposing: true })).toBeNull();
    expect(replayDirectionForKeyboard({ key: "ArrowLeft", metaKey: true })).toBeNull();
    expect(replayDirectionForKeyboard({ key: "Enter" })).toBeNull();
  });

  it("maps the explicit replay action to a canonical sequence", () => {
    expect(replayTargetForEventSelection("live", 3)).toBe(3);
    expect(replayTargetForEventSelection("demo", 3)).toBeNull();
  });
});
