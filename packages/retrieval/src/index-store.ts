import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";

import { RetrievalError } from "./errors.js";
import { sha256, sha256Hex } from "./hash.js";
import {
  RETRIEVAL_INDEX_SCHEMA_VERSION,
  RETRIEVAL_SCHEMA_VERSION,
  type IndexUpdateResult,
  type JsonlIndexStoreOptions,
  type ReplaceSourceInput,
  type RetrievalChunk,
  type RetrievalIndexSnapshot,
  type RetrievalSource,
} from "./types.js";
import {
  assertExactKeys,
  isPlainRecord,
  validateChunk,
  validateChunkId,
  validateDataDir,
  validateHash,
  validateProjectId,
  validateSourcePath,
} from "./validation.js";

const DEFAULT_MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MIN_MAX_INDEX_BYTES = 64 * 1024;
const MAX_MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_JSONL_LINE_BYTES = 10 * 1024 * 1024;
const EMPTY_UPDATED_AT = "1970-01-01T00:00:00.000Z";

interface IndexPaths {
  readonly directory: string;
  readonly current: string;
  readonly backup: string;
}

interface HeaderRecord {
  readonly kind: "header";
  readonly schema_version: typeof RETRIEVAL_INDEX_SCHEMA_VERSION;
  readonly project_id: string;
  readonly generation: number;
  readonly updated_at: string;
  readonly source_count: number;
  readonly chunk_count: number;
}

interface SourceRecord extends RetrievalSource {
  readonly kind: "source";
}

interface ChunkRecord {
  readonly kind: "chunk";
  readonly chunk: RetrievalChunk;
}

interface FooterRecord {
  readonly kind: "footer";
  readonly snapshot_hash: string;
}

export class JsonlIndexStore {
  readonly #dataDir: string;
  readonly #now: () => Date;
  readonly #maxIndexBytes: number;
  readonly #writeQueues = new Map<string, Promise<void>>();

  constructor(options: JsonlIndexStoreOptions) {
    this.#dataDir = validateDataDir(options.dataDir);
    this.#now = options.now ?? (() => new Date());
    const maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
    if (
      !Number.isSafeInteger(maxIndexBytes)
      || maxIndexBytes < MIN_MAX_INDEX_BYTES
      || maxIndexBytes > MAX_MAX_INDEX_BYTES
    ) {
      throw new RetrievalError("invalid_data_dir", "maxIndexBytes is outside the supported range");
    }
    this.#maxIndexBytes = maxIndexBytes;
  }

  async read(projectIdValue: string): Promise<RetrievalIndexSnapshot> {
    const projectId = validateProjectId(projectIdValue);
    const paths = await this.#prepareProjectDirectory(projectId);
    const current = await this.#tryReadSnapshot(paths.current, projectId);
    if (current.kind === "snapshot") return current.snapshot;
    if (current.kind === "unsafe") throw current.error;

    const backup = await this.#tryReadSnapshot(paths.backup, projectId);
    if (backup.kind === "snapshot") {
      return Object.freeze({ ...backup.snapshot, recovered_from: "backup" });
    }
    if (backup.kind === "unsafe") throw backup.error;
    if (current.kind === "corrupt" || backup.kind === "corrupt") {
      throw new RetrievalError("index_corrupt", "retrieval index is corrupt");
    }
    return emptySnapshot(projectId);
  }

