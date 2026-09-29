# @tracegraph/retrieval

Local Markdown retrieval index and ranking implementation for TraceGraph Memory. See [module 08](../../docs/modules/08-Memory-记忆子系统.md).

## Purpose

Chunk Markdown, persist project-scoped source chunks in JSONL, rank matches with BM25, and expose ingest/search/read operations through a backend seam.

## Public API

The package root exports `createLocalRetrieval`, `createLocalJsonlRetrievalBackend`, `LocalRetrievalIndex`, `Bm25Retriever`, `JsonlIndexStore`, chunking helpers, and the retrieval contracts/types.

## Dependencies

It has no TraceGraph workspace dependency. TypeScript and Node types are development dependencies.

## State ownership

The JSONL chunk index is rebuildable retrieval state. Canonical Memory records and Run events remain owned by Core, so an index update is not proof that a Memory record was admitted.

## Extension points

`RetrievalBackend` and the embedding-provider type define replacement seams. The current built-in implementation is local JSONL plus BM25.

## Model effect

This package does not call a model. Core may select ranked hits for a later model context; retrieval attribution remains untrusted and is subject to scope, hash, and token-budget checks.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/retrieval test:unit` from the repository root.

## Known limitations

There is no embedding model, vector database, or reranker. Ranking is lexical BM25, the index is not canonical Memory, and the package does not automatically crawl a repository.
