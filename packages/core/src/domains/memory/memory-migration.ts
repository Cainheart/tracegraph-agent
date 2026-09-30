import { open, link, readFile, unlink } from "node:fs/promises";
import { dirname, extname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  migrateMemoryRecordV1ToV2,
  type MemoryRecordV1MigrationEnvelope,
} from "@tracegraph/contracts";

export type MemoryMigrationErrorCode =
  | "memory_migration_invalid_options"
  | "memory_migration_invalid_source"
  | "memory_migration_target_exists"
  | "memory_migration_publish_failed";

export class MemoryMigrationError extends Error {
  readonly code: MemoryMigrationErrorCode;

  constructor(code: MemoryMigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryMigrationError";
    this.code = code;
  }
}

export interface MemoryMigrationResult {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly migratedCount: number;
}

/**
 * Creates a review-gated V2 sidecar while keeping the G-21 JSONL canonical
 * file byte-identical. The sidecar is never loaded by JsonlMemoryStore.
 */
export async function migrateMemoryJsonlAdjacent(
  sourcePath: string,
  options: { ownerId: string; migratedAt?: string },
): Promise<MemoryMigrationResult> {
  let ownerId: string;
  let migratedAt: string;
  try {
    ownerId = IdentifierSchema.parse(options.ownerId);
    migratedAt = IsoDateTimeSchema.parse(options.migratedAt ?? new Date().toISOString());
  } catch {
    throw new MemoryMigrationError(
      "memory_migration_invalid_options",
      "Memory migration requires a valid explicit owner id and migration time",
    );
  }
  const sourceText = await readFile(sourcePath, "utf8");
  const envelopes: MemoryRecordV1MigrationEnvelope[] = [];
  const rows = sourceText.split("\n");

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined || row.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row) as unknown;
      envelopes.push(migrateMemoryRecordV1ToV2(parsed, { ownerId, migratedAt }));
    } catch {
      throw new MemoryMigrationError(
        "memory_migration_invalid_source",
        `Memory migration source row ${index + 1} is invalid`,
      );
    }
  }

  const targetPath = adjacentV2Path(sourcePath);
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  const output = envelopes.map((envelope) => JSON.stringify(envelope)).join("\n");
  const outputText = output.length === 0 ? "" : `${output}\n`;
  let handle;
  let temporaryCreated = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(outputText, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    throw new MemoryMigrationError(
      "memory_migration_publish_failed",
      "Could not prepare the adjacent Memory V2 migration file",
      { cause: error },
    );
  }
  await handle.close();

  let published = false;
  try {
    // Hard-link publication is atomic and exclusive: it exposes only the
    // complete, fsynced file and cannot replace an existing target.
    await link(temporaryPath, targetPath);
    published = true;
    await unlink(temporaryPath);
    temporaryCreated = false;
  } catch (error) {
    // If publication succeeded but unlinking the temporary name failed, keep
    // the complete target in place; deleting it could race with a later owner.
    if (!published && temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (isAlreadyExists(error)) {
      throw new MemoryMigrationError(
        "memory_migration_target_exists",
        "Adjacent Memory V2 migration target already exists; refusing to overwrite it",
        { cause: error },
      );
    }
    throw new MemoryMigrationError(
      "memory_migration_publish_failed",
      "Could not publish the adjacent Memory V2 migration file",
      { cause: error },
    );
  }

  return { sourcePath, targetPath, migratedCount: envelopes.length };
}

function adjacentV2Path(sourcePath: string): string {
  const extension = extname(sourcePath);
  if (extension === ".jsonl") {
    return join(dirname(sourcePath), `${basename(sourcePath, extension)}.v2.jsonl`);
  }
  return `${sourcePath}.v2.jsonl`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "EEXIST";
}