  async replaceSource(input: ReplaceSourceInput): Promise<IndexUpdateResult> {
    const projectId = validateProjectId(input.project_id);
    const sourcePath = validateSourcePath(input.source_path);
    const documentHash = validateHash(input.document_hash, "invalid_chunk");
    if (!Array.isArray(input.chunks) || input.chunks.length > MAX_RECORDS) {
      throw new RetrievalError("invalid_chunk", "retrieval chunks are invalid");
    }
    const chunks = input.chunks.map((chunk) => {
      const validated = validateChunk(chunk, { project_id: projectId, source_path: sourcePath });
      if (validated.document_hash !== documentHash) {
        throw new RetrievalError("invalid_chunk", "retrieval chunk document hash is invalid");
      }
      return validated;
    });
    const chunkIds = new Set<string>();
    for (const chunk of chunks) {
      if (chunkIds.has(chunk.chunk_id)) {
        throw new RetrievalError("invalid_chunk", "retrieval chunk ids must be unique");
      }
      chunkIds.add(chunk.chunk_id);
    }

    return this.#withProjectWrite(projectId, async () => {
      const current = await this.read(projectId);
      const existingSource = current.sources.find((source) => source.source_path === sourcePath);
      if (existingSource?.document_hash === documentHash && current.recovered_from === undefined) {
        const sourceChunkCount = current.chunks.filter((chunk) => chunk.source_path === sourcePath).length;
        return Object.freeze({
          schema_version: RETRIEVAL_SCHEMA_VERSION,
          project_id: projectId,
          source_path: sourcePath,
          document_hash: documentHash,
          status: "unchanged",
          generation: current.generation,
          source_chunk_count: sourceChunkCount,
          total_indexed_chunks: current.chunks.length,
        });
      }

      const sources = current.sources
        .filter((source) => source.source_path !== sourcePath)
        .concat({ source_path: sourcePath, document_hash: documentHash })
        .sort(compareSources);
      const nextChunks = current.chunks
        .filter((chunk) => chunk.source_path !== sourcePath)
        .concat(chunks)
        .sort(compareChunks);
      if (sources.length > MAX_RECORDS || nextChunks.length > MAX_RECORDS) {
        throw new RetrievalError("index_too_large", "retrieval index exceeds the record limit");
      }
      const next: RetrievalIndexSnapshot = Object.freeze({
        schema_version: RETRIEVAL_INDEX_SCHEMA_VERSION,
        project_id: projectId,
        generation: current.generation + 1,
        updated_at: canonicalNow(this.#now),
        sources: Object.freeze(sources.map((source) => Object.freeze(source))),
        chunks: Object.freeze(nextChunks),
      });
      await this.#writeSnapshot(next);
      return Object.freeze({
        schema_version: RETRIEVAL_SCHEMA_VERSION,
        project_id: projectId,
        source_path: sourcePath,
        document_hash: documentHash,
        status: "updated",
        generation: next.generation,
        source_chunk_count: chunks.length,
        total_indexed_chunks: next.chunks.length,
      });
    });
  }

  async readChunk(projectIdValue: string, chunkIdValue: string): Promise<RetrievalChunk | undefined> {
    const projectId = validateProjectId(projectIdValue);
    const chunkId = validateChunkId(chunkIdValue);
    const snapshot = await this.read(projectId);
    return snapshot.chunks.find((chunk) => chunk.chunk_id === chunkId);
  }

  async ensureReady(): Promise<void> {
    await this.#prepareDataDirectory();
  }

  async #withProjectWrite<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeQueues.get(projectId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => turn);
    this.#writeQueues.set(projectId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#writeQueues.get(projectId) === queued) this.#writeQueues.delete(projectId);
    }
  }

  async #prepareDataDirectory(): Promise<void> {
    try {
      await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(this.#dataDir);
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      throw new RetrievalError("io_failed", "retrieval data directory is unavailable", { cause: error });
    }
  }

  async #prepareProjectDirectory(projectId: string): Promise<IndexPaths> {
    await this.#prepareDataDirectory();
    const directory = nodePath.join(this.#dataDir, sha256Hex(projectId));
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new RetrievalError("io_failed", "retrieval project index is unavailable", { cause: error });
      }
    }
    await assertSafeDirectory(directory);
    return {
      directory,
      current: nodePath.join(directory, "index.jsonl"),
      backup: nodePath.join(directory, "index.previous.jsonl"),
    };
  }

  async #tryReadSnapshot(
    path: string,
    projectId: string,
  ): Promise<
    | { readonly kind: "missing" }
    | { readonly kind: "corrupt" }
    | { readonly kind: "unsafe"; readonly error: RetrievalError }
    | { readonly kind: "snapshot"; readonly snapshot: RetrievalIndexSnapshot }
  > {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { kind: "missing" };
      throw new RetrievalError("io_failed", "retrieval index cannot be inspected", { cause: error });
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      return {
        kind: "unsafe",
        error: new RetrievalError("unsafe_path", "retrieval index path is unsafe"),
      };
    }
    if (info.size > this.#maxIndexBytes) {
      return {
        kind: "unsafe",
        error: new RetrievalError("index_too_large", "retrieval index exceeds the byte limit"),
      };
    }
    try {
      const serialized = await readFile(path, "utf8");
      return { kind: "snapshot", snapshot: parseSnapshot(serialized, projectId) };
    } catch (error) {
      if (error instanceof RetrievalError) {
        if (error.code === "index_corrupt") return { kind: "corrupt" };
        return { kind: "unsafe", error };
      }
      throw new RetrievalError("io_failed", "retrieval index cannot be read", { cause: error });
    }
  }

  async #writeSnapshot(snapshot: RetrievalIndexSnapshot): Promise<void> {
    const paths = await this.#prepareProjectDirectory(snapshot.project_id);
    const serialized = serializeSnapshot(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > this.#maxIndexBytes) {
      throw new RetrievalError("index_too_large", "retrieval index exceeds the byte limit");
    }

    const current = await this.#tryReadSnapshot(paths.current, snapshot.project_id);
    if (current.kind === "unsafe") throw current.error;
    if (current.kind === "snapshot") {
      const currentSerialized = await readFile(paths.current, "utf8");
      await atomicReplace(paths.backup, currentSerialized, paths.directory);
    }
    await atomicReplace(paths.current, serialized, paths.directory);
  }
}

