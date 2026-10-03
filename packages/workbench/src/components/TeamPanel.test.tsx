import { TeamProjectionSchema } from "@tracegraph/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import { didSteerSucceed, steerDraftAfterDelivery, TeamPanel } from "./TeamPanel";

const NOW = "2026-09-20T00:00:00.000Z";

const team = TeamProjectionSchema.parse({
  team_id: "team:one",
  coordinator_run_id: "run:root",
  limits: {
    max_parallel_workers: 2,
    heartbeat_timeout_ms: 30_000,
    max_members: 10,
    max_mailbox_messages: 100,
    max_tasks: 100,
  },
  created_event_id: "event:team-created",
  created_at: NOW,
  roster: {
    members: [{
      link: {
        subagent_id: "subagent:worker",
        parent_run_id: "run:root",
        parent_session_id: "session:root",
        child_run_id: "run:child",
        child_session_id: "session:child",
      },
      role: "Verifier",
      status: "active",
      joined_at: NOW,
      last_heartbeat_at: NOW,
    }],
    last_sequence: 2,
  },
  mailbox: {
    messages: [{
      message_id: "message:one",
      from: "coordinator",
      to: "subagent:worker",
      kind: "steer",
      payload: "Verify the concurrency invariant.",
      delivered_at: NOW,
    }],
    last_sequence: 4,
  },
  task_board: {
    items: [{
      task_id: "task:one",
      title: "Run the concurrency check",
      state: "claimed",
      owner: "subagent:worker",
      acceptance: ["Only one claim succeeds"],
      evidence_event_ids: [],
      version: 2,
      created_at: NOW,
      updated_at: NOW,
    }],
    last_sequence: 5,
  },
  last_sequence: 5,
});

describe("TeamPanel", () => {
  it("renders the durable roster, task board, mailbox, and bounded controls", () => {
    const html = renderToStaticMarkup(<LanguageProvider><TeamPanel
      onCancelTask={vi.fn()}
      onCreate={vi.fn()}
      onSteer={vi.fn(async () => true)}
      team={team}
    /></LanguageProvider>);

    expect(html).toContain("Agent team");
    expect(html).toContain("Verifier");
    expect(html).toContain("Run the concurrency check");
    expect(html).toContain("Only one claim succeeds");
    expect(html).toContain("Verify the concurrency invariant.");
    expect(html).toContain("Cancel task");
    expect(html).toContain("Send steer");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("offers explicit creation without inventing a Team projection", () => {
    const html = renderToStaticMarkup(<LanguageProvider><TeamPanel
      onCancelTask={vi.fn()}
      onCreate={vi.fn()}
      onSteer={vi.fn(async () => true)}
    /></LanguageProvider>);

    expect(html).toContain("No durable Team has been created");
    expect(html).toContain("Create team");
  });

  it("keeps replay and terminal snapshots readable while disabling mutations", () => {
    const reason = "Replay is read-only. Return to now to make changes.";
    const html = renderToStaticMarkup(<LanguageProvider><TeamPanel
      disabled
      disabledReason={reason}
      onCancelTask={vi.fn()}
      onCreate={vi.fn()}
      onSteer={vi.fn(async () => true)}
      team={team}
    /></LanguageProvider>);

    expect(html).toContain(reason);
    expect(html).toContain("Verify the concurrency invariant.");
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("clears a steer draft only after a confirmed successful Host operation", async () => {
    await expect(didSteerSucceed(async () => true)).resolves.toBe(true);
    await expect(didSteerSucceed(async () => false)).resolves.toBe(false);
    await expect(didSteerSucceed(async () => { throw new Error("response lost"); })).resolves.toBe(false);
    expect(steerDraftAfterDelivery(" Retry this ", "Retry this", true)).toBe("");
    expect(steerDraftAfterDelivery(" Retry this ", "Retry this", false)).toBe(" Retry this ");
    expect(steerDraftAfterDelivery("Newer text", "Retry this", true)).toBe("Newer text");
  });
});
