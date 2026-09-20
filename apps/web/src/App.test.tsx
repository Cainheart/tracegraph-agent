import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, replayDirectionForKeyboard, replayTargetForEventSelection } from "./App";
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
  it.each(["running", "indexing", "awaiting_plan_approval", "needs_approval"] as const)(
    "keeps queue-mode input available while the Run is %s",
    (status) => {
      const html = renderToStaticMarkup(<App client={staticClient(status)} />);
      expect(html).toContain('aria-label="Steer this run"');
      expect(html).toContain("Will be sent at the next step");
      expect(html).not.toMatch(/aria-label="Steer this run" disabled=""/u);
    },
  );

  it("allows steering for a read-only project because the input mutates only the Run ledger", () => {
    const html = renderToStaticMarkup(<App client={staticClient("running", "readonly_local")} />);
    expect(html).toContain('aria-label="Steer this run"');
    expect(html).not.toMatch(/aria-label="Steer this run" disabled=""/u);
  });

  it.each(["interrupted", "needs_manual_review"] as const)(
    "keeps recovered queue state visible but disables steering while the Run is %s",
    (status) => {
      const html = renderToStaticMarkup(<App client={staticClient(status)} />);
      expect(html).toContain('aria-label="Steer this run" disabled=""');
    },
  );

  it("disables both composer steering and the header stop action while reconnecting", () => {
    const html = renderToStaticMarkup(<App client={staticClient("reconnecting")} />);
    expect(html).toContain('aria-label="Steer this run" disabled=""');
    expect(html).toMatch(/class="button subtle stop-button" disabled=""/u);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "does not submit steering to a terminal %s Run",
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
    expect(html).toMatch(/class="button subtle stop-button" disabled=""/u);
    expect(html).toMatch(/class="button danger" disabled=""/u);
    expect(html).toContain('aria-label="Steer this run" disabled=""');
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

  it("keeps canonical event clicks wired to replay while already time travelling", () => {
    expect(replayTargetForEventSelection("live", 3)).toBe(3);
    expect(replayTargetForEventSelection("demo", 3)).toBeNull();
  });
});