function emptySnapshot(projectId: string): RetrievalIndexSnapshot {
  return Object.freeze({
    schema_version: RETRIEVAL_INDEX_SCHEMA_VERSION,
    project_id: projectId,
    generation: 0,
    updated_at: EMPTY_UPDATED_AT,
    sources: Object.freeze([]),
    chunks: Object.freeze([]),
  });
}

function serializeSnapshot(snapshot: RetrievalIndexSnapshot): string {
  const header: HeaderRecord = {
    kind: "header",
    schema_version: RETRIEVAL_INDEX_SCHEMA_VERSION,
    project_id: snapshot.project_id,
    generation: snapshot.generation,
    updated_at: snapshot.updated_at,
    source_count: snapshot.sources.length,
    chunk_count: snapshot.chunks.length,
  };
  const lines = [
    JSON.stringify(header),
    ...snapshot.sources.map((source) => JSON.stringify({ kind: "source", ...source } satisfies SourceRecord)),
    ...snapshot.chunks.map((chunk) => JSON.stringify({ kind: "chunk", chunk } satisfies ChunkRecord)),
  ];
  const snapshotHash = sha256(`${lines.join("\n")}\n`);
  lines.push(JSON.stringify({ kind: "footer", snapshot_hash: snapshotHash } satisfies FooterRecord));
  return `${lines.join("\n")}\n`;
}

function parseSnapshot(serialized: string, expectedProjectId: string): RetrievalIndexSnapshot {
  if (!serialized.endsWith("\n")) throw corrupt();
  const lines = serialized.slice(0, -1).split("\n");
  if (lines.length < 2 || lines.length > MAX_RECORDS * 2 + 2) throw corrupt();
  if (lines.some((line) => line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES)) {
    throw corrupt();
  }
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw corrupt(error);
    }
  });
  const header = parseHeader(parsed[0], expectedProjectId);
  const footer = parseFooter(parsed.at(-1));
  const expectedHash = sha256(`${lines.slice(0, -1).join("\n")}\n`);
  if (footer.snapshot_hash !== expectedHash) throw corrupt();

  const sources: RetrievalSource[] = [];
  const chunks: RetrievalChunk[] = [];
  let readingChunks = false;
  for (const record of parsed.slice(1, -1)) {
    if (!isPlainRecord(record) || typeof record.kind !== "string") throw corrupt();
    if (record.kind === "source" && !readingChunks) {
      assertExactKeys(record, ["kind", "source_path", "document_hash"], "index_corrupt");
      let sourcePath: string;
      try {
        sourcePath = validateSourcePath(record.source_path);
      } catch (error) {
        throw corrupt(error);
      }
      sources.push(Object.freeze({
        source_path: sourcePath,
        document_hash: validateHash(record.document_hash, "index_corrupt"),
      }));
      continue;
    }
    if (record.kind === "chunk") {
      readingChunks = true;
      assertExactKeys(record, ["kind", "chunk"], "index_corrupt");
      chunks.push(validateChunk(record.chunk, { project_id: expectedProjectId }, "index_corrupt"));
      continue;
    }
    throw corrupt();
  }
  if (sources.length !== header.source_count || chunks.length !== header.chunk_count) throw corrupt();
  if (!isStrictlySorted(sources, compareSources) || !isStrictlySorted(chunks, compareChunks)) throw corrupt();
  const sourceByPath = new Map(sources.map((source) => [source.source_path, source]));
  if (sourceByPath.size !== sources.length) throw corrupt();
  for (const chunk of chunks) {
    const source = sourceByPath.get(chunk.source_path);
    if (source === undefined || source.document_hash !== chunk.document_hash) throw corrupt();
  }
  return Object.freeze({
    schema_version: RETRIEVAL_INDEX_SCHEMA_VERSION,
    project_id: expectedProjectId,
    generation: header.generation,
    updated_at: header.updated_at,
    sources: Object.freeze(sources),
    chunks: Object.freeze(chunks),
  });
}

