import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./crypto.js";
import {
  ActionWal,
  ActionWalCorruptionError,
  ActionWalInvariantError,
  ActionWalPathSafetyError,
  RecoveryLedger,
} from "./action-wal.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("ActionWal", () => {
  it("durably tracks phases and authenticates exact before images across restart", async () => {
    const root = await temporaryRoot();
    const walRoot = join(root, "wal");
    let id = 0;
    const options = {
      now: () => new Date("2026-09-18T01:02:03.000Z"),
      idFactory: (prefix: string) => `${prefix}:${++id}`,
    };
    const wal = new ActionWal(walRoot, options);
    const prepared = await wal.prepareAction(prepareInput("before bytes"));

    expect(prepared.phase).toBe("prepare");
    expect(prepared.targets[0]).toMatchObject({
      target_path: "src/app.ts",
      existed: true,
      before_hash: sha256("before bytes"),
      after_hash: sha256("after bytes"),
    });
    await expect(wal.readBeforeImage({
      projectId: prepared.project_id,
      runId: prepared.run_id,
      actionId: prepared.action_id,
      target: prepared.targets[0]!,
    })).resolves.toEqual(Buffer.from("before bytes"));

    await wal.advance({ runId: "run:test", actionId: "action:test", phase: "applied" });
    await wal.advance({
      runId: "run:test",
      actionId: "action:test",
      phase: "committed",
      eventId: "event:patch-applied",
      receiptId: "receipt:commit",
    });
    await wal.advance({
      runId: "run:test",
      actionId: "action:test",
      phase: "verified",
      eventId: "event:action-verified",
    });

    const restarted = new ActionWal(walRoot, options);
    await expect(restarted.list("run:test")).resolves.toMatchObject([
      { sequence: 1, phase: "prepare" },
      { sequence: 2, phase: "applied" },
      { sequence: 3, phase: "committed", event_id: "event:patch-applied" },
      { sequence: 4, phase: "verified" },
    ]);
    await expect(restarted.latestForAction("run:test", "action:test"))
      .resolves.toMatchObject({ phase: "verified" });
    await expect(restarted.pending()).resolves.toEqual([]);

    expect((await lstat(walRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(walRoot, "backups"))).mode & 0o777).toBe(0o700);
    for (const name of await readdir(walRoot)) {
      if (name.endsWith(".jsonl")) expect((await lstat(join(walRoot, name))).mode & 0o777).toBe(0o600);
    }
    for (const name of await readdir(join(walRoot, "backups"))) {
      expect((await lstat(join(walRoot, "backups", name))).mode & 0o777).toBe(0o600);
    }
  });

  it("represents a previously absent path without inventing backup bytes", async () => {
    const root = await temporaryRoot();
    const wal = new ActionWal(join(root, "wal"));
    const prepared = await wal.prepareAction({
      ...prepareInput(undefined),
      targets: [{
        targetPath: "src/new.ts",
        existed: false,
        afterHash: sha256("created"),
      }],
      patchHash: sha256("created"),
    });

    expect(prepared.targets[0]).toEqual({
      target_path: "src/new.ts",
      existed: false,
      before_hash: sha256(""),
      after_hash: sha256("created"),
    });
    await expect(wal.readBeforeImage({
      projectId: prepared.project_id,
      runId: prepared.run_id,
      actionId: prepared.action_id,
      target: prepared.targets[0]!,
    })).resolves.toBeNull();
  });

  it("keeps exact private bytes instead of applying public-artifact redaction", async () => {
    const root = await temporaryRoot();
    const wal = new ActionWal(join(root, "wal"));
    const exact = "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456";
    const prepared = await wal.prepareAction(prepareInput(exact));

    const restored = await wal.readBeforeImage({
      projectId: prepared.project_id,
      runId: prepared.run_id,
      actionId: prepared.action_id,
      target: prepared.targets[0]!,
    });
    expect(restored?.toString("utf8")).toBe(exact);
    expect((await readFile(await onlyFileWithSuffix(join(root, "wal", "backups"), ".data"), "utf8")))
      .toBe(exact);
  });

  it("rejects skipped phase transitions and detects WAL tampering", async () => {
    const root = await temporaryRoot();
    const walRoot = join(root, "wal");
    const wal = new ActionWal(walRoot);
    await wal.prepareAction(prepareInput("before"));

    await expect(wal.advance({
      runId: "run:test",
      actionId: "action:test",
      phase: "committed",
      eventId: "event:patch-applied",
      receiptId: "receipt:commit",
    })).rejects.toBeInstanceOf(ActionWalInvariantError);

    const path = await onlyFileWithSuffix(walRoot, ".jsonl");
    const line = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    line.project_id = "project:tampered";
    await writeFile(path, `${JSON.stringify(line)}\n`);
    await expect(wal.list("run:test")).rejects.toBeInstanceOf(ActionWalCorruptionError);
  });

  it("detects before-image mutation instead of returning unsafe rollback bytes", async () => {
    const root = await temporaryRoot();
    const backupRoot = join(root, "wal", "backups");
    const wal = new ActionWal(join(root, "wal"));
    const prepared = await wal.prepareAction(prepareInput("before"));
    const dataPath = await onlyFileWithSuffix(backupRoot, ".data");
    await writeFile(dataPath, "modified");

    await expect(wal.readBeforeImage({
      projectId: prepared.project_id,
      runId: prepared.run_id,
      actionId: prepared.action_id,
      target: prepared.targets[0]!,
    })).rejects.toBeInstanceOf(ActionWalCorruptionError);
  });

  it("never follows a symbolic-link before image during rollback reads", async () => {
    const root = await temporaryRoot();
    const backupRoot = join(root, "wal", "backups");
    const wal = new ActionWal(join(root, "wal"));
    const prepared = await wal.prepareAction(prepareInput("before"));
    const dataPath = await onlyFileWithSuffix(backupRoot, ".data");
    const attacker = join(root, "attacker.data");
    await writeFile(attacker, "before", { mode: 0o600 });
    await rm(dataPath);
    await symlink(attacker, dataPath);

    await expect(wal.readBeforeImage({
      projectId: prepared.project_id,
      runId: prepared.run_id,
      actionId: prepared.action_id,
      target: prepared.targets[0]!,
    })).rejects.toBeInstanceOf(ActionWalPathSafetyError);
  });

  it("rejects symbolic-link roots and WAL files", async () => {
    const root = await temporaryRoot();
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked);
    await expect(new ActionWal(linked).initialize()).rejects.toBeInstanceOf(ActionWalPathSafetyError);

    const walRoot = join(root, "wal");
    const wal = new ActionWal(walRoot);
    await wal.prepareAction(prepareInput("before"));
    const path = await onlyFileWithSuffix(walRoot, ".jsonl");
    const target = join(root, "attacker.jsonl");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    await expect(wal.list("run:test")).rejects.toBeInstanceOf(ActionWalPathSafetyError);
  });

  it("refuses non-private existing roots", async () => {
    const root = await temporaryRoot();
    const walRoot = join(root, "wal");
    await mkdir(walRoot, { mode: 0o755 });
    await chmod(walRoot, 0o755);
    await expect(new ActionWal(walRoot).initialize()).rejects.toBeInstanceOf(ActionWalPathSafetyError);
  });
});

