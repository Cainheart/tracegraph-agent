import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  RecordedSessionSnapshotError,
  recordRecordedSessionSnapshot,
  refreshRecordedSessionSnapshot,
  replayRecordedSessionSnapshot,
} from "./runner.js";

const DEFAULT_SNAPSHOTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../snapshots");

interface CliArguments {
  readonly mode: "replay" | "record" | "refresh";
  readonly caseId: string;
  readonly snapshotsRoot: string;
  readonly sourceFile?: string;
  readonly write: boolean;
}

export async function runRecordedSessionCli(argv: readonly string[]): Promise<number> {
  let arguments_: CliArguments;
  try {
    arguments_ = parseArguments(argv);
  } catch (error) {
    writeError(error);
    return 2;
  }

  try {
    if (arguments_.mode === "replay") {
      const result = await replayRecordedSessionSnapshot({
        snapshotsRoot: arguments_.snapshotsRoot,
        caseId: arguments_.caseId,
      });
      process.stdout.write(`Replayed ${arguments_.caseId}: ${result.status}; ${result.events.length} semantic events.\n`);
      return 0;
    }
    if (arguments_.mode === "record") {
      const result = await recordRecordedSessionSnapshot({
        snapshotsRoot: arguments_.snapshotsRoot,
        caseId: arguments_.caseId,
        sourceFile: arguments_.sourceFile!,
        write: arguments_.write,
      });
      process.stdout.write(`Recorded candidate ${result.candidateDirectory}; ${result.result.status}; ${result.result.events.length} semantic events.\n`);
      return 0;
    }
    const result = await refreshRecordedSessionSnapshot({
      snapshotsRoot: arguments_.snapshotsRoot,
      caseId: arguments_.caseId,
      write: arguments_.write,
    });
    process.stdout.write(`${result.diff}\n`);
    process.stdout.write(result.written ? "Expected output refreshed.\n" : result.changed ? "Dry run only; pass --write to refresh.\n" : "Snapshot is current.\n");
    return 0;
  } catch (error) {
    writeError(error);
    return 1;
  }
}

function parseArguments(argv: readonly string[]): CliArguments {
  const mode = argv[0];
  if (mode !== "replay" && mode !== "record" && mode !== "refresh") {
    throw new RecordedSessionSnapshotError("snapshot_mode_invalid", "Mode is required: replay, record, or refresh");
  }
  const values = new Map<string, string>();
  let write = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") {
      if (write) throw invalidArguments();
      write = true;
      continue;
    }
    if (flag !== "--case" && flag !== "--root" && flag !== "--source") throw invalidArguments();
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(flag)) throw invalidArguments();
    values.set(flag, value);
    index += 1;
  }
  const caseId = values.get("--case");
  if (caseId === undefined) throw new RecordedSessionSnapshotError("snapshot_case_required", "--case profile/scenario is required");
  const sourceFile = values.get("--source");
  if (mode === "replay" && (write || sourceFile !== undefined)) {
    throw new RecordedSessionSnapshotError("snapshot_arguments_invalid", "Replay is read-only and does not accept --source or --write");
  }
  if (mode === "record" && (sourceFile === undefined || !write)) {
    throw new RecordedSessionSnapshotError("snapshot_write_required", "Record requires --source <capture.json> and explicit --write");
  }
  if (mode !== "record" && sourceFile !== undefined) {
    throw new RecordedSessionSnapshotError("snapshot_arguments_invalid", "--source is only valid for record");
  }
  return {
    mode,
    caseId,
    snapshotsRoot: values.get("--root") ?? DEFAULT_SNAPSHOTS_ROOT,
    ...(sourceFile === undefined ? {} : { sourceFile }),
    write,
  };
}

function invalidArguments(): RecordedSessionSnapshotError {
  return new RecordedSessionSnapshotError("snapshot_arguments_invalid", "Use only --case, --root, --source, and --write");
}

function writeError(error: unknown): void {
  if (error instanceof RecordedSessionSnapshotError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    return;
  }
  process.stderr.write("snapshot_failed: operation failed\n");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRecordedSessionCli(process.argv.slice(2));
}
