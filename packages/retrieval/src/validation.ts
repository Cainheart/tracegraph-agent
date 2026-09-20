import nodePath from "node:path";

import { RetrievalError } from "./errors.js";
import { sha256 } from "./hash.js";
import type { RetrievalChunk } from "./types.js";

export const MAX_PROJECT_ID_CHARS = 160;
export const MAX_SOURCE_PATH_CHARS = 2_048;
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CHUNK_CHARS = 2_000;
export const MIN_MAX_CHUNK_CHARS = 64;
export const MAX_MAX_CHUNK_CHARS = 64_000;
export const MAX_CHUNK_CONTENT_CHARS = 64_000;
export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 100;
export const MAX_QUERY_CHARS = 2_000;
export const MAX_HEADING_DEPTH = 6;
export const MAX_HEADING_CHARS = 500;
export const MAX_CHUNK_ID_CHARS = 96;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CHUNK_ID_PATTERN = /^chunk:[a-f0-9]{64}$/u;

export function validateProjectId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_PROJECT_ID_CHARS
    || value.trim() !== value
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new RetrievalError("invalid_project_id", "project_id is invalid");
  }
  return value;
}

export function validateSourcePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_SOURCE_PATH_CHARS
    || value.trim() !== value
    || CONTROL_CHARACTERS.test(value)
    || value.includes("\\")
    || nodePath.posix.isAbsolute(value)
    || /^[A-Za-z]:/u.test(value)
    || value.endsWith("/")
  ) {
    throw new RetrievalError("invalid_source_path", "source_path must be a safe relative POSIX path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new RetrievalError("invalid_source_path", "source_path must be a safe relative POSIX path");
  }
  return value;
}

export function validateContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CONTENT_BYTES) {
    throw new RetrievalError("invalid_content", "content must be bounded UTF-8 text");
  }
  return value;
}

export function validateMaxChunkChars(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < MIN_MAX_CHUNK_CHARS
    || value > MAX_MAX_CHUNK_CHARS
  ) {
    throw new RetrievalError(
      "invalid_content",
      `max_chunk_chars must be an integer between ${MIN_MAX_CHUNK_CHARS} and ${MAX_MAX_CHUNK_CHARS}`,
    );
  }
  return value;
}

export function validateQuery(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_QUERY_CHARS
    || value.trim().length < 1
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new RetrievalError("invalid_query", "query is invalid");
  }
  return value.trim();
}

export function validateTopK(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_TOP_K) {
    throw new RetrievalError("invalid_top_k", `top_k must be an integer between 1 and ${MAX_TOP_K}`);
  }
  return value;
}

export function validateDataDir(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || CONTROL_CHARACTERS.test(value)
    || !nodePath.isAbsolute(value)
  ) {
    throw new RetrievalError("invalid_data_dir", "dataDir must be a bounded absolute path");
  }
  return nodePath.resolve(value);
}

export function validateHash(value: unknown, errorCode: "invalid_chunk" | "index_corrupt"): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new RetrievalError(errorCode, errorCode === "invalid_chunk" ? "chunk hash is invalid" : "retrieval index is corrupt");
  }
  return value;
}

export function validateChunkId(value: unknown, errorCode: "invalid_chunk" | "index_corrupt" = "invalid_chunk"): string {
  if (
    typeof value !== "string"
    || value.length > MAX_CHUNK_ID_CHARS
    || !CHUNK_ID_PATTERN.test(value)
  ) {
    throw new RetrievalError(errorCode, errorCode === "invalid_chunk" ? "chunk_id is invalid" : "retrieval index is corrupt");
  }
  return value;
}

export function validateChunk(
  input: unknown,
  expected: { readonly project_id: string; readonly source_path?: string },
  errorCode: "invalid_chunk" | "index_corrupt" = "invalid_chunk",
): RetrievalChunk {
  if (!isPlainRecord(input)) throw chunkError(errorCode);
  assertExactKeys(input, [
    "chunk_id",
    "project_id",
    "source_path",
    "document_hash",
    "content_hash",
    "start_line",
    "end_line",
    "heading_path",
    "content",
  ], errorCode);
  let projectId: string;
  let sourcePath: string;
  let content: string;
  try {
    projectId = validateProjectId(input.project_id);
    sourcePath = validateSourcePath(input.source_path);
    content = validateContent(input.content);
  } catch (error) {
    throw errorCode === "index_corrupt" ? chunkError(errorCode, error) : error;
  }
  if (projectId !== expected.project_id) {
    throw new RetrievalError("project_scope_mismatch", "retrieval chunk belongs to another project");
  }
  if (expected.source_path !== undefined && sourcePath !== expected.source_path) {
    throw chunkError(errorCode);
  }
  const chunkId = validateChunkId(input.chunk_id, errorCode);
  const documentHash = validateHash(input.document_hash, errorCode);
  const contentHash = validateHash(input.content_hash, errorCode);
  if (contentHash !== sha256(content)) throw chunkError(errorCode);
  if (
    typeof input.start_line !== "number"
    || !Number.isSafeInteger(input.start_line)
    || input.start_line < 1
    || typeof input.end_line !== "number"
    || !Number.isSafeInteger(input.end_line)
    || input.end_line < input.start_line
  ) {
    throw chunkError(errorCode);
  }
  if (
    !Array.isArray(input.heading_path)
    || input.heading_path.length > MAX_HEADING_DEPTH
    || input.heading_path.some((heading) => (
      typeof heading !== "string"
      || heading.length < 1
      || heading.length > MAX_HEADING_CHARS
      || CONTROL_CHARACTERS.test(heading)
    ))
  ) {
    throw chunkError(errorCode);
  }
  const expectedChunkId = `chunk:${sha256HexBody([
    projectId,
    sourcePath,
    String(input.start_line),
    String(input.end_line),
    contentHash,
  ])}`;
  if (chunkId !== expectedChunkId) throw chunkError(errorCode);
  return Object.freeze({
    chunk_id: chunkId,
    project_id: projectId,
    source_path: sourcePath,
    document_hash: documentHash,
    content_hash: contentHash,
    start_line: input.start_line,
    end_line: input.end_line,
    heading_path: Object.freeze([...input.heading_path] as string[]),
    content,
  });
}

export function chunkIdentity(input: {
  readonly project_id: string;
  readonly source_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly content_hash: string;
}): string {
  return `chunk:${sha256HexBody([
    input.project_id,
    input.source_path,
    String(input.start_line),
    String(input.end_line),
    input.content_hash,
  ])}`;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  errorCode: "invalid_chunk" | "index_corrupt",
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw chunkError(errorCode);
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function sha256HexBody(parts: readonly string[]): string {
  return sha256(parts.join("\u0000")).slice("sha256:".length);
}

function chunkError(code: "invalid_chunk" | "index_corrupt", cause?: unknown): RetrievalError {
  return new RetrievalError(
    code,
    code === "invalid_chunk" ? "retrieval chunk is invalid" : "retrieval index is corrupt",
    cause === undefined ? undefined : { cause },
  );
}
