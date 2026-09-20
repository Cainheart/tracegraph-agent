import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  ACTION_WAL_FORMAT_VERSION,
  ActionWalPrepareSchema,
  ActionWalRecordSchema,
  ActionWalTargetSchema,
  DEFAULT_MAX_AUTOMATIC_RECOVERY_ATTEMPTS,
  IdentifierSchema,
  RECOVERY_LEDGER_FORMAT_VERSION,
  RecoveryAttemptFinishSchema,
  RecoveryAttemptRecordSchema,
  RecoveryAttemptStartSchema,
  type ActionWalPhase,
  type ActionWalPrepare,
  type ActionWalRecord,
  type ActionWalTarget,
  type RecoveryAttemptFinish,
  type RecoveryAttemptRecord,
  type RecoveryAttemptStart,
} from "@tracegraph/contracts";
import { z } from "zod";
import {
  defaultIdFactory,
  redactSensitiveText,
  sha256,
  stableStringify,
} from "./crypto.js";

const DEFAULT_MAX_WAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_METADATA_BYTES = 32 * 1024;
const DEFAULT_MAX_RECOVERY_BYTES = 8 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const BackupMetadataSchema = z.object({
  backup_version: z.literal(1),
  backup_ref: z.string().trim().min(1).max(160),
  project_id: z.string().trim().min(1).max(160),
  run_id: z.string().trim().min(1).max(160),
  action_id: z.string().trim().min(1).max(160),
  target_path: z.string().trim().min(1),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  byte_length: z.number().int().nonnegative(),
  created_at: z.iso.datetime({ offset: true }),
}).strict();
type BackupMetadata = z.infer<typeof BackupMetadataSchema>;

export interface ActionWalOptions {
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  maxWalBytes?: number;
  maxBackupBytes?: number;
}

export interface PrepareActionInput {
  projectId: string;
  runId: string;
  actionId: string;
  workspaceHandleId: string;
  workspaceRootHash: string;
  workspaceKind: ActionWalPrepare["workspace_kind"];
  patchHash: string;
  targets: readonly {
    targetPath: string;
    existed: boolean;
    beforeContent?: string | Uint8Array;
    afterHash: string;
  }[];
}

export interface SaveBeforeImageInput {
  projectId: string;
  runId: string;
  actionId: string;
  targetPath: string;
  existed: boolean;
  content?: string | Uint8Array;
  afterHash: string;
}

export interface ReadBeforeImageInput {
  projectId: string;
  runId: string;
  actionId: string;
  target: ActionWalTarget;
}

export interface AdvanceActionInput {
  runId: string;
  actionId: string;
  phase: Exclude<ActionWalPhase, "prepare">;
  eventId?: string;
  receiptId?: string;
  recovered?: boolean;
  reason?: string;
}

/**
 * A private, append-only Action write-ahead log.
 *
 * Every logical append is implemented as a fully synced temporary file plus
 * rename and directory fsync. This leaves either the previous valid JSONL or
 * the next valid JSONL after a process/power interruption; it never relies on
 * repairing an ambiguous partial line. Calls are serialized inside a process.
 */
