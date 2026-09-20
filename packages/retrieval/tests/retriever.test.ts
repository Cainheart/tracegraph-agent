import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalRetrieval, tokenize } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRetrieval() {
  const dataDir = await mkdtemp(join(tmpdir(), "tracegraph-bm25-"));
  roots.push(dataDir);
  return createLocalRetrieval({ dataDir, maxChunkChars: 128 });
}

describe("Bm25Retriever", () => {
  it("ranks BM25 hits, applies top_k, and returns auditable source ranges", async () => {
    const retrieval = await createRetrieval();
    await retrieval.ingest({
      project_id: "project:search",
      source_path: "docs/recovery.md",
      content: "# Recovery\n\nAtomic recovery recovery uses a durable write-ahead log.\n\nUnrelated appendix.",
    });
    await retrieval.ingest({
      project_id: "project:search",
      source_path: "docs/other.md",
      content: "# Other\n\nRecovery is mentioned once alongside gardening.",
    });

    const response = await retrieval.search({
      project_id: "project:search",
      query: "  recovery durable  ",
      top_k: 1,
    });
    expect(response).toMatchObject({
      schema_version: "tracegraph.retrieval.v1",
      project_id: "project:search",
      query_hash: `sha256:${createHash("sha256").update("recovery durable").digest("hex")}`,
      total_indexed_chunks: 2,
    });
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]).toMatchObject({
      rank: 1,
      source_path: "docs/recovery.md",
      start_line: 1,
      end_line: 5,
      heading_path: ["Recovery"],
    });
    expect(response.hits[0]!.score).toBeGreaterThan(0);
    expect(await retrieval.readChunk({
      project_id: "project:search",
      chunk_id: response.hits[0]!.chunk_id,
    })).toMatchObject({
      content: response.hits[0]!.content,
      source_path: "docs/recovery.md",
      start_line: 1,
      end_line: 5,
    });
  });

  it("supports deterministic CJK tokenization and project isolation", async () => {
    const retrieval = await createRetrieval();
    await retrieval.ingest({
      project_id: "project:zh",
      source_path: "记忆.md",
      content: "# 长期记忆\n\n检索系统保存准确引用。",
    });
    await retrieval.ingest({
      project_id: "project:other",
      source_path: "secret.md",
      content: "检索系统中的跨项目秘密。",
    });
    expect(tokenize("长期 Memory-Store")).toEqual(["长", "期", "memory-store"]);
    const result = await retrieval.search({ project_id: "project:zh", query: "检索引用" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.source_path).toBe("记忆.md");
    expect(JSON.stringify(result)).not.toContain("跨项目秘密");
  });

  it("deduplicates identical chunk content by hash so copies cannot crowd top_k", async () => {
    const retrieval = await createRetrieval();
    for (const source_path of ["copy-a.md", "copy-b.md"]) {
      await retrieval.ingest({
        project_id: "project:dedupe",
        source_path,
        content: "identical searchable evidence",
      });
    }
    const result = await retrieval.search({
      project_id: "project:dedupe",
      query: "searchable evidence",
      top_k: 8,
    });
    expect(result.total_indexed_chunks).toBe(2);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.source_path).toBe("copy-a.md");
  });

  it("returns an empty hit set for absent terms and rejects invalid queries/top_k", async () => {
    const retrieval = await createRetrieval();
    await retrieval.ingest({
      project_id: "project:validation",
      source_path: "doc.md",
      content: "searchable content",
    });
    await expect(retrieval.search({ project_id: "project:validation", query: "absent" }))
      .resolves.toMatchObject({ hits: [] });
    await expect(retrieval.search({ project_id: "project:validation", query: "!!!" }))
      .rejects.toMatchObject({ code: "invalid_query" });
    await expect(retrieval.search({ project_id: "project:validation", query: "searchable", top_k: 0 }))
      .rejects.toMatchObject({ code: "invalid_top_k" });
    await expect(retrieval.readChunk({ project_id: "project:validation", chunk_id: "bad" }))
      .rejects.toMatchObject({ code: "invalid_chunk" });
  });

  it("honors an already-aborted search and exposes a local health result", async () => {
    const retrieval = await createRetrieval();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(retrieval.search({
      project_id: "project:abort",
      query: "anything",
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
    await expect(retrieval.health()).resolves.toEqual({
      schema_version: "tracegraph.retrieval.v1",
      status: "ok",
      backend: "jsonl_bm25",
    });
  });
});
