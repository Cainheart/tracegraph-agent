import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import {
  RetrievalError,
  createLocalRetrieval,
} from "@tracegraph/retrieval";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z, ZodError, type ZodType } from "zod";
import {
  RETRIEVAL_SERVICE_ERROR_SCHEMA_VERSION,
  RETRIEVAL_SERVICE_SCHEMA_VERSION,
  RetrievalIndexUpdateSchema,
  RetrievalIngestRequestSchema,
  RetrievalSearchRequestSchema,
  RetrievalSearchResponseSchema,
  RetrievalServiceHealthSchema,
  type RetrievalIndexUpdate,
  type RetrievalIngestRequest,
  type RetrievalSearchRequest,
  type RetrievalSearchResponse,
  type RetrievalServiceHealth,
} from "./contracts.js";

const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
const MAX_BODY_LIMIT_BYTES = 8 * 1_048_576;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const EmptyObjectSchema = z.strictObject({});

export interface RetrievalEmbeddingProvider {
  readonly id: string;
  embed(
    input: { readonly texts: readonly string[] },
    context: { readonly signal: AbortSignal },
  ): Promise<readonly (readonly number[])[]>;
}

export interface RetrievalBackendContext {
  readonly signal: AbortSignal;
  readonly embeddingProvider?: RetrievalEmbeddingProvider;
}

export interface RetrievalBackendHealth {
  readonly status: "ok";
  readonly backend: string;
}

/**
 * Transport-neutral seam for BM25 today and a vector/Qdrant adapter later.
 * Implementations must keep every operation scoped to input.project_id.
 */
export interface RetrievalServiceBackend {
  health(context: RetrievalBackendContext): Promise<RetrievalBackendHealth>;
  ingest(
    input: RetrievalIngestRequest,
    context: RetrievalBackendContext,
  ): Promise<RetrievalIndexUpdate>;
  search(
    input: RetrievalSearchRequest,
    context: RetrievalBackendContext,
  ): Promise<RetrievalSearchResponse>;
  close?(): Promise<void>;
}

export interface LocalJsonlBm25BackendOptions {
  dataDir: string;
}

export interface CreateRetrievalServiceOptions {
  /** Defaults to a project-hashed JSONL/BM25 index under .tracegraph. */
  dataDir?: string;
  backend?: RetrievalServiceBackend;
  embeddingProvider?: RetrievalEmbeddingProvider;
  bodyLimitBytes?: number;
  operationTimeoutMs?: number;
  /** When set, /ingest and /search require this bearer token. /health stays public. */
  authorizationToken?: string;
  logger?: boolean;
}

export interface RetrievalService {
  readonly app: FastifyInstance;
  listen(options?: { port?: number; host?: "127.0.0.1" | "::1" }): Promise<string>;
  close(): Promise<void>;
}

class RetrievalServiceOperationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RetrievalServiceOperationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createLocalJsonlBm25Backend(
  options: LocalJsonlBm25BackendOptions,
): RetrievalServiceBackend {
  const index = createLocalRetrieval({ dataDir: resolve(options.dataDir) });
  return {
    async health() {
      const health = await index.health();
      return { status: health.status, backend: health.backend };
    },
    async ingest(input, context) {
      return index.ingest({ ...input, signal: context.signal });
    },
    async search(input, context) {
      const result = await index.search({
        project_id: input.project_id,
        query: input.query,
        signal: context.signal,
        ...(input.top_k === undefined ? {} : { top_k: input.top_k }),
      });
      return {
        ...result,
        hits: result.hits.map((hit) => ({
          ...hit,
          heading_path: [...hit.heading_path],
        })),
      };
    },
  };
}

