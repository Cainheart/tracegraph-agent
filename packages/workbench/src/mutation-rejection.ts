/** HTTP status alone never proves whether an effect happened. These are closed
 * Host precondition refusals, not timeouts or an unknown browser/Run effect. */
export function mutationWasRejected(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { admission?: unknown; status?: unknown; body?: { error?: unknown } };
  if (value.admission === "rejected") return true;
  if (typeof value.status !== "number" || value.status < 400 || value.status >= 500 || typeof value.body?.error !== "string") return false;
  return ["browser_revision_conflict", "browser_origin_denied", "browser_grant_inactive", "browser_human_control", "browser_target_stale", "browser_runtime_unavailable", "browser_tab_scope", "browser_plan_readonly", "browser_user_operation", "browser_grant_denied", "browser_grant_ui_unavailable", "goal_revision_conflict", "goal_approval_required", "goal_approval_revision_mismatch", "goal_budget_below_spent", "goal_terminal", "goal_not_running", "goal_active", "goal_start_state_invalid", "goal_scope_immutable", "goal_done_conditions_unaccepted", "goal_not_ready_for_acceptance", "personal_profile_revision_conflict", "computer_grant_required", "computer_grant_denied", "computer_grant_missing", "computer_grant_limit", "computer_locked", "computer_accessibility_required", "computer_capture_required", "computer_monitor_required", "computer_input_busy", "computer_input_not_confirmed", "computer_confirmation_timeout", "computer_lease_expired", "computer_lease_not_paused", "computer_lease_missing", "computer_lease_conflict", "computer_input_paused", "computer_plan_readonly", "computer_target_changed", "goal_unknown_write_unresolved", "goal_usage_acknowledgement_required"].includes(value.body.error);
}
