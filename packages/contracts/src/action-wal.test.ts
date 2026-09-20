import { describe, expect, it } from "vitest";
import {
  ActionWalRecordSchema,
  RecoveryAttemptRecordSchema,
} from "./action-wal.js";

const hash = `sha256:${"a".repeat(64)}`;

describe("Action WAL contracts", () => {
  it("requires exact backups for existing targets and rejects duplicate paths", () => {
    const base = {
      wal_version: 1,
      wal_id: "wal:1",
      sequence: 1,
      project_id: "project:test",
      run_id: "run:test",
      action_id: "action:test",
      workspace_handle_id: "workspace:test",
      workspace_root_hash: hash,
      workspace_kind: "managed_local",
      patch_hash: hash,
      phase: "prepare",
      recorded_at: "2026-09-18T00:00:00.000Z",
      recovered: false,
      record_hash: hash,
    };

    expect(ActionWalRecordSchema.safeParse({
      ...base,
      targets: [{
        target_path: "src/a.ts",
        existed: true,
        before_hash: hash,
        after_hash: hash,
        backup_ref: "backup:1",
      }],
    }).success).toBe(true);

    expect(ActionWalRecordSchema.safeParse({
      ...base,
      targets: [{
        target_path: "src/a.ts",
        existed: true,
        before_hash: hash,
        after_hash: hash,
      }],
    }).success).toBe(false);

    expect(ActionWalRecordSchema.safeParse({
      ...base,
      phase: "committed",
      targets: [{
        target_path: "src/a.ts",
        existed: true,
        before_hash: hash,
        after_hash: hash,
        backup_ref: "backup:1",
      }],
    }).success).toBe(false);

    expect(ActionWalRecordSchema.safeParse({
      ...base,
      targets: [
        {
          target_path: "src/a.ts",
          existed: true,
          before_hash: hash,
          after_hash: hash,
          backup_ref: "backup:1",
        },
        {
          target_path: "src/a.ts",
          existed: false,
          before_hash: hash,
          after_hash: hash,
        },
      ],
    }).success).toBe(false);
  });

  it("requires terminal recovery timestamps and state-specific evidence", () => {
    const base = {
      recovery_version: 1,
      record_id: "recovery-record:1",
      recovery_id: "recovery:1",
      sequence: 1,
      project_id: "project:test",
      run_id: "run:test",
      action_id: "action:test",
      recipe_id: "replay_missing_event",
      attempt: 1,
      automatic: true,
      started_at: "2026-09-18T00:00:00.000Z",
      recorded_at: "2026-09-18T00:00:01.000Z",
      record_hash: hash,
    };

    expect(RecoveryAttemptRecordSchema.safeParse({
      ...base,
      state: "failed",
      finished_at: "2026-09-18T00:00:01.000Z",
    }).success).toBe(false);
    expect(RecoveryAttemptRecordSchema.safeParse({
      ...base,
      state: "escalated",
      finished_at: "2026-09-18T00:00:01.000Z",
    }).success).toBe(false);
    expect(RecoveryAttemptRecordSchema.safeParse({
      ...base,
      state: "started",
      finished_at: "2026-09-18T00:00:01.000Z",
    }).success).toBe(false);
  });
});