export async function createRetrievalService(
  options: CreateRetrievalServiceOptions = {},
): Promise<RetrievalService> {
  const bodyLimitBytes = boundedInteger(
    options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    "bodyLimitBytes",
    1,
    MAX_BODY_LIMIT_BYTES,
  );
  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    "operationTimeoutMs",
    1,
    MAX_OPERATION_TIMEOUT_MS,
  );
  if (options.authorizationToken !== undefined
    && (options.authorizationToken.length === 0 || options.authorizationToken.length > 4_096)) {
    throw new TypeError("authorizationToken must contain between 1 and 4096 characters");
  }
  if (options.embeddingProvider !== undefined) {
    const parsedId = z.string().min(1).max(128).refine((value) => (
      value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
    )).safeParse(options.embeddingProvider.id);
    if (!parsedId.success) throw new TypeError("embeddingProvider.id must be 1-128 characters");
  }

  const backend = options.backend ?? createLocalJsonlBm25Backend({
    dataDir: options.dataDir ?? resolve(process.cwd(), ".tracegraph", "retrieval-index"),
  });
  const app = Fastify({
    bodyLimit: bodyLimitBytes,
    requestTimeout: operationTimeoutMs,
    logger: options.logger === true
      ? {
          redact: {
            paths: ["req.headers.authorization", "req.body.content", "req.body.query"],
            censor: "[REDACTED]",
          },
        }
      : false,
  });

  app.setErrorHandler((error, _request, reply) => {
    sendError(reply, toHttpError(error));
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    void reply.header("cache-control", "no-store");
    void reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, new RetrievalServiceOperationError(404, "route_not_found", "Route not found"));
  });

  app.get("/health", async (request) => {
    EmptyObjectSchema.parse(request.query);
    rejectUnexpectedBody(request);
    return withOperationTimeout(request, operationTimeoutMs, async (context) => {
      const health = await backend.health(withEmbedding(context, options.embeddingProvider));
      const response: RetrievalServiceHealth = {
        schema_version: RETRIEVAL_SERVICE_SCHEMA_VERSION,
        status: health.status,
        backend: health.backend,
        embedding_provider: options.embeddingProvider?.id ?? null,
      };
      return parseBackendResponse(RetrievalServiceHealthSchema, response);
    });
  });

  app.post("/ingest", async (request) => {
    requireJson(request);
    requireAuthorization(request, options.authorizationToken);
    EmptyObjectSchema.parse(request.query);
    const input = RetrievalIngestRequestSchema.parse(request.body);
    return withOperationTimeout(request, operationTimeoutMs, async (context) => {
      const result = parseBackendResponse(
        RetrievalIndexUpdateSchema,
        await backend.ingest(input, withEmbedding(context, options.embeddingProvider)),
      );
      if (result.project_id !== input.project_id || result.source_path !== input.source_path) {
        throw new RetrievalServiceOperationError(
          502,
          "backend_scope_violation",
          "Retrieval backend returned data outside the request scope",
        );
      }
      if (result.document_hash !== sha256(input.content)
        || result.source_chunk_count > result.total_indexed_chunks) {
        throw new RetrievalServiceOperationError(
          502,
          "backend_integrity_violation",
          "Retrieval backend returned data that failed integrity checks",
        );
      }
      return result;
    });
  });

  app.post("/search", async (request) => {
    requireJson(request);
    requireAuthorization(request, options.authorizationToken);
    EmptyObjectSchema.parse(request.query);
    const input = RetrievalSearchRequestSchema.parse(request.body);
    return withOperationTimeout(request, operationTimeoutMs, async (context) => {
      const result = parseBackendResponse(
        RetrievalSearchResponseSchema,
        await backend.search(input, withEmbedding(context, options.embeddingProvider)),
      );
      if (result.project_id !== input.project_id) {
        throw new RetrievalServiceOperationError(
          502,
          "backend_scope_violation",
          "Retrieval backend returned data outside the request scope",
        );
      }
      if (result.query_hash !== sha256(input.query)
        || result.total_indexed_chunks < result.hits.length
        || result.hits.length > (input.top_k ?? 8)
        || result.hits.some((hit, index) => (
          hit.rank !== index + 1 || hit.content_hash !== sha256(hit.content)
        ))) {
        throw new RetrievalServiceOperationError(
          502,
          "backend_integrity_violation",
          "Retrieval backend returned data that failed integrity checks",
        );
      }
      return result;
    });
  });

  let closed = false;
  return {
    app,
    async listen(listenOptions = {}) {
      const host = listenOptions.host ?? "127.0.0.1";
      const port = listenOptions.port ?? 4312;
      if (host !== "127.0.0.1" && host !== "::1") {
        throw new TypeError("retrieval-service only listens on a loopback address");
      }
      boundedInteger(port, "port", 0, 65_535);
      return app.listen({ host, port });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        await backend.close?.();
      }
    },
  };
}

