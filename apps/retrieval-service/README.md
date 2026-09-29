# @tracegraph/retrieval-service

Optional HTTP service for the retrieval backend. Current retrieval boundaries are described in [module 08](../../docs/modules/08-Memory-记忆子系统.md).

## Purpose

Expose strict health, ingest, and search endpoints backed by the repository's local JSONL/BM25 retrieval implementation, with a client that the CLI may use when explicitly configured.

## Public API

The package root exports the service factory/backend, retrieval client, availability classification, and strict request/response schemas from `src/index.ts`. The `tracegraph-retrieval` executable starts the service.

## Dependencies

It depends on `@tracegraph/retrieval` for indexing and ranking, plus Fastify and Zod for HTTP handling and validation.

## State ownership

The configured backend owns a rebuildable retrieval index. Canonical Memory records, Run Ledger, Workspace, and Runtime remain owned by the local Host/Core composition.

## Extension points

`RetrievalServiceBackend` and `RetrievalEmbeddingProvider` define backend/provider interfaces. The current default is the local JSONL/BM25 backend; alternate providers must preserve the strict retrieval contracts.

## Model effect

The service does not call a model. Search results can be selected by Core as untrusted retrieved context, so they may affect a later model request while remaining subject to project, provenance, and token-budget checks.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/retrieval-service test:unit` from the repository root.

## Known limitations

The service is optional and is not started or supervised by the CLI. `project_id` is a logical partition, not tenant authorization; the optional bearer token is service-wide. The default backend has no embeddings, vector database, or reranker.
