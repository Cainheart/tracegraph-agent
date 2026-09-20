import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RetrievalServiceClientError,
  createRetrievalService,
  createRetrievalServiceClient,
  isRetrievalServiceUnavailable,
  type RetrievalService,
} from "../src/index.js";

const services: RetrievalService[] = [];
const temporaryDirectories: string[] = [];
const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("retrieval-service client", () => {
  it("drives health, ingest, and search against the standalone service", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tracegraph-retrieval-client-"));
    temporaryDirectories.push(dataDir);
    const service = await createRetrievalService({ dataDir, authorizationToken: "client-token" });
    services.push(service);
    const baseUrl = await service.listen({ port: 0 });
    const client = createRetrievalServiceClient({ baseUrl, token: "client-token" });

    await expect(client.health()).resolves.toMatchObject({ status: "ok", backend: "jsonl_bm25" });
    await expect(client.ingest({
      project_id: "project-a",
      source_path: "docs/context.md",
      content: "# Context\n\nRetrieved evidence must preserve citations.\n",
    })).resolves.toMatchObject({
      project_id: "project-a",
      source_path: "docs/context.md",
      status: "updated",
    });
    const result = await client.search({
      project_id: "project-a",
      query: "retrieved evidence citation",
      top_k: 3,
    });
    expect(result.query_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.hits).toMatchObject([{ source_path: "docs/context.md", start_line: 1 }]);
  });

  it("does not classify authentication and request errors as service absence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tracegraph-retrieval-auth-"));
    temporaryDirectories.push(dataDir);
    const service = await createRetrievalService({ dataDir, authorizationToken: "right-token" });
    services.push(service);
    const baseUrl = await service.listen({ port: 0 });
    const client = createRetrievalServiceClient({ baseUrl, token: "wrong-token" });

    const authorizationError = await client.search({
      project_id: "project-a",
      query: "checkpoint",
    }).catch((error: unknown) => error);
    expect(authorizationError).toBeInstanceOf(RetrievalServiceClientError);
    expect(authorizationError).toMatchObject({ status: 401, code: "unauthorized", retryable: false });
    expect(isRetrievalServiceUnavailable(authorizationError)).toBe(false);

    const requestError = await client.search({
      project_id: " project-a",
      query: "checkpoint",
    }).catch((error: unknown) => error);
    expect(requestError).toMatchObject({ status: 0, code: "invalid_request", retryable: false });
    expect(isRetrievalServiceUnavailable(requestError)).toBe(false);
  });

  it("marks only network, timeout, and 502-504 responses as fallback-safe", async () => {
    const networkClient = createRetrievalServiceClient({
      baseUrl: "http://127.0.0.1:4312",
      fetch: vi.fn(async () => { throw new TypeError("connect ECONNREFUSED secret-host"); }) as typeof fetch,
    });
    const networkError = await networkClient.health().catch((error: unknown) => error);
    expect(networkError).toMatchObject({ status: 0, code: "service_unavailable", retryable: true });
    expect(isRetrievalServiceUnavailable(networkError)).toBe(true);
    expect(String(networkError)).not.toContain("secret-host");

    const gatewayClient = createRetrievalServiceClient({
      baseUrl: "http://127.0.0.1:4312",
      fetch: vi.fn(async () => Response.json({
        schema_version: "tracegraph.retrieval-service.error.v1",
        error: "backend_unavailable",
        message: "Retrieval backend is unavailable",
      }, { status: 503 })) as typeof fetch,
    });
    const gatewayError = await gatewayClient.health().catch((error: unknown) => error);
    expect(isRetrievalServiceUnavailable(gatewayError)).toBe(true);

    const internalClient = createRetrievalServiceClient({
      baseUrl: "http://127.0.0.1:4312",
      fetch: vi.fn(async () => Response.json({
        schema_version: "tracegraph.retrieval-service.error.v1",
        error: "internal_error",
        message: "Internal error",
      }, { status: 500 })) as typeof fetch,
    });
    const internalError = await internalClient.health().catch((error: unknown) => error);
    expect(internalError).toMatchObject({ status: 500, retryable: false });
    expect(isRetrievalServiceUnavailable(internalError)).toBe(false);
  });

  it("distinguishes its own deadline from caller cancellation", async () => {
    // The client deadline must win even when an injected transport ignores
    // AbortSignal entirely.
    const ignoreAbort = vi.fn(async () => new Promise<Response>(() => undefined)) as typeof fetch;
    const timedClient = createRetrievalServiceClient({
      baseUrl: "http://127.0.0.1:4312",
      timeoutMs: 10,
      fetch: ignoreAbort,
    });
    const timeout = await timedClient.health().catch((error: unknown) => error);
    expect(timeout).toMatchObject({ code: "request_timeout", retryable: true });
    expect(isRetrievalServiceUnavailable(timeout)).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await timedClient.health({ signal: controller.signal }).catch((error: unknown) => error);
    expect(cancelled).toMatchObject({ code: "request_aborted", retryable: false });
    expect(isRetrievalServiceUnavailable(cancelled)).toBe(false);
  });

  it("rejects non-JSON, malformed, and cross-project success responses", async () => {
    const cases: Array<{ response: Response; expected: string }> = [
      { response: new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }), expected: "invalid_response" },
      { response: new Response("{", { status: 200, headers: { "content-type": "application/json" } }), expected: "invalid_response" },
      {
        response: Response.json({
          schema_version: "tracegraph.retrieval.v1",
          project_id: "project-b",
          query_hash: sha256("checkpoint"),
          total_indexed_chunks: 0,
          hits: [],
        }),
        expected: "invalid_response",
      },
      {
        response: Response.json({
          schema_version: "tracegraph.retrieval.v1",
          project_id: "project-a",
          query_hash: `sha256:${"a".repeat(64)}`,
          total_indexed_chunks: 0,
          hits: [],
        }),
        expected: "invalid_response",
      },
    ];
    for (const testCase of cases) {
      const client = createRetrievalServiceClient({
        baseUrl: "http://127.0.0.1:4312",
        fetch: vi.fn(async () => testCase.response) as typeof fetch,
      });
      const error = await client.search({ project_id: "project-a", query: "checkpoint" })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: testCase.expected, retryable: false });
      expect(isRetrievalServiceUnavailable(error)).toBe(false);
    }
  });

  it("validates base URLs and timeout bounds before issuing requests", () => {
    expect(() => createRetrievalServiceClient({ baseUrl: "file:///tmp/index" })).toThrow(/HTTP/u);
    expect(() => createRetrievalServiceClient({ baseUrl: "http://user:secret@localhost:4312" })).toThrow(/without credentials/u);
    expect(() => createRetrievalServiceClient({ baseUrl: "http://localhost:4312", timeoutMs: 0 })).toThrow(/timeoutMs/u);
  });
});
