import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRecordV1MigrationEnvelopeSchema } from "@tracegraph/contracts";
import { MemoryMigrationError, migrateMemoryJsonlAdjacent } from "./memory-migration.js";

const hash = `sha256:${"b".repeat(64)}`;
const row = {
  memory_id: "memory:legacy",
  content: "A legacy memory row.",
  scope: { kind: "project", project_id: "project:one" },
  origin: "repository",
  trust: "trusted",
  version: 1,
  status: "confirmed",
  source_refs: [{ source_id: "source:readme", source_type: "repository", trust: "trusted" }],
  created_at: "2026-09-21T00:00:00.000Z",
  supersedes: [],
  content_hash: hash,
  candidate_id: "candidate:legacy",
  candidate_hash: hash,
  admission_id: "admission:legacy",
  admitted_at: "2026-09-21T00:01:00.000Z",
  admission_reason: "admitted by G-21",
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createSource(contents: string): Promise<{ directory: string; sourcePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "tracegraph-memory-migration-"));
  directories.push(directory);
  const sourcePath = join(directory, "records.jsonl");
  await writeFile(sourcePath, contents, { encoding: "utf8", mode: 0o600 });
  return { directory, sourcePath };
}

describe("adjacent Memory V2 migration", () => {
  it("publishes a private sidecar, preserves source bytes, and keeps every legacy field", async () => {
    const sourceBytes = ` ${JSON.stringify(row)} \n`;
    const { directory, sourcePath } = await createSource(sourceBytes);
    const result = await migrateMemoryJsonlAdjacent(sourcePath, {
      ownerId: "owner:one",
      migratedAt: "2026-09-30T01:00:00.000Z",
    });

    expect(result).toEqual({
      sourcePath,
      targetPath: join(directory, "records.v2.jsonl"),
      migratedCount: 1,
    });
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
    const migratedText = await readFile(result.targetPath, "utf8");
    const [migratedLine] = migratedText.trimEnd().split("\n");
    const envelope = MemoryRecordV1MigrationEnvelopeSchema.parse(JSON.parse(migratedLine ?? "{}"));
    expect(envelope.source.record).toEqual(row);
    expect(envelope.record.status).toBe("candidate");
    expect(envelope.record.governance.allowModelUse).toBe(false);
    expect(envelope.record.governance.allowExport).toBe(false);
    expect((await stat(result.targetPath)).mode & 0o077).toBe(0);
  });

  it("refuses to overwrite an existing sidecar and leaves both files untouched", async () => {
    const { directory, sourcePath } = await createSource(`${JSON.stringify(row)}\n`);
    const targetPath = join(directory, "records.v2.jsonl");
    const targetBytes = "reviewed content\n";
    await writeFile(targetPath, targetBytes, { encoding: "utf8", mode: 0o600 });
    const sourceBytes = await readFile(sourcePath, "utf8");

    const migration = migrateMemoryJsonlAdjacent(sourcePath, {
      ownerId: "owner:one",
      migratedAt: "2026-09-30T01:00:00.000Z",
    });
    await expect(migration).rejects.toMatchObject<Partial<MemoryMigrationError>>({ code: "memory_migration_target_exists" });

    expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
    expect(await readFile(targetPath, "utf8")).toBe(targetBytes);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("validates all rows before publishing and reports a corrupt source row", async () => {
    const sourceBytes = `${JSON.stringify(row)}\n{"memory_id":"broken"}\n`;
    const { directory, sourcePath } = await createSource(sourceBytes);

    const migration = migrateMemoryJsonlAdjacent(sourcePath, {
      ownerId: "owner:one",
      migratedAt: "2026-09-30T01:00:00.000Z",
    });
    await expect(migration).rejects.toMatchObject<Partial<MemoryMigrationError>>({
      code: "memory_migration_invalid_source",
    });
    await expect(migration).rejects.toThrow("Memory migration source row 2 is invalid");

    expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
    await expect(readFile(join(directory, "records.v2.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not guess an owner or leave output when the explicit owner is invalid", async () => {
    const sourceBytes = `${JSON.stringify(row)}\n`;
    const { directory, sourcePath } = await createSource(sourceBytes);

    await expect(migrateMemoryJsonlAdjacent(sourcePath, {
      ownerId: " ",
      migratedAt: "2026-09-30T01:00:00.000Z",
    })).rejects.toMatchObject<Partial<MemoryMigrationError>>({ code: "memory_migration_invalid_options" });
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
    await expect(readFile(join(directory, "records.v2.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