function withEmbedding(
  context: { readonly signal: AbortSignal },
  embeddingProvider: RetrievalEmbeddingProvider | undefined,
): RetrievalBackendContext {
  return embeddingProvider === undefined ? context : { ...context, embeddingProvider };
}

async function withOperationTimeout<T>(
  request: FastifyRequest,
  timeoutMs: number,
  operation: (context: { readonly signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onAborted = (): void => controller.abort(new Error("request aborted"));
  request.raw.once("aborted", onAborted);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("operation timed out"));
  }, timeoutMs);
  timer.unref?.();

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(timedOut
        ? new RetrievalServiceOperationError(504, "request_timeout", "Retrieval operation timed out")
        : new RetrievalServiceOperationError(408, "request_aborted", "Retrieval request was aborted"));
    }, { once: true });
  });
  try {
    return await Promise.race([operation({ signal: controller.signal }), aborted]);
  } finally {
    clearTimeout(timer);
    request.raw.off("aborted", onAborted);
  }
}

function rejectUnexpectedBody(request: FastifyRequest): void {
  const length = request.headers["content-length"];
  if ((length !== undefined && length !== "0") || request.headers["transfer-encoding"] !== undefined) {
    throw new RetrievalServiceOperationError(400, "unexpected_body", "This route does not accept a request body");
  }
}

function requireJson(request: FastifyRequest): void {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new RetrievalServiceOperationError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }
}

function requireAuthorization(request: FastifyRequest, expected: string | undefined): void {
  if (expected === undefined) return;
  const header = request.headers.authorization;
  const supplied = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  if (!safeEqual(supplied, expected)) {
    throw new RetrievalServiceOperationError(401, "unauthorized", "A valid bearer token is required");
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseBackendResponse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RetrievalServiceOperationError(
      502,
      "invalid_backend_response",
      "Retrieval backend returned an invalid response",
    );
  }
  return result.data;
}

function sendError(reply: FastifyReply, error: RetrievalServiceOperationError): void {
  void reply.status(error.statusCode).send({
    schema_version: RETRIEVAL_SERVICE_ERROR_SCHEMA_VERSION,
    error: error.code,
    message: error.message,
  });
}

function toHttpError(error: unknown): RetrievalServiceOperationError {
  if (error instanceof RetrievalServiceOperationError) return error;
  if (error instanceof ZodError) {
    return new RetrievalServiceOperationError(
      400,
      "invalid_request",
      "Request did not match the retrieval-service contract",
    );
  }
  if (error instanceof RetrievalError) {
    if (error.code === "project_scope_mismatch") {
      return new RetrievalServiceOperationError(409, error.code, "Retrieval project scope mismatch");
    }
    if (error.code === "index_too_large") {
      return new RetrievalServiceOperationError(413, error.code, "Retrieval index exceeds the configured limit");
    }
    if (error.code.startsWith("invalid_") || error.code === "unsafe_path") {
      return new RetrievalServiceOperationError(400, error.code, "Retrieval input is invalid");
    }
    return new RetrievalServiceOperationError(503, "backend_unavailable", "Retrieval backend is unavailable");
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new RetrievalServiceOperationError(413, "request_too_large", "Request body exceeds the configured limit");
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return new RetrievalServiceOperationError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  if (error instanceof SyntaxError || code.startsWith("FST_ERR_CTP_")) {
    return new RetrievalServiceOperationError(400, "invalid_json", "Request body must contain valid JSON");
  }
  return new RetrievalServiceOperationError(503, "backend_unavailable", "Retrieval backend is unavailable");
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function createRetrievalAuthorizationToken(): string {
  return randomBytes(32).toString("base64url");
}