describe("RecoveryLedger", () => {
  it("records one automatic attempt, escalates further retries, and exports markdown", async () => {
    const root = await temporaryRoot();
    const ledgerRoot = join(root, "recovery");
    let id = 0;
    let tick = 0;
    const ledger = new RecoveryLedger(ledgerRoot, {
      idFactory: (prefix) => `${prefix}:${++id}`,
      now: () => new Date(Date.UTC(2026, 8, 18, 0, 0, tick++)),
    });
    const started = await ledger.startAttempt({
      project_id: "project:test",
      run_id: "run:test",
      action_id: "action:test",
      recipe_id: "replay_missing_event",
      automatic: true,
    });
    expect(started).toMatchObject({ attempt: 1, state: "started" });
    const failed = await ledger.finishAttempt({
      recovery_id: started.recovery_id,
      state: "failed",
      last_failure: "event append failed",
    });
    expect(failed).toMatchObject({ attempt: 1, state: "failed" });

    const escalated = await ledger.startAttempt({
      project_id: "project:test",
      run_id: "run:test",
      action_id: "action:test",
      recipe_id: "replay_missing_event",
      automatic: true,
    });
    expect(escalated).toMatchObject({
      attempt: 2,
      state: "escalated",
      escalation_reason: "automatic_attempt_limit_exceeded",
    });
    await expect(ledger.startAttempt({
      project_id: "project:test",
      run_id: "run:test",
      action_id: "action:test",
      recipe_id: "replay_missing_event",
      automatic: true,
    })).resolves.toEqual(escalated);

    const manual = await ledger.startAttempt({
      project_id: "project:test",
      run_id: "run:test",
      action_id: "action:test",
      recipe_id: "restore_from_backup",
      automatic: false,
    });
    await ledger.finishAttempt({ recovery_id: manual.recovery_id, state: "succeeded" });

    const restarted = new RecoveryLedger(ledgerRoot);
    await expect(restarted.list("run:test")).resolves.toMatchObject([
      { recipe_id: "replay_missing_event", attempt: 1, state: "failed" },
      { recipe_id: "replay_missing_event", attempt: 2, state: "escalated" },
      { recipe_id: "restore_from_backup", attempt: 1, state: "succeeded" },
    ]);
    const markdown = await restarted.exportMarkdown("run:test");
    expect(markdown).toContain("# Recovery report: run:test");
    expect(markdown).toContain("automatic_attempt_limit_exceeded");
    expect(markdown).toContain("restore_from_backup");
    expect((await lstat(ledgerRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(await onlyFileWithSuffix(ledgerRoot, ".jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("returns an existing open attempt instead of silently consuming another try", async () => {
    const root = await temporaryRoot();
    const ledger = new RecoveryLedger(join(root, "recovery"));
    const input = {
      project_id: "project:test",
      run_id: "run:test",
      action_id: "action:test",
      recipe_id: "mark_diverged" as const,
      automatic: true,
    };
    const first = await ledger.startAttempt(input);
    await expect(ledger.startAttempt(input)).resolves.toEqual(first);
    await expect(ledger.list("run:test")).resolves.toHaveLength(1);
  });
});

function prepareInput(beforeContent: string | undefined) {
  return {
    projectId: "project:test",
    runId: "run:test",
    actionId: "action:test",
    workspaceHandleId: "workspace:test",
    workspaceRootHash: sha256("/canonical/workspace"),
    workspaceKind: "managed_local" as const,
    patchHash: sha256("after bytes"),
    targets: [{
      targetPath: "src/app.ts",
      existed: true,
      ...(beforeContent === undefined ? {} : { beforeContent }),
      afterHash: sha256("after bytes"),
    }],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-action-wal-"));
  roots.push(root);
  return root;
}

async function onlyFileWithSuffix(root: string, suffix: string): Promise<string> {
  const matches = (await readdir(root)).filter((name) => name.endsWith(suffix));
  expect(matches).toHaveLength(1);
  return join(root, matches[0]!);
}