function parseHeader(input: unknown, expectedProjectId: string): HeaderRecord {
  if (!isPlainRecord(input)) throw corrupt();
  assertExactKeys(input, [
    "kind",
    "schema_version",
    "project_id",
    "generation",
    "updated_at",
    "source_count",
    "chunk_count",
  ], "index_corrupt");
  if (input.kind !== "header" || input.schema_version !== RETRIEVAL_INDEX_SCHEMA_VERSION) throw corrupt();
  let projectId: string;
  try {
    projectId = validateProjectId(input.project_id);
  } catch (error) {
    throw corrupt(error);
  }
  if (projectId !== expectedProjectId) {
    throw new RetrievalError("project_scope_mismatch", "retrieval index belongs to another project");
  }
  if (
    typeof input.generation !== "number"
    || !Number.isSafeInteger(input.generation)
    || input.generation < 1
    || typeof input.source_count !== "number"
    || !Number.isSafeInteger(input.source_count)
    || input.source_count < 0
    || input.source_count > MAX_RECORDS
    || typeof input.chunk_count !== "number"
    || !Number.isSafeInteger(input.chunk_count)
    || input.chunk_count < 0
    || input.chunk_count > MAX_RECORDS
    || typeof input.updated_at !== "string"
    || new Date(input.updated_at).toISOString() !== input.updated_at
  ) {
    throw corrupt();
  }
  return input as unknown as HeaderRecord;
}

function parseFooter(input: unknown): FooterRecord {
  if (!isPlainRecord(input)) throw corrupt();
  assertExactKeys(input, ["kind", "snapshot_hash"], "index_corrupt");
  if (input.kind !== "footer") throw corrupt();
  return { kind: "footer", snapshot_hash: validateHash(input.snapshot_hash, "index_corrupt") };
}

async function atomicReplace(path: string, content: string, directory: string): Promise<void> {
  await assertSafeReplaceTarget(path);
  const temporary = nodePath.join(
    directory,
    `.index-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    throw error instanceof RetrievalError
      ? error
      : new RetrievalError("io_failed", "retrieval index update failed", { cause: error });
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) return undefined;
      return undefined;
    });
  }
}

async function assertSafeReplaceTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RetrievalError("unsafe_path", "retrieval index path is unsafe");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    if (error instanceof RetrievalError) throw error;
    throw new RetrievalError("io_failed", "retrieval index path cannot be inspected", { cause: error });
  }
}

async function assertSafeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RetrievalError("unsafe_path", "retrieval index directory is unsafe");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP") && !isNodeError(error, "EBADF")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RetrievalError("io_failed", "retrieval clock returned an invalid timestamp");
  }
  return value.toISOString();
}

function compareSources(left: RetrievalSource, right: RetrievalSource): number {
  return left.source_path.localeCompare(right.source_path);
}

function compareChunks(left: RetrievalChunk, right: RetrievalChunk): number {
  return left.source_path.localeCompare(right.source_path)
    || left.start_line - right.start_line
    || left.end_line - right.end_line
    || left.chunk_id.localeCompare(right.chunk_id);
}

function isStrictlySorted<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1]!, values[index]!) >= 0) return false;
  }
  return true;
}

function corrupt(cause?: unknown): RetrievalError {
  return new RetrievalError(
    "index_corrupt",
    "retrieval index is corrupt",
    cause === undefined ? undefined : { cause },
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
