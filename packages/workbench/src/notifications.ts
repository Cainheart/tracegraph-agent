import type { WorkbenchNotification, WorkbenchSettingsValues } from "@tracegraph/contracts";

type Preferences = Pick<WorkbenchSettingsValues["general"], "notify_completed" | "notify_failed" | "notify_approval">;
function enabled(event: WorkbenchNotification, preferences: Preferences | undefined): boolean {
  if (!preferences) return false;
  if (event.status === "completed") return preferences.notify_completed;
  if (event.status === "failed" || event.status === "interrupted") return preferences.notify_failed;
  return preferences.notify_approval;
}

/** Consume only canonical notification facts. A connection's initial history never emits OS alerts. */
export function createNotificationTracker() {
  const seen = new Set<string>();
  let initialized = false;
  return (events: readonly WorkbenchNotification[], preferences?: Preferences) => {
    const distinct = [...new Map(events.map((event) => [event.notification_id, event])).values()];
    const fresh = initialized ? distinct.filter((event) => !seen.has(event.notification_id)) : [];
    for (const event of distinct) seen.add(event.notification_id);
    // Host bounds each projection to 128. Retain a bounded ID-only deduplication window.
    while (seen.size > 4_096) seen.delete(seen.values().next().value!);
    initialized = true;
    return { visible: distinct.filter((event) => enabled(event, preferences)), alerts: fresh.filter((event) => enabled(event, preferences)) };
  };
}
