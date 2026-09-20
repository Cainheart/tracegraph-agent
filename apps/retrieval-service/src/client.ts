import { createHash } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import {
  RetrievalIndexUpdateSchema,
  RetrievalIngestRequestSchema,
  RetrievalSearchRequestSchema,
  RetrievalSearchResponseSchema,
  RetrievalServiceErrorSchema,
  RetrievalServiceHealthSchema,
  type RetrievalIndexUpdate,
  type RetrievalIngestRequest,
  type RetrievalSearchRequest,
  type RetrievalSearchResponse,
  type RetrievalServiceHealth,
} from "./contracts.js";

const DEFAULT_CLIENT_TIMEOUT_MS = 10_000;
const MAX_CLIENT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1_048_576;

export interface RetrievalClientRequestOptions {
  signal?: AbortSignal;
}

/** A Core-facing seam; a remote client or the local package can implement it. */
export interface RetrievalClient {
  health(options?: RetrievalClientRequestOptions): Promise<RetrievalServiceHealth>;
  ingest(
    input: RetrievalIngestRequest,
    options?: RetrievalClientRequestOptions,
  ): Promise<RetrievalIndexUpdate>;
  search(
    input: RetrievalSearchRequest,
    options?: RetrievalClientRequestOptions,
  ): Promise<RetrievalSearchResponse>;
}

export interface RetrievalServiceClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class RetrievalServiceClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "RetrievalServiceClientError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

/**
 * Only connectivity, deadline, and gateway/service failures are fallback-safe.
 * Caller cancellation and all 4xx contract errors remain visible.
 */
export function isRetrievalServiceUnavailable(error: unknown): boolean {
  return error instanceof RetrievalServiceClientError
    && error.retryable
    && (
      error.code === "service_unavailable"
      || error.code === "request_timeout"
      || error.status === 502
      || error.status === 503
      || error.status === 504
    );
}

export function createRetrievalServiceClient(
  options: RetrievalServiceClientOptions,
): RetrievalClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");

  const request = async <T>(input: {
    path: "/health" | "/ingest" | "/search";
    method: "GET" | "POST";
    body?: unknown;
    schema: ZodType<T>;
    signal?: AbortSignal;
  }): Promise<T> => {
    if (input.signal?.aborted === true) {
      throw new RetrievalServiceClientError({
        status: 0,
        code: "request_aborted",
        message: "Retrieval request was aborted",
        retryable: false,
      });
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("retrieval client timeout"));
    }, timeoutMs);
    timer.unref?.();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new RetrievalServiceClientError({
          status: 0,
          code: timedOut ? "request_timeout" : "request_aborted",
          message: timedOut ? "Retrieval service request timed out" : "Retrieval request was aborted",
          retryable: timedOut,
        }));
      }, { once: true });
    });

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
      const response = await Promise.race([
        fetchImpl(`${baseUrl}${input.path}`, {
          method: input.method,
          headers,
          signal: controller.signal,
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        }),
        aborted,
      ]);
      const body = await Promise.race([readJsonResponse(response), aborted]);
      if (!response.ok) {
        const parsed = RetrievalServiceErrorSchema.safeParse(body);
        throw new RetrievalServiceClientError({
          status: response.status,
          code: parsed.success ? parsed.data.error : "http_error",
          message: parsed.success ? parsed.data.message : `Retrieval service returned HTTP ${response.status}`,
          retryable: response.status === 502 || response.status === 503 || response.status === 504,
        });
      }
      return parseResponse(input.schema, body);
    } catch (error) {
      if (error instanceof RetrievalServiceClientError) throw error;
      if (controller.signal.aborted) {
        throw new RetrievalServiceClientError({
          status: 0,
          code: timedOut ? "request_timeout" : "request_aborted",
          message: timedOut ? "Retrieval service request timed out" : "Retrieval request was aborted",
          retryable: timedOut,
          cause: error,
        });
      }
      throw new RetrievalServiceClientError({
        status: 0,
        code: "service_unavailable",
        message: "Retrieval service is unavailable",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    async health(requestOptions = {}) {
      return request({
        path: "/health",
        method: "GET",
        schema: RetrievalServiceHealthSchema,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
    },
    async ingest(input, requestOptions = {}) {
      const parsed = parseInput(RetrievalIngestRequestSchema, input);
      const result = await request({
        path: "/ingest",
        method: "POST",
        body: parsed,
        schema: RetrievalIndexUpdateSchema,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      if (result.project_id !== parsed.project_id || result.source_path !== parsed.source_path) {
        throw invalidResponse("Retrieval service returned data outside the request scope");
      }
      if (result.document_hash !== sha256(parsed.content)
        || result.source_chunk_count > result.total_indexed_chunks) {
        throw invalidResponse("Retrieval service returned data that failed integrity checks");
      }
      return result;
    },
    async search(input, requestOptions = {}) {
      const parsed = parseInput(RetrievalSearchRequestSchema, input);
      const result = await request({
        path: "/search",
        method: "POST",
        body: parsed,
        schema: RetrievalSearchResponseSchema,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      if (result.project_id !== parsed.project_id) {
        throw invalidResponse("Retrieval service returned data outside the request scope");
      }
      if (result.query_hash !== sha256(parsed.query)
        || result.total_indexed_chunks < result.hits.length
        || result.hits.length > (parsed.top_k ?? 8)
        || result.hits.some((hit, index) => (
          hit.rank !== index + 1 || hit.content_hash !== sha256(hit.content)
        ))) {
        throw invalidResponse("Retrieval service returned data that failed integrity checks");
      }
      return result;
    },
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw invalidResponse("Retrieval service response must be application/json");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw invalidResponse("Retrieval service response exceeds the client limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw invalidResponse("Retrieval service response exceeds the client limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RetrievalServiceClientError({
      status: response.status,
      code: "invalid_response",
      message: "Retrieval service returned invalid JSON",
      retryable: false,
      cause: error,
    });
  }
}

function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RetrievalServiceClientError({
        status: 0,
        code: "invalid_request",
        message: "Request did not match the retrieval-service contract",
        retryable: false,
        cause: error,
      });
    }
    throw error;
  }
}

function parseResponse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidResponse("Retrieval service returned an invalid response");
  return parsed.data;
}

function invalidResponse(message: string): RetrievalServiceClientError {
  return new RetrievalServiceClientError({
    status: 0,
    code: "invalid_response",
    message,
    retryable: false,
  });
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL", { cause: error });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== "") {
    throw new TypeError("baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/u, "");
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CLIENT_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between 1 and ${MAX_CLIENT_TIMEOUT_MS}`);
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
