export const RETRIEVAL_SCHEMA_VERSION = "tracegraph.retrieval.v1" as const;
export const RETRIEVAL_INDEX_SCHEMA_VERSION = "tracegraph.retrieval-index.v1" as const;

export interface RetrievalSource {
  readonly source_path: string;
  readonly document_hash: string;
}

export interface RetrievalChunk {
  readonly chunk_id: string;
  readonly project_id: string;
  readonly source_path: string;
  readonly document_hash: string;
  readonly content_hash: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly heading_path: readonly string[];
  readonly content: string;
}

export interface ChunkMarkdownInput {
  readonly project_id: string;
  readonly source_path: string;
  readonly content: string;
  /** Soft target. Markdown paragraphs and fenced code blocks remain indivisible. */
  readonly max_chunk_chars?: number;
}

export interface IngestMarkdownInput extends ChunkMarkdownInput {
  readonly signal?: AbortSignal;
}

export interface SearchRequest {
  readonly project_id: string;
  readonly query: string;
  readonly top_k?: number;
  readonly signal?: AbortSignal;
}

export interface ReadChunkRequest {
  readonly project_id: string;
  readonly chunk_id: string;
}

export interface IndexUpdateResult {
  readonly schema_version: typeof RETRIEVAL_SCHEMA_VERSION;
  readonly project_id: string;
  readonly source_path: string;
  readonly document_hash: string;
  readonly status: "updated" | "unchanged";
  readonly generation: number;
  readonly source_chunk_count: number;
  readonly total_indexed_chunks: number;
}

export interface SearchHit {
  readonly rank: number;
  readonly chunk_id: string;
  readonly content_hash: string;
  readonly score: number;
  readonly source_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly heading_path: readonly string[];
  readonly content: string;
}

export interface SearchResponse {
  readonly schema_version: typeof RETRIEVAL_SCHEMA_VERSION;
  readonly project_id: string;
  readonly query_hash: string;
  readonly total_indexed_chunks: number;
  readonly hits: readonly SearchHit[];
}

export interface RetrievalHealth {
  readonly schema_version: typeof RETRIEVAL_SCHEMA_VERSION;
  readonly status: "ok";
  readonly backend: "jsonl_bm25";
}

export interface RetrievalIndexSnapshot {
  readonly schema_version: typeof RETRIEVAL_INDEX_SCHEMA_VERSION;
  readonly project_id: string;
  readonly generation: number;
  readonly updated_at: string;
  readonly sources: readonly RetrievalSource[];
  readonly chunks: readonly RetrievalChunk[];
  /** Present only when a corrupt current snapshot was replaced by its last good backup. */
  readonly recovered_from?: "backup";
}

export interface JsonlIndexStoreOptions {
  readonly dataDir: string;
  readonly now?: () => Date;
  readonly maxIndexBytes?: number;
}

export interface LocalRetrievalOptions extends JsonlIndexStoreOptions {
  readonly maxChunkChars?: number;
}

export interface ReplaceSourceInput {
  readonly project_id: string;
  readonly source_path: string;
  readonly document_hash: string;
  readonly chunks: readonly RetrievalChunk[];
}

export interface RetrievalBackend {
  ingest(input: IngestMarkdownInput): Promise<IndexUpdateResult>;
  search(input: SearchRequest): Promise<SearchResponse>;
  readChunk(input: ReadChunkRequest): Promise<RetrievalChunk | undefined>;
  health(): Promise<RetrievalHealth>;
}
