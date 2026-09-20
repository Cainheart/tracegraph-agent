import { RetrievalError } from "./errors.js";
import { sha256 } from "./hash.js";
import type { JsonlIndexStore } from "./index-store.js";
import {
  RETRIEVAL_SCHEMA_VERSION,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
} from "./types.js";
import {
  DEFAULT_TOP_K,
  validateProjectId,
  validateQuery,
  validateTopK,
} from "./validation.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_TOKEN_CHARS = 128;

interface Posting {
  readonly document: number;
  readonly termFrequency: number;
}

export class Bm25Retriever {
  constructor(private readonly store: JsonlIndexStore) {}

  async search(input: SearchRequest): Promise<SearchResponse> {
    const projectId = validateProjectId(input.project_id);
    const query = validateQuery(input.query);
    const topK = validateTopK(input.top_k ?? DEFAULT_TOP_K);
    throwIfAborted(input.signal);
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      throw new RetrievalError("invalid_query", "query contains no searchable terms");
    }
    const snapshot = await this.store.read(projectId);
    throwIfAborted(input.signal);
    const documents = snapshot.chunks.map((chunk) => tokenize(chunk.content));
    const lengths = documents.map((tokens) => tokens.length);
    const averageLength = lengths.length === 0
      ? 0
      : lengths.reduce((total, length) => total + length, 0) / lengths.length;
    const inverted = buildInvertedIndex(documents);
    const scores = new Map<number, number>();
    const uniqueQueryTerms = new Map<string, number>();
    for (const term of queryTokens) {
      uniqueQueryTerms.set(term, (uniqueQueryTerms.get(term) ?? 0) + 1);
    }
    for (const [term, queryFrequency] of uniqueQueryTerms) {
      const postings = inverted.get(term);
      if (postings === undefined) continue;
      const inverseDocumentFrequency = Math.log(
        1 + (documents.length - postings.length + 0.5) / (postings.length + 0.5),
      );
      const queryWeight = 1 + Math.log(queryFrequency);
      for (const posting of postings) {
        const documentLength = lengths[posting.document] ?? 0;
        const normalization = averageLength === 0
          ? 1
          : 1 - BM25_B + BM25_B * documentLength / averageLength;
        const numerator = posting.termFrequency * (BM25_K1 + 1);
        const denominator = posting.termFrequency + BM25_K1 * normalization;
        const contribution = inverseDocumentFrequency * numerator / denominator * queryWeight;
        scores.set(posting.document, (scores.get(posting.document) ?? 0) + contribution);
      }
    }

    const ordered = [...scores.entries()]
      .filter(([, score]) => Number.isFinite(score) && score > 0)
      .sort(([leftIndex, leftScore], [rightIndex, rightScore]) => (
        rightScore - leftScore
        || compareChunkOrder(snapshot.chunks[leftIndex]!, snapshot.chunks[rightIndex]!)
      ));
    const seenContent = new Set<string>();
    const selected: Array<{ readonly document: number; readonly score: number }> = [];
    for (const [document, score] of ordered) {
      const chunk = snapshot.chunks[document]!;
      if (seenContent.has(chunk.content_hash)) continue;
      seenContent.add(chunk.content_hash);
      selected.push({ document, score });
      if (selected.length === topK) break;
    }
    const hits: SearchHit[] = selected.map(({ document, score }, index) => {
      const chunk = snapshot.chunks[document]!;
      return Object.freeze({
        rank: index + 1,
        chunk_id: chunk.chunk_id,
        content_hash: chunk.content_hash,
        score: Number(score.toFixed(12)),
        source_path: chunk.source_path,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        heading_path: chunk.heading_path,
        content: chunk.content,
      });
    });
    return Object.freeze({
      schema_version: RETRIEVAL_SCHEMA_VERSION,
      project_id: projectId,
      query_hash: sha256(query),
      total_indexed_chunks: snapshot.chunks.length,
      hits: Object.freeze(hits),
    });
  }
}

export function tokenize(value: string): readonly string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens: string[] = [];
  // Han characters are useful independent search terms without a dictionary;
  // other scripts keep word-like runs. This remains deterministic and local.
  for (const match of normalized.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}_-]+/gu)) {
    const token = match[0]!.slice(0, MAX_TOKEN_CHARS);
    if (token.length > 0) tokens.push(token);
  }
  return Object.freeze(tokens);
}

function buildInvertedIndex(documents: readonly (readonly string[])[]): ReadonlyMap<string, readonly Posting[]> {
  const index = new Map<string, Posting[]>();
  for (let document = 0; document < documents.length; document += 1) {
    const frequencies = new Map<string, number>();
    for (const token of documents[document]!) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const [term, termFrequency] of frequencies) {
      const postings = index.get(term) ?? [];
      postings.push({ document, termFrequency });
      index.set(term, postings);
    }
  }
  return index;
}

function compareChunkOrder(
  left: { readonly source_path: string; readonly start_line: number; readonly chunk_id: string },
  right: { readonly source_path: string; readonly start_line: number; readonly chunk_id: string },
): number {
  return left.source_path.localeCompare(right.source_path)
    || left.start_line - right.start_line
    || left.chunk_id.localeCompare(right.chunk_id);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
  }
}
