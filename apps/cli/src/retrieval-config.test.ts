import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalRetrieval } from "@tracegraph/retrieval";
import { afterEach, describe, expect, it } from "vitest";
import { createConfiguredRetrieval } from "./retrieval-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI retrieval composition", () => {
  it("uses the durable local provider by default", async () => {
    const root = await temporaryRoot();
    const configured = createConfiguredRetrieval({ dataDir: root, environment: {} });
    expect(configured.mode).toBe("local");

    await configured.retriever.ingest?.({
      project_id: "project:local",
      source_path: "memory/local.md",
      content: "# Verification\n\nUse pnpm coverage for the production source gate.\n",
    });
    const result = await configured.retriever.search({
      project_id: "project:local",
      query: "production source coverage gate",
      top_k: 1,
    });
    expect(result).toMatchObject({
      project_id: "project:local",
      hits: [expect.objectContaining({ source_path: "memory/local.md" })],
    });
  });

  it("falls back on an unavailable service and keeps a local write-through copy", async () => {
    const root = await temporaryRoot();
    const configured = createConfiguredRetrieval({
      dataDir: root,
      environment: { TRACEGRAPH_RETRIEVAL_URL: "http://127.0.0.1:4312" },
      fetch: async () => { throw new TypeError("connection refused"); },
    });
    expect(configured.mode).toBe("remote_with_local_fallback");

    await configured.retriever.ingest?.({
      project_id: "project:fallback",
      source_path: "memory/fallback.md",
      content: "The canonical fallback command is pnpm test:e2e.\n",
    });
    const result = await configured.retriever.search({
      project_id: "project:fallback",
      query: "canonical fallback command",
      top_k: 1,
    });
    expect(result).toMatchObject({
      project_id: "project:fallback",
      hits: [expect.objectContaining({ content: expect.stringContaining("pnpm test:e2e") })],
    });
  });

  it("does not hide authentication or contract failures behind local retrieval", async () => {
    const root = await temporaryRoot();
    const configured = createConfiguredRetrieval({
      dataDir: root,
      environment: { TRACEGRAPH_RETRIEVAL_URL: "http://127.0.0.1:4312" },
      fetch: async () => new Response(JSON.stringify({
        schema_version: "tracegraph.retrieval-service.error.v1",
        error: "unauthorized",
        message: "A valid bearer token is required",
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });
    const input = {
      project_id: "project:closed",
      source_path: "memory/closed.md",
      content: "This must not be written after a remote auth failure.\n",
    };
    await expect(configured.retriever.ingest?.(input)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });

    const local = createLocalRetrieval({ dataDir: join(root, "retrieval-index") });
    await expect(local.search({
      project_id: input.project_id,
      query: "remote auth failure",
    })).resolves.toMatchObject({ hits: [], total_indexed_chunks: 0 });
  });

  it("validates the configured timeout before constructing a client", async () => {
    const root = await temporaryRoot();
    expect(() => createConfiguredRetrieval({
      dataDir: root,
      environment: {
        TRACEGRAPH_RETRIEVAL_URL: "http://127.0.0.1:4312",
        TRACEGRAPH_RETRIEVAL_TIMEOUT_MS: "0",
      },
    })).toThrow(/TRACEGRAPH_RETRIEVAL_TIMEOUT_MS/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-cli-retrieval-"));
  roots.push(root);
  return root;
}