export class ActionWal {
  readonly #root: string;
  readonly #backupRoot: string;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #maxWalBytes: number;
  readonly #maxBackupBytes: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    root = join(homedir(), ".tracegraph", "wal"),
    options: ActionWalOptions = {},
  ) {
    if (!isAbsolute(root)) throw new ActionWalPathSafetyError("Action WAL root must be absolute");
    this.#root = resolve(root);
    this.#backupRoot = join(this.#root, "backups");
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#maxWalBytes = boundedPositiveInteger(
      options.maxWalBytes ?? DEFAULT_MAX_WAL_BYTES,
      "maxWalBytes",
    );
    this.#maxBackupBytes = boundedPositiveInteger(
      options.maxBackupBytes ?? DEFAULT_MAX_BACKUP_BYTES,
      "maxBackupBytes",
    );
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => this.#initialize());
  }

  /** Save exact bytes and return the target descriptor that may enter WAL. */
  saveBeforeImage(input: SaveBeforeImageInput): Promise<ActionWalTarget> {
    return this.#serialize(async () => {
      await this.#initialize();
      return this.#saveBeforeImage(input);
    });
  }

  /**
   * Save all before images durably, then append prepare. A crash can leave an
   * unreferenced backup, but can never leave prepare pointing at missing bytes.
   */
  prepareAction(input: PrepareActionInput): Promise<ActionWalRecord> {
    return this.#serialize(async () => {
      await this.#initialize();
      // Validate every public field before persisting any exact before bytes.
      ActionWalPrepareSchema.parse({
        project_id: input.projectId,
        run_id: input.runId,
        action_id: input.actionId,
        workspace_handle_id: input.workspaceHandleId,
        workspace_root_hash: input.workspaceRootHash,
        workspace_kind: input.workspaceKind,
        patch_hash: input.patchHash,
        targets: input.targets.map((target) => ({
          target_path: target.targetPath,
          existed: target.existed,
          before_hash: sha256(target.beforeContent === undefined ? "" : toBuffer(target.beforeContent)),
          after_hash: target.afterHash,
          ...(target.existed ? { backup_ref: "wal-backup:pending" } : {}),
        })),
      });
      const targets: ActionWalTarget[] = [];
      for (const target of input.targets) {
        targets.push(await this.#saveBeforeImage({
          projectId: input.projectId,
          runId: input.runId,
          actionId: input.actionId,
          targetPath: target.targetPath,
          existed: target.existed,
          ...(target.beforeContent === undefined ? {} : { content: target.beforeContent }),
          afterHash: target.afterHash,
        }));
      }
      const prepared = ActionWalPrepareSchema.parse({
        project_id: input.projectId,
        run_id: input.runId,
        action_id: input.actionId,
        workspace_handle_id: input.workspaceHandleId,
        workspace_root_hash: input.workspaceRootHash,
        workspace_kind: input.workspaceKind,
        patch_hash: input.patchHash,
        targets,
      });
      try {
        return await this.#appendPrepare(prepared);
      } catch (error) {
        // Backups are deliberately retained on an uncertain append outcome.
        // They are private, content-addressed recovery material; deleting them
        // here could turn an ambiguous prepare into an unrecoverable action.
        throw error;
      }
    });
  }

  /** Append a phase while copying the immutable action identity from prepare. */
  advance(input: AdvanceActionInput): Promise<ActionWalRecord> {
    const runId = IdentifierSchema.parse(input.runId);
    const actionId = IdentifierSchema.parse(input.actionId);
    return this.#serialize(async () => {
      await this.#initialize();
      const records = await this.#readRun(runId);
      const previous = latestForAction(records, actionId);
      if (previous === undefined) {
        throw new ActionWalInvariantError(`action ${actionId} has no prepare record`);
      }
      const body = {
        wal_version: ACTION_WAL_FORMAT_VERSION,
        wal_id: this.#idFactory("wal"),
        sequence: records.length + 1,
        project_id: previous.project_id,
        run_id: previous.run_id,
        action_id: previous.action_id,
        workspace_handle_id: previous.workspace_handle_id,
        workspace_root_hash: previous.workspace_root_hash,
        workspace_kind: previous.workspace_kind,
        patch_hash: previous.patch_hash,
        targets: previous.targets,
        phase: input.phase,
        recorded_at: this.#now().toISOString(),
        previous_wal_id: records.at(-1)!.wal_id,
        previous_record_hash: records.at(-1)!.record_hash,
        ...(input.eventId === undefined ? {} : { event_id: input.eventId }),
        ...(input.receiptId === undefined ? {} : { receipt_id: input.receiptId }),
        recovered: input.recovered ?? false,
        ...(input.reason === undefined ? {} : { reason: redactSensitiveText(input.reason) }),
      };
      const record = recordWithHash(body);
      validateWalAppend(records, record);
      await this.#writeRun(runId, [...records, record]);
      return record;
    });
  }

  /** Return all validated records for one run in durable sequence order. */
  list(runId: string): Promise<ActionWalRecord[]> {
    const parsedRunId = IdentifierSchema.parse(runId);
    return this.#serialize(async () => {
      await this.#initialize();
      return this.#readRun(parsedRunId);
    });
  }

  latestForAction(runId: string, actionId: string): Promise<ActionWalRecord | undefined> {
    const parsedRunId = IdentifierSchema.parse(runId);
    const parsedActionId = IdentifierSchema.parse(actionId);
    return this.#serialize(async () => {
      await this.#initialize();
      return latestForAction(await this.#readRun(parsedRunId), parsedActionId);
    });
  }

  /** Latest phase of every action in one run, ordered by durable sequence. */
  latest(runId: string): Promise<ActionWalRecord[]> {
    const parsedRunId = IdentifierSchema.parse(runId);
    return this.#serialize(async () => {
      await this.#initialize();
      return latestRecords(await this.#readRun(parsedRunId));
    });
  }

  /** Startup scanner: all actions that have not reached verified/aborted. */
  pending(): Promise<ActionWalRecord[]> {
    return this.#serialize(async () => {
      await this.#initialize();
      const records = await this.#readAllRuns();
      return latestRecords(records)
        .filter((record) => record.phase !== "verified" && record.phase !== "aborted")
        .sort(compareWalRecords);
    });
  }

  /** Read and authenticate exact before bytes. `null` means path was absent. */
  readBeforeImage(input: ReadBeforeImageInput): Promise<Buffer | null> {
    return this.#serialize(async () => {
      await this.#initialize();
      const target = ActionWalTargetSchema.parse(input.target);
      if (!target.existed) return null;
      const backupRef = target.backup_ref!;
      const paths = backupPaths(this.#backupRoot, backupRef);
      const metadataBytes = await readPrivateFile(paths.metadata, MAX_BACKUP_METADATA_BYTES, "WAL backup metadata");
      let metadata: BackupMetadata;
      try {
        metadata = BackupMetadataSchema.parse(JSON.parse(decodeUtf8(metadataBytes, "WAL backup metadata")));
      } catch (error) {
        throw new ActionWalCorruptionError("WAL backup metadata is invalid", { cause: error });
      }
      if (
        metadata.backup_ref !== backupRef
        || metadata.project_id !== input.projectId
        || metadata.run_id !== input.runId
        || metadata.action_id !== input.actionId
        || metadata.target_path !== target.target_path
        || metadata.content_hash !== target.before_hash
      ) {
        throw new ActionWalCorruptionError("WAL backup binding does not match the requested action target");
      }
      if (metadata.byte_length > this.#maxBackupBytes) {
        throw new ActionWalCorruptionError("WAL backup exceeds the configured maximum size");
      }
      const bytes = await readPrivateFile(paths.data, this.#maxBackupBytes, "WAL backup data");
      if (bytes.byteLength !== metadata.byte_length || sha256(bytes) !== metadata.content_hash) {
        throw new ActionWalCorruptionError("WAL backup content hash does not match its metadata");
      }
      return bytes;
    });
  }

  async #initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#root, true, "Action WAL root");
    await ensurePrivateDirectory(this.#backupRoot, true, "Action WAL backup root");
  }

  async #saveBeforeImage(input: SaveBeforeImageInput): Promise<ActionWalTarget> {
    const previewBytes = input.content === undefined ? Buffer.alloc(0) : toBuffer(input.content);
    // Validate identifiers, relative path and hashes before touching disk.
    BackupMetadataSchema.pick({
      project_id: true,
      run_id: true,
      action_id: true,
      target_path: true,
      content_hash: true,
      byte_length: true,
      created_at: true,
    }).parse({
      project_id: input.projectId,
      run_id: input.runId,
      action_id: input.actionId,
      target_path: input.targetPath,
      content_hash: sha256(previewBytes),
      byte_length: previewBytes.byteLength,
      created_at: this.#now().toISOString(),
    });
    ActionWalTargetSchema.parse({
      target_path: input.targetPath,
      existed: input.existed,
      before_hash: sha256(previewBytes),
      after_hash: input.afterHash,
      ...(input.existed ? { backup_ref: "wal-backup:pending" } : {}),
    });
    const targetBase = {
      target_path: input.targetPath,
      existed: input.existed,
      after_hash: input.afterHash,
    };
    if (!input.existed) {
      if (input.content !== undefined && toBuffer(input.content).byteLength > 0) {
        throw new ActionWalInvariantError("a previously absent target cannot have before bytes");
      }
      return ActionWalTargetSchema.parse({
        ...targetBase,
        before_hash: sha256(""),
      });
    }
    if (input.content === undefined) {
      throw new ActionWalInvariantError("an existing target requires exact before bytes");
    }
    const bytes = toBuffer(input.content);
    if (bytes.byteLength > this.#maxBackupBytes) {
      throw new ActionWalCorruptionError("WAL before image exceeds the configured maximum size");
    }
    const contentHash = sha256(bytes);
    const backupRef = this.#idFactory("wal-backup");
    const paths = backupPaths(this.#backupRoot, backupRef);
    const metadata = BackupMetadataSchema.parse({
      backup_version: 1,
      backup_ref: backupRef,
      project_id: input.projectId,
      run_id: input.runId,
      action_id: input.actionId,
      target_path: input.targetPath,
      content_hash: contentHash,
      byte_length: bytes.byteLength,
      created_at: this.#now().toISOString(),
    });
    const metadataText = `${JSON.stringify(metadata)}\n`;
    if (Buffer.byteLength(metadataText) > MAX_BACKUP_METADATA_BYTES) {
      throw new ActionWalCorruptionError("WAL backup metadata exceeds the configured maximum size");
    }
    let dataCreated = false;
    let metadataCreated = false;
    try {
      await writeExclusiveFileDurably(paths.data, bytes);
      dataCreated = true;
      await writeExclusiveFileDurably(paths.metadata, metadataText);
      metadataCreated = true;
    } catch (error) {
      await Promise.all([
        ...(dataCreated ? [rm(paths.data, { force: true })] : []),
        ...(metadataCreated ? [rm(paths.metadata, { force: true })] : []),
      ]).catch(() => undefined);
      throw error;
    }
    return ActionWalTargetSchema.parse({
      ...targetBase,
      before_hash: contentHash,
      backup_ref: backupRef,
    });
  }

  async #appendPrepare(prepared: ActionWalPrepare): Promise<ActionWalRecord> {
    const records = await this.#readRun(prepared.run_id);
    const existing = latestForAction(records, prepared.action_id);
    if (existing !== undefined) {
      const candidate = immutableAction(existing);
      if (stableStringify(candidate) === stableStringify(prepared)) return existing;
      throw new ActionWalInvariantError(`action ${prepared.action_id} already has a different WAL identity`);
    }
    const previous = records.at(-1);
    const body = {
      wal_version: ACTION_WAL_FORMAT_VERSION,
      wal_id: this.#idFactory("wal"),
      sequence: records.length + 1,
      ...prepared,
      phase: "prepare" as const,
      recorded_at: this.#now().toISOString(),
      ...(previous === undefined ? {} : {
        previous_wal_id: previous.wal_id,
        previous_record_hash: previous.record_hash,
      }),
      recovered: false,
    };
    const record = recordWithHash(body);
    validateWalAppend(records, record);
    await this.#writeRun(prepared.run_id, [...records, record]);
    return record;
  }

  async #readRun(runId: string): Promise<ActionWalRecord[]> {
    const path = walPath(this.#root, runId);
    let bytes: Buffer;
    try {
      bytes = await readPrivateFile(path, this.#maxWalBytes, "Action WAL file");
    } catch (error) {
      if (error instanceof ActionWalNotFoundError) return [];
      throw error;
    }
    const records = parseJsonl(bytes, ActionWalRecordSchema, "Action WAL");
    validateWalRecords(records);
    if (records.some((record) => record.run_id !== runId)) {
      throw new ActionWalCorruptionError("Action WAL file contains a different run_id");
    }
    return records;
  }

  async #readAllRuns(): Promise<ActionWalRecord[]> {
    const result: ActionWalRecord[] = [];
    const seenRuns = new Set<string>();
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (entry.name === "backups" && entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) {
        throw new ActionWalPathSafetyError("Action WAL root contains a symbolic link");
      }
      if (!entry.isFile() || !entry.name.startsWith("run-") || !entry.name.endsWith(".jsonl")) continue;
      const path = join(this.#root, entry.name);
      const records = parseJsonl(
        await readPrivateFile(path, this.#maxWalBytes, "Action WAL file"),
        ActionWalRecordSchema,
        "Action WAL",
      );
      validateWalRecords(records);
      const runId = records[0]?.run_id;
      if (runId === undefined) throw new ActionWalCorruptionError("Action WAL file is empty");
      if (walPath(this.#root, runId) !== path) {
        throw new ActionWalCorruptionError("Action WAL filename does not match its run_id");
      }
      if (seenRuns.has(runId)) throw new ActionWalCorruptionError(`duplicate WAL for run ${runId}`);
      seenRuns.add(runId);
      result.push(...records);
    }
    return result;
  }

  async #writeRun(runId: string, records: readonly ActionWalRecord[]): Promise<void> {
    validateWalRecords(records);
    const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    if (Buffer.byteLength(content) > this.#maxWalBytes) {
      throw new ActionWalCorruptionError("Action WAL exceeds the configured maximum size");
    }
    await replaceFileDurably(walPath(this.#root, runId), content);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface RecoveryLedgerOptions {
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  maxFileBytes?: number;
  maxAutomaticAttempts?: number;
}

export interface FinishRecoveryAttemptInput extends RecoveryAttemptFinish {}

/** Append-only recovery recipe attempt ledger with a conservative retry cap. */
export class RecoveryLedger {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #maxFileBytes: number;
  readonly #maxAutomaticAttempts: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    root = join(homedir(), ".tracegraph", "recovery"),
    options: RecoveryLedgerOptions = {},
  ) {
    if (!isAbsolute(root)) throw new ActionWalPathSafetyError("Recovery Ledger root must be absolute");
    this.#root = resolve(root);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#maxFileBytes = boundedPositiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_RECOVERY_BYTES,
      "maxFileBytes",
    );
    this.#maxAutomaticAttempts = boundedPositiveInteger(
      options.maxAutomaticAttempts ?? DEFAULT_MAX_AUTOMATIC_RECOVERY_ATTEMPTS,
      "maxAutomaticAttempts",
    );
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => ensurePrivateDirectory(this.#root, true, "Recovery Ledger root"));
  }

  startAttempt(inputValue: RecoveryAttemptStart): Promise<RecoveryAttemptRecord> {
    const input = RecoveryAttemptStartSchema.parse(inputValue);
    return this.#serialize(async () => {
      await ensurePrivateDirectory(this.#root, true, "Recovery Ledger root");
      const records = await this.#readRun(input.run_id);
      const attempts = materializeRecoveryAttempts(records);
      const matching = attempts.filter(
        (record) => record.action_id === input.action_id && record.recipe_id === input.recipe_id,
      );
      const open = matching.find((record) => record.state === "started");
      if (open !== undefined) return open;
      const existingLimitEscalation = matching.find(
        (record) => record.state === "escalated"
          && record.escalation_reason === "automatic_attempt_limit_exceeded",
      );
      if (input.automatic && existingLimitEscalation !== undefined) return existingLimitEscalation;
      const attempt = Math.max(0, ...matching.map((record) => record.attempt)) + 1;
      const automaticAttempts = matching.filter((record) => record.automatic).length;
      const now = this.#now().toISOString();
      if (input.automatic && automaticAttempts >= this.#maxAutomaticAttempts) {
        const escalated = recoveryRecordWithHash(records, {
          recovery_version: RECOVERY_LEDGER_FORMAT_VERSION,
          record_id: this.#idFactory("recovery-record"),
          recovery_id: this.#idFactory("recovery"),
          sequence: records.length + 1,
          ...input,
          attempt,
          state: "escalated",
          started_at: now,
          recorded_at: now,
          finished_at: now,
          escalation_reason: "automatic_attempt_limit_exceeded",
        });
        validateRecoveryAppend(records, escalated);
        await this.#writeRun(input.run_id, [...records, escalated]);
        return escalated;
      }
      const started = recoveryRecordWithHash(records, {
        recovery_version: RECOVERY_LEDGER_FORMAT_VERSION,
        record_id: this.#idFactory("recovery-record"),
        recovery_id: this.#idFactory("recovery"),
        sequence: records.length + 1,
        ...input,
        attempt,
        state: "started",
        started_at: now,
        recorded_at: now,
      });
      validateRecoveryAppend(records, started);
      await this.#writeRun(input.run_id, [...records, started]);
      return started;
    });
  }

  finishAttempt(inputValue: FinishRecoveryAttemptInput): Promise<RecoveryAttemptRecord> {
    const input = RecoveryAttemptFinishSchema.parse(inputValue);
    return this.#serialize(async () => {
      await ensurePrivateDirectory(this.#root, true, "Recovery Ledger root");
      const located = await this.#findRecovery(input.recovery_id);
      if (located.latest.state !== "started") {
        if (
          located.latest.state === input.state
          && located.latest.last_failure === input.last_failure
          && located.latest.escalation_reason === input.escalation_reason
        ) return located.latest;
        throw new RecoveryLedgerInvariantError(`recovery ${input.recovery_id} is already terminal`);
      }
      const now = this.#now().toISOString();
      const terminal = recoveryRecordWithHash(located.records, {
        ...withoutRecoveryHash(located.latest),
        record_id: this.#idFactory("recovery-record"),
        sequence: located.records.length + 1,
        state: input.state,
        recorded_at: now,
        finished_at: now,
        ...(input.last_failure === undefined
          ? {}
          : { last_failure: redactSensitiveText(input.last_failure) }),
        ...(input.escalation_reason === undefined
          ? {}
          : { escalation_reason: redactSensitiveText(input.escalation_reason) }),
      });
      validateRecoveryAppend(located.records, terminal);
      await this.#writeRun(located.latest.run_id, [...located.records, terminal]);
      return terminal;
    });
  }

  list(runId: string): Promise<RecoveryAttemptRecord[]> {
    const parsedRunId = IdentifierSchema.parse(runId);
    return this.#serialize(async () => {
      await ensurePrivateDirectory(this.#root, true, "Recovery Ledger root");
      return materializeRecoveryAttempts(await this.#readRun(parsedRunId));
    });
  }

  exportMarkdown(runId: string): Promise<string> {
    const parsedRunId = IdentifierSchema.parse(runId);
    return this.#serialize(async () => {
      await ensurePrivateDirectory(this.#root, true, "Recovery Ledger root");
      const attempts = materializeRecoveryAttempts(await this.#readRun(parsedRunId));
      const lines = [
        `# Recovery report: ${markdownCell(parsedRunId)}`,
        "",
        `Generated: ${this.#now().toISOString()}`,
        "",
        "| Action | Recipe | Attempt | Mode | State | Started | Finished | Detail |",
        "| --- | --- | ---: | --- | --- | --- | --- | --- |",
      ];
      for (const attempt of attempts) {
        lines.push([
          `| ${markdownCell(attempt.action_id)}`,
          markdownCell(attempt.recipe_id),
          String(attempt.attempt),
          attempt.automatic ? "automatic" : "manual",
          attempt.state,
          attempt.started_at,
          attempt.finished_at ?? "-",
          markdownCell(attempt.escalation_reason ?? attempt.last_failure ?? "-"),
        ].join(" | ") + " |");
      }
      if (attempts.length === 0) lines.push("| - | - | - | - | none | - | - | - |");
      lines.push("");
      return lines.join("\n");
    });
  }

  async #findRecovery(recoveryId: string): Promise<{
    latest: RecoveryAttemptRecord;
    records: RecoveryAttemptRecord[];
  }> {
    const entries = await readdir(this.#root, { withFileTypes: true });
    let result: { latest: RecoveryAttemptRecord; records: RecoveryAttemptRecord[] } | undefined;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new ActionWalPathSafetyError("Recovery Ledger root contains a symbolic link");
      }
      if (!entry.isFile() || !entry.name.startsWith("run-") || !entry.name.endsWith(".jsonl")) continue;
      const path = join(this.#root, entry.name);
      const records = parseJsonl(
        await readPrivateFile(path, this.#maxFileBytes, "Recovery Ledger file"),
        RecoveryAttemptRecordSchema,
        "Recovery Ledger",
      );
      validateRecoveryRecords(records);
      const runId = records[0]?.run_id;
      if (runId === undefined) throw new ActionWalCorruptionError("Recovery Ledger file is empty");
      if (recoveryPath(this.#root, runId) !== path) {
        throw new ActionWalCorruptionError("Recovery Ledger filename does not match its run_id");
      }
      const latest = materializeRecoveryAttempts(records).find((record) => record.recovery_id === recoveryId);
      if (latest !== undefined) {
        if (result !== undefined) throw new ActionWalCorruptionError(`duplicate recovery_id ${recoveryId}`);
        result = { latest, records };
      }
    }
    if (result === undefined) throw new ActionWalNotFoundError(`recovery ${recoveryId}`);
    return result;
  }

  async #readRun(runId: string): Promise<RecoveryAttemptRecord[]> {
    let bytes: Buffer;
    try {
      bytes = await readPrivateFile(
        recoveryPath(this.#root, runId),
        this.#maxFileBytes,
        "Recovery Ledger file",
      );
    } catch (error) {
      if (error instanceof ActionWalNotFoundError) return [];
      throw error;
    }
    const records = parseJsonl(bytes, RecoveryAttemptRecordSchema, "Recovery Ledger");
    validateRecoveryRecords(records);
    if (records.some((record) => record.run_id !== runId)) {
      throw new ActionWalCorruptionError("Recovery Ledger file contains a different run_id");
    }
    return records;
  }

  async #writeRun(runId: string, records: readonly RecoveryAttemptRecord[]): Promise<void> {
    validateRecoveryRecords(records);
    const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    if (Buffer.byteLength(content) > this.#maxFileBytes) {
      throw new ActionWalCorruptionError("Recovery Ledger exceeds the configured maximum size");
    }
    await replaceFileDurably(recoveryPath(this.#root, runId), content);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function recordWithHash(
  body: Omit<ActionWalRecord, "record_hash">,
): ActionWalRecord {
  return ActionWalRecordSchema.parse({ ...body, record_hash: sha256(stableStringify(body)) });
}

function recoveryRecordWithHash(
  previous: readonly RecoveryAttemptRecord[],
  input: Omit<RecoveryAttemptRecord, "record_hash" | "previous_record_hash">,
): RecoveryAttemptRecord {
  const prior = previous.at(-1);
  const body = {
    ...input,
    ...(prior === undefined ? {} : { previous_record_hash: prior.record_hash }),
  };
  return RecoveryAttemptRecordSchema.parse({ ...body, record_hash: sha256(stableStringify(body)) });
}

function withoutRecoveryHash(
  record: RecoveryAttemptRecord,
): Omit<RecoveryAttemptRecord, "record_hash" | "previous_record_hash"> {
  const { record_hash: _hash, previous_record_hash: _previous, ...body } = record;
  return body;
}

function validateWalRecords(records: readonly ActionWalRecord[]): void {
  const accepted: ActionWalRecord[] = [];
  for (const record of records) {
    validateWalAppend(accepted, record);
    accepted.push(record);
  }
}

function validateWalAppend(records: readonly ActionWalRecord[], record: ActionWalRecord): void {
  const { record_hash: recordHash, ...body } = record;
  if (sha256(stableStringify(body)) !== recordHash) {
    throw new ActionWalCorruptionError(`Action WAL hash mismatch at sequence ${record.sequence}`);
  }
  const previous = records.at(-1);
  if (record.sequence !== (previous?.sequence ?? 0) + 1) {
    throw new ActionWalCorruptionError(`Action WAL has non-monotonic sequence ${record.sequence}`);
  }
  if (previous === undefined) {
    if (record.previous_wal_id !== undefined || record.previous_record_hash !== undefined) {
      throw new ActionWalCorruptionError("first Action WAL record cannot reference a predecessor");
    }
  } else if (
    record.previous_wal_id !== previous.wal_id
    || record.previous_record_hash !== previous.record_hash
  ) {
    throw new ActionWalCorruptionError(`Action WAL chain is broken at sequence ${record.sequence}`);
  }
  if (
    previous !== undefined
    && (
      record.run_id !== previous.run_id
      || record.project_id !== previous.project_id
      || record.workspace_root_hash !== previous.workspace_root_hash
      || record.workspace_kind !== previous.workspace_kind
    )
  ) {
    throw new ActionWalCorruptionError("Action WAL changed its run workspace identity");
  }
  if (records.some((item) => item.wal_id === record.wal_id)) {
    throw new ActionWalCorruptionError(`duplicate wal_id ${record.wal_id}`);
  }
  const actionPrevious = latestForAction(records, record.action_id);
  if (actionPrevious === undefined) {
    if (record.phase !== "prepare") {
      throw new ActionWalInvariantError(`action ${record.action_id} must start with prepare`);
    }
    return;
  }
  if (stableStringify(immutableAction(actionPrevious)) !== stableStringify(immutableAction(record))) {
    throw new ActionWalCorruptionError(`action ${record.action_id} changed immutable WAL identity`);
  }
  if (!allowedTransition(actionPrevious.phase, record.phase)) {
    throw new ActionWalInvariantError(
      `invalid Action WAL transition ${actionPrevious.phase} -> ${record.phase}`,
    );
  }
}

function validateRecoveryRecords(records: readonly RecoveryAttemptRecord[]): void {
  const accepted: RecoveryAttemptRecord[] = [];
  for (const record of records) {
    validateRecoveryAppend(accepted, record);
    accepted.push(record);
  }
}

function validateRecoveryAppend(
  records: readonly RecoveryAttemptRecord[],
  record: RecoveryAttemptRecord,
): void {
  const { record_hash: recordHash, ...body } = record;
  if (sha256(stableStringify(body)) !== recordHash) {
    throw new ActionWalCorruptionError(`Recovery Ledger hash mismatch at sequence ${record.sequence}`);
  }
  const previous = records.at(-1);
  if (record.sequence !== (previous?.sequence ?? 0) + 1) {
    throw new ActionWalCorruptionError(`Recovery Ledger has non-monotonic sequence ${record.sequence}`);
  }
  if (record.previous_record_hash !== previous?.record_hash) {
    throw new ActionWalCorruptionError(`Recovery Ledger chain is broken at sequence ${record.sequence}`);
  }
  if (
    previous !== undefined
    && (record.run_id !== previous.run_id || record.project_id !== previous.project_id)
  ) {
    throw new ActionWalCorruptionError("Recovery Ledger changed its run identity");
  }
  if (records.some((item) => item.record_id === record.record_id)) {
    throw new ActionWalCorruptionError(`duplicate recovery record_id ${record.record_id}`);
  }
  const prior = [...records].reverse().find((item) => item.recovery_id === record.recovery_id);
  if (prior === undefined) {
    if (record.state !== "started" && record.state !== "escalated") {
      throw new RecoveryLedgerInvariantError("a recovery attempt must start before it finishes");
    }
    return;
  }
  if (prior.state !== "started") {
    throw new RecoveryLedgerInvariantError(`recovery ${record.recovery_id} already reached ${prior.state}`);
  }
  for (const key of [
    "project_id",
    "run_id",
    "action_id",
    "recipe_id",
    "attempt",
    "automatic",
    "started_at",
  ] as const) {
    if (record[key] !== prior[key]) {
      throw new ActionWalCorruptionError(`recovery ${record.recovery_id} changed ${key}`);
    }
  }
  if (record.state === "started") {
    throw new RecoveryLedgerInvariantError(`recovery ${record.recovery_id} has duplicate started state`);
  }
}

function immutableAction(record: ActionWalRecord): ActionWalPrepare {
  return ActionWalPrepareSchema.parse({
    project_id: record.project_id,
    run_id: record.run_id,
    action_id: record.action_id,
    workspace_handle_id: record.workspace_handle_id,
    workspace_root_hash: record.workspace_root_hash,
    workspace_kind: record.workspace_kind,
    patch_hash: record.patch_hash,
    targets: record.targets,
  });
}

function latestForAction(
  records: readonly ActionWalRecord[],
  actionId: string,
): ActionWalRecord | undefined {
  return [...records].reverse().find((record) => record.action_id === actionId);
}

function latestRecords(records: readonly ActionWalRecord[]): ActionWalRecord[] {
  const latest = new Map<string, ActionWalRecord>();
  for (const record of records) latest.set(`${record.run_id}\u0000${record.action_id}`, record);
  return [...latest.values()].sort(compareWalRecords);
}

function materializeRecoveryAttempts(
  records: readonly RecoveryAttemptRecord[],
): RecoveryAttemptRecord[] {
  const latest = new Map<string, RecoveryAttemptRecord>();
  for (const record of records) latest.set(record.recovery_id, record);
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
}

function allowedTransition(from: ActionWalPhase, to: ActionWalPhase): boolean {
  if (from === "prepare") return to === "applied" || to === "aborted";
  if (from === "applied") return to === "committed" || to === "aborted";
  if (from === "committed") return to === "verified" || to === "aborted";
  return false;
}

function compareWalRecords(left: ActionWalRecord, right: ActionWalRecord): number {
  const byRun = left.run_id.localeCompare(right.run_id);
  return byRun === 0 ? left.sequence - right.sequence : byRun;
}

function walPath(root: string, runId: string): string {
  return join(root, `run-${digest(runId)}.jsonl`);
}

function recoveryPath(root: string, runId: string): string {
  return join(root, `run-${digest(runId)}.jsonl`);
}

function backupPaths(root: string, backupRef: string): { data: string; metadata: string } {
  const key = digest(backupRef);
  return {
    data: join(root, `${key}.data`),
    metadata: join(root, `${key}.json`),
  };
}

function digest(value: string): string {
  return sha256(value).slice("sha256:".length);
}

function toBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

async function replaceFileDurably(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, false, "ledger directory");
  try {
    await checkedPrivateFileInfo(path, Number.MAX_SAFE_INTEGER, "ledger file");
  } catch (error) {
    if (!(error instanceof ActionWalNotFoundError)) throw error;
  }
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    await writeExclusiveFileDurably(temporary, content);
    temporaryCreated = true;
    await rename(temporary, path);
    temporaryCreated = false;
    await syncDirectory(parent);
  } catch (error) {
    if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeExclusiveFileDurably(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, false, "private data directory");
  let created = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(content);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readPrivateFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const before = await checkedPrivateFileInfo(path, maximumBytes, label);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertPrivateRegularFile(opened, maximumBytes, label);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ActionWalPathSafetyError(`${label} changed while opening`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function checkedPrivateFileInfo(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Stats> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ActionWalNotFoundError(basename(path));
    }
    throw error;
  }
  assertPrivateRegularFile(info, maximumBytes, label);
  return info;
}

function assertPrivateRegularFile(info: Stats, maximumBytes: number, label: string): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ActionWalPathSafetyError(`${label} must be a regular file, not a symbolic link`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ActionWalPathSafetyError(`${label} must be owned by the current user`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new ActionWalPathSafetyError(`${label} must not be accessible by group or others`);
  }
  if (info.size > maximumBytes) {
    throw new ActionWalCorruptionError(`${label} exceeds the configured maximum size`);
  }
}

async function ensurePrivateDirectory(path: string, create: boolean, label: string): Promise<void> {
  let created = false;
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    if (!create) throw new ActionWalPathSafetyError(`${label} does not exist`);
    await mkdir(path, { recursive: true, mode: 0o700 });
    created = true;
    info = await lstat(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ActionWalPathSafetyError(`${label} must be a real directory, not a symbolic link`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ActionWalPathSafetyError(`${label} must be owned by the current user`);
  }
  if ((info.mode & 0o077) !== 0 && !created) {
    throw new ActionWalPathSafetyError(`${label} must use private permissions`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseJsonl<T>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
  label: string,
): T[] {
  const text = decodeUtf8(bytes, label);
  if (text.length === 0) throw new ActionWalCorruptionError(`${label} file is empty`);
  if (!text.endsWith("\n")) throw new ActionWalCorruptionError(`${label} has a partial trailing record`);
  const lines = text.slice(0, -1).split("\n");
  const records: T[] = [];
  for (const line of lines) {
    if (line.length === 0) throw new ActionWalCorruptionError(`${label} contains an empty record`);
    try {
      records.push(schema.parse(JSON.parse(line)));
    } catch (error) {
      throw new ActionWalCorruptionError(`${label} contains an invalid record`, { cause: error });
    }
  }
  return records;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw new ActionWalCorruptionError(`${label} is not valid UTF-8`, { cause: error });
  }
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class ActionWalError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ActionWalError";
  }
}

export class ActionWalCorruptionError extends ActionWalError {
  constructor(message: string, options?: ErrorOptions) {
    super("action_wal_corrupt", message, options);
    this.name = "ActionWalCorruptionError";
  }
}

export class ActionWalInvariantError extends ActionWalError {
  constructor(message: string) {
    super("action_wal_invariant", message);
    this.name = "ActionWalInvariantError";
  }
}

export class RecoveryLedgerInvariantError extends ActionWalError {
  constructor(message: string) {
    super("recovery_ledger_invariant", message);
    this.name = "RecoveryLedgerInvariantError";
  }
}

export class ActionWalPathSafetyError extends ActionWalError {
  constructor(message: string) {
    super("action_wal_path_unsafe", message);
    this.name = "ActionWalPathSafetyError";
  }
}

export class ActionWalNotFoundError extends ActionWalError {
  constructor(target: string) {
    super("action_wal_not_found", `${target} was not found`);
    this.name = "ActionWalNotFoundError";
  }
}
