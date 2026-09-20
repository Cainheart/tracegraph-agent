import { chunkMarkdown } from "./chunker.js";
import { sha256 } from "./hash.js";
import { JsonlIndexStore } from "./index-store.js";
import { Bm25Retriever } from "./retriever.js";
import {
  RETRIEVAL_SCHEMA_VERSION,
  type IndexUpdateResult,
  type IngestMarkdownInput,
  type LocalRetrievalOptions,
  type ReadChunkRequest,
  type RetrievalBackend,
  type RetrievalChunk,
  type RetrievalHealth,
  type SearchRequest,
  type SearchResponse,
} from "./types.js";
import {
  DEFAULT_MAX_CHUNK_CHARS,
  validateChunkId,
  validateContent,
  validateMaxChunkChars,
  validateProjectId,
  validateSourcePath,
} from "./validation.js";

export class LocalRetrievalIndex implements RetrievalBackend {
  readonly store: JsonlIndexStore;
  readonly retriever: Bm25Retriever;
  readonly #maxChunkChars: number;

  constructor(options: LocalRetrievalOptions) {
    this.store = new JsonlIndexStore(options);
    this.retriever = new Bm25Retriever(this.store);
    this.#maxChunkChars = validateMaxChunkChars(options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);
  }

  async ingest(input: IngestMarkdownInput): Promise<IndexUpdateResult> {
    throwIfAborted(input.signal);
    const projectId = validateProjectId(input.project_id);
    const sourcePath = validateSourcePath(input.source_path);
    const content = validateContent(input.content);
    const maxChunkChars = validateMaxChunkChars(input.max_chunk_chars ?? this.#maxChunkChars);
    const chunks = chunkMarkdown({
      project_id: projectId,
      source_path: sourcePath,
      content,
      max_chunk_chars: maxChunkChars,
    });
    throwIfAborted(input.signal);
    return this.store.replaceSource({
      project_id: projectId,
      source_path: sourcePath,
      document_hash: sha256(content),
      chunks,
    });
  }

  search(input: SearchRequest): Promise<SearchResponse> {
    return this.retriever.search(input);
  }

  async readChunk(input: ReadChunkRequest): Promise<RetrievalChunk | undefined> {
    const projectId = validateProjectId(input.project_id);
    const chunkId = validateChunkId(input.chunk_id);
    return this.store.readChunk(projectId, chunkId);
  }

  async health(): Promise<RetrievalHealth> {
    await this.store.ensureReady();
    return Object.freeze({
      schema_version: RETRIEVAL_SCHEMA_VERSION,
      status: "ok",
      backend: "jsonl_bm25",
    });
  }
}

export function createLocalRetrieval(options: LocalRetrievalOptions): LocalRetrievalIndex {
  return new LocalRetrievalIndex(options);
}

/** Alias used by composition roots that treat local and remote retrieval alike. */
export const createLocalJsonlRetrievalBackend = createLocalRetrieval;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
  }
}
