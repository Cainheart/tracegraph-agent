import { describe, expect, it } from "vitest";
import type { WorkbenchNotification } from "@tracegraph/contracts";
import { createNotificationTracker } from "./notifications";
const preferences = { notify_completed: true, notify_failed: true, notify_approval: true };
const event = (id: string, status: WorkbenchNotification["status"]): WorkbenchNotification => ({ notification_id: id, event_id: `event:${id}`, run_id: "run:actual", project_id: "project:actual", session_id: "session:actual", task: "A bounded task", status, occurred_at: "2026-10-03T00:00:00.000Z" });
describe("canonical notification tracking", () => {
  it("shows initial history silently and alerts a new terminal event once without requiring an active Run", () => {
    const read = createNotificationTracker(), approval = event("notification:approval", "awaiting_approval"), completion = event("notification:complete", "completed");
    expect(read([approval, approval], preferences)).toEqual({ visible: [approval], alerts: [] });
    expect(read([approval, completion], preferences)).toEqual({ visible: [approval, completion], alerts: [completion] });
    expect(read([approval, completion], preferences).alerts).toEqual([]);
    expect(createNotificationTracker()([approval, completion], preferences).alerts).toEqual([]);
  });
  it("uses the three actual preferences and never re-alerts disabled backlog when preferences change", () => {
    const read = createNotificationTracker(); read([], preferences);
    const completed = event("notification:complete", "completed"), failed = event("notification:failed", "failed"), approval = event("notification:plan", "awaiting_plan_approval");
    expect(read([completed, failed, approval], { ...preferences, notify_completed: false, notify_approval: false })).toEqual({ visible: [failed], alerts: [failed] });
    expect(read([completed, failed, approval], preferences)).toEqual({ visible: [completed, failed, approval], alerts: [] });
    expect(read([completed, failed, approval, event("notification:interrupted", "interrupted")], { ...preferences, notify_failed: false }).visible).toEqual([completed, approval]);
  });
});
