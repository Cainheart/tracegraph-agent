import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRetrievalService,
  type RetrievalEmbeddingProvider,
  type RetrievalService,
  type RetrievalServiceBackend,
} from "../src/index.js";

const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const services: RetrievalService[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function backend(overrides: Partial<RetrievalServiceBackend> = {}): RetrievalServiceBackend {
  const base: RetrievalServiceBackend = {
    async health() {
      return { status: "ok", backend: "test_backend" };
    },
    async ingest(input) {
      return {
      schema_version: "tracegraph.retrieval.v1",
      project_id: input.project_id,
      source_path: input.source_path,
      document_hash: sha256(input.content),
      status: "updated",
      generation: 1,
      source_chunk_count: 1,
      total_indexed_chunks: 1,
      };
    },
    async search(input) {
      return {
        schema_version: "tracegraph.retrieval.v1",
        project_id: input.project_id,
        query_hash: sha256(input.query),
        total_indexed_chunks: 1,
        hits: [{
          rank: 1,
          chunk_id: `chunk:${"b".repeat(64)}`,
          content_hash: sha256("durable checkpoint recovery"),
          score: 3.5,
          source_path: "docs/guide.md",
          start_line: 2,
          end_line: 4,
          heading_path: ["Guide"],
          content: "durable checkpoint recovery",
        }],
      };
    },
  };
  return { ...base, ...overrides };
}

async function serviceWith(input: Parameters<typeof createRetrievalService>[0]): Promise<RetrievalService> {
  const service = await createRetrievalService(input);
  services.push(service);
  return service;
}

describe("retrieval-service HTTP boundary", () => {
  it("returns a strict health document and rejects query/body drift", async () => {
    const service = await serviceWith({ backend: backend() });

    const response = await service.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/u);
    expect(response.json()).toEqual({
      schema_version: "tracegraph.retrieval-service.v1",
      status: "ok",
      backend: "test_backend",
      embedding_provider: null,
    });

    const queryDrift = await service.app.inject({ method: "GET", url: "/health?verbose=true" });
    expect(queryDrift.statusCode).toBe(400);
    expect(queryDrift.json()).toMatchObject({ error: "invalid_request" });

    const unexpectedBody = await service.app.inject({
      method: "GET",
      url: "/health",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(unexpectedBody.statusCode).toBe(400);
    expect(unexpectedBody.json()).toMatchObject({ error: "unexpected_body" });
  });

  it("enforces bearer auth, JSON media type, strict fields, and source path safety", async () => {
    const service = await serviceWith({ backend: backend(), authorizationToken: "secret-token" });
    const valid = {
      project_id: "project-a",
      source_path: "docs/guide.md",
      content: "# Guide\n\nUse durable checkpoints.",
    };

    const unauthorized = await service.app.inject({ method: "POST", url: "/ingest", payload: valid });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({ error: "unauthorized" });

    const wrongType = await service.app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer secret-token", "content-type": "text/plain" },
      payload: JSON.stringify(valid),
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toMatchObject({ error: "unsupported_media_type" });

    const unsafePath = await service.app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer secret-token" },
      payload: { ...valid, source_path: "../secret.md" },
    });
    expect(unsafePath.statusCode).toBe(400);
    expect(unsafePath.json()).toMatchObject({ error: "invalid_request" });

    const unknownField = await service.app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer secret-token" },
      payload: { ...valid, tenant_override: "project-b" },
    });
    expect(unknownField.statusCode).toBe(400);

    const accepted = await service.app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer secret-token" },
      payload: valid,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ project_id: "project-a", source_path: "docs/guide.md" });
  });

  it("uses the real JSONL/BM25 backend without leaking documents across projects", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tracegraph-retrieval-service-"));
    temporaryDirectories.push(dataDir);
    const service = await serviceWith({ dataDir });

    const ingested = await service.app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        project_id: "project-a",
        source_path: "docs/recovery.md",
        content: "# Recovery\n\nDurable checkpoints restore interrupted sessions.\n",
      },
    });
    expect(ingested.statusCode).toBe(200);
    expect(ingested.json()).toMatchObject({ project_id: "project-a", source_chunk_count: 1 });

    const found = await service.app.inject({
      method: "POST",
      url: "/search",
      payload: { project_id: "project-a", query: "durable checkpoint", top_k: 3 },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      project_id: "project-a",
      hits: [{ source_path: "docs/recovery.md", start_line: 1 }],
    });
    expect(found.json().hits[0].end_line).toBeGreaterThanOrEqual(found.json().hits[0].start_line);

    const isolated = await service.app.inject({
      method: "POST",
      url: "/search",
      payload: { project_id: "project-b", query: "durable checkpoint" },
    });
    expect(isolated.statusCode).toBe(200);
    expect(isolated.json()).toMatchObject({ project_id: "project-b", total_indexed_chunks: 0, hits: [] });
  });

  it("passes the embedding/provider seam to a replaceable backend", async () => {
    const provider: RetrievalEmbeddingProvider = {
      id: "test-embedding-v1",
      embed: vi.fn(async ({ texts }) => texts.map(() => [0.25, 0.75])),
    };
    const search: RetrievalServiceBackend["search"] = vi.fn(async (input, context) => {
      expect(context.embeddingProvider).toBe(provider);
      expect(context.signal.aborted).toBe(false);
      return backend().search(input, context);
    });
    const service = await serviceWith({ backend: backend({ search }), embeddingProvider: provider });

    const health = await service.app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({ embedding_provider: "test-embedding-v1" });
    const response = await service.app.inject({
      method: "POST",
      url: "/search",
      payload: { project_id: "project-a", query: "checkpoint" },
    });
    expect(response.statusCode).toBe(200);
    expect(search).toHaveBeenCalledOnce();
  });

  it("aborts a slow backend at the operation deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const service = await serviceWith({
      operationTimeoutMs: 15,
      backend: backend({
        search: vi.fn(async (_input, context): Promise<never> => {
          observedSignal = context.signal;
          return new Promise<never>(() => undefined);
        }),
      }),
    });
    const response = await service.app.inject({
      method: "POST",
      url: "/search",
      payload: { project_id: "project-a", query: "checkpoint" },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: "request_timeout" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects oversized requests and masks backend failures", async () => {
    const service = await serviceWith({
      bodyLimitBytes: 128,
      backend: backend({
        search: vi.fn(async () => { throw new Error("/private/index/path: api-key-secret"); }),
      }),
    });
    const oversized = await service.app.inject({
      method: "POST",
      url: "/ingest",
      payload: { project_id: "project-a", source_path: "a.md", content: "x".repeat(500) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body).not.toContain("xxxxx");

    const unavailable = await service.app.inject({
      method: "POST",
      url: "/search",
      payload: { project_id: "project-a", query: "checkpoint" },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: "backend_unavailable" });
    expect(unavailable.body).not.toContain("api-key-secret");
    expect(unavailable.body).not.toContain("/private/index/path");
  });

  it("fails closed when a backend crosses the requested project scope", async () => {
    const service = await serviceWith({
      backend: backend({
        search: vi.fn(async (input, context) => ({
          ...await backend().search(input, context),
          project_id: "project-b",
        })),
      }),
    });
    const response = await service.app.inject({
      method: "POST",
      url: "/search",
      payload: { project_id: "project-a", query: "checkpoint" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "backend_scope_violation" });

    const corruptService = await serviceWith({
      backend: backend({
        search: vi.fn(async (input, context) => ({
          ...await backend().search(input, context),
          query_hash: `sha256:${"0".repeat(64)}`,
        })),
      }),
    });
    const corrupt = await corruptService.app.inject({
      method: "POST",
      url: "/search",
      payload: { project_id: "project-a", query: "checkpoint" },
    });
    expect(corrupt.statusCode).toBe(502);
    expect(corrupt.json()).toMatchObject({ error: "backend_integrity_violation" });
  });

  it("keeps its network listener loopback-only and closes an injected backend once", async () => {
    const close = vi.fn(async () => undefined);
    const service = await serviceWith({ backend: backend({ close }) });
    await expect(service.listen({ host: "0.0.0.0" as "127.0.0.1" })).rejects.toThrow(/loopback/u);
    const address = await service.listen({ host: "127.0.0.1", port: 0 });
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    await service.close();
    await service.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
