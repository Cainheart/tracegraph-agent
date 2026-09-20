import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  chunkMarkdown,
  createLocalRetrieval,
  JsonlIndexStore,
  RetrievalError,
} from "../src/index.js";
import { sha256 } from "../src/hash.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-retrieval-"));
  roots.push(root);
  return root;
}

describe("JsonlIndexStore", () => {
  it("atomically persists JSONL snapshots, isolates projects, and deduplicates unchanged content", async () => {
    const dataDir = await temporaryRoot();
    const retrieval = createLocalRetrieval({
      dataDir,
      now: () => new Date("2026-09-19T08:00:00.000Z"),
    });
    const first = await retrieval.ingest({
      project_id: "project:alpha",
      source_path: "docs/a.md",
      content: "# Alpha\n\nDurable retrieval content.",
    });
    const duplicate = await retrieval.ingest({
      project_id: "project:alpha",
      source_path: "docs/a.md",
      content: "# Alpha\n\nDurable retrieval content.",
    });
    await retrieval.ingest({
      project_id: "project:beta",
      source_path: "docs/a.md",
      content: "# Beta\n\nPrivate beta content.",
    });

    expect(first).toMatchObject({ status: "updated", generation: 1, source_chunk_count: 1 });
    expect(duplicate).toMatchObject({ status: "unchanged", generation: 1, total_indexed_chunks: 1 });
    expect((await retrieval.store.read("project:alpha")).chunks.map((chunk) => chunk.content))
      .toEqual(["# Alpha\n\nDurable retrieval content."]);
    expect((await retrieval.store.read("project:beta")).chunks.map((chunk) => chunk.content))
      .toEqual(["# Beta\n\nPrivate beta content."]);

    const projectDirectories = await readdir(dataDir);
    expect(projectDirectories).toHaveLength(2);
    for (const directory of projectDirectories) {
      const files = await readdir(join(dataDir, directory));
      expect(files).toEqual(["index.jsonl"]);
      const jsonl = await readFile(join(dataDir, directory, "index.jsonl"), "utf8");
      expect(jsonl.endsWith("\n")).toBe(true);
      expect(jsonl.split("\n").filter(Boolean).map((line) => JSON.parse(line).kind))
        .toEqual(["header", "source", "chunk", "footer"]);
    }
  });

  it("serializes concurrent updates without losing either source", async () => {
    const retrieval = createLocalRetrieval({ dataDir: await temporaryRoot() });
    const [left, right] = await Promise.all([
      retrieval.ingest({
        project_id: "project:concurrent",
        source_path: "left.md",
        content: "left unique term",
      }),
      retrieval.ingest({
        project_id: "project:concurrent",
        source_path: "right.md",
        content: "right unique term",
      }),
    ]);
    expect([left.generation, right.generation].sort()).toEqual([1, 2]);
    const snapshot = await retrieval.store.read("project:concurrent");
    expect(snapshot.sources.map((source) => source.source_path)).toEqual(["left.md", "right.md"]);
    expect(snapshot.chunks).toHaveLength(2);
  });

  it("recovers the last valid snapshot when the current JSONL is torn", async () => {
    const dataDir = await temporaryRoot();
    const retrieval = createLocalRetrieval({ dataDir });
    await retrieval.ingest({
      project_id: "project:recover",
      source_path: "first.md",
      content: "first durable version",
    });
    await retrieval.ingest({
      project_id: "project:recover",
      source_path: "second.md",
      content: "second version creates backup",
    });
    const [directory] = await readdir(dataDir);
    expect(directory).toBeDefined();
    await writeFile(join(dataDir, directory!, "index.jsonl"), "{\"kind\":\"header\"}\n", "utf8");

    const recovered = await retrieval.store.read("project:recover");
    expect(recovered.recovered_from).toBe("backup");
    expect(recovered.generation).toBe(1);
    expect(recovered.sources.map((source) => source.source_path)).toEqual(["first.md"]);

    const repaired = await retrieval.ingest({
      project_id: "project:recover",
      source_path: "first.md",
      content: "first durable version",
    });
    expect(repaired).toMatchObject({ status: "updated", generation: 2 });
    await expect(retrieval.store.read("project:recover")).resolves.not.toHaveProperty("recovered_from");
  });

  it("fails closed for first-generation corruption and unsafe symlink targets", async () => {
    const dataDir = await temporaryRoot();
    const retrieval = createLocalRetrieval({ dataDir });
    await retrieval.ingest({
      project_id: "project:unsafe",
      source_path: "safe.md",
      content: "safe text",
    });
    const [directory] = await readdir(dataDir);
    const indexPath = join(dataDir, directory!, "index.jsonl");
    await writeFile(indexPath, "truncated", "utf8");
    await expect(retrieval.store.read("project:unsafe"))
      .rejects.toMatchObject({ code: "index_corrupt" });

    await unlink(indexPath);
    const external = join(dataDir, "external.jsonl");
    await writeFile(external, "outside\n", "utf8");
    await symlink(external, indexPath);
    await expect(retrieval.store.read("project:unsafe"))
      .rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects forged chunks before creating an index", async () => {
    const dataDir = await temporaryRoot();
    const store = new JsonlIndexStore({ dataDir });
    const [chunk] = chunkMarkdown({
      project_id: "project:forgery",
      source_path: "source.md",
      content: "trusted content",
    });
    expect(chunk).toBeDefined();
    await expect(store.replaceSource({
      project_id: "project:forgery",
      source_path: "source.md",
      document_hash: sha256("trusted content"),
      chunks: [{ ...chunk!, content: "forged content" }],
    })).rejects.toMatchObject({ code: "invalid_chunk" });
    expect(await readdir(dataDir).catch(() => [])).toEqual([]);
  });

  it("enforces the configured byte bound without replacing the prior snapshot", async () => {
    const dataDir = await temporaryRoot();
    const retrieval = createLocalRetrieval({ dataDir, maxIndexBytes: 64 * 1024 });
    await retrieval.ingest({
      project_id: "project:bounded",
      source_path: "small.md",
      content: "small original",
    });
    await expect(retrieval.ingest({
      project_id: "project:bounded",
      source_path: "large.md",
      content: Array.from({ length: 80 }, () => "large-token ".repeat(100).trim()).join("\n\n"),
    })).rejects.toMatchObject({ code: "index_too_large" });
    const snapshot = await retrieval.store.read("project:bounded");
    expect(snapshot.sources.map((source) => source.source_path)).toEqual(["small.md"]);
  });

  it("rejects non-absolute data roots with a typed, content-free error", () => {
    expect(() => new JsonlIndexStore({ dataDir: "relative/index" }))
      .toThrowError(expect.objectContaining<Partial<RetrievalError>>({ code: "invalid_data_dir" }));
  });
});
