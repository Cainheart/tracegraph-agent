# TraceGraph evaluations

The G16 suite is deliberately separate from unit/integration tests:

- `pnpm test` keeps running package tests only.
- `pnpm evals` builds the workspace, runs offline evals, verifies the committed
  baselines, and writes a bounded machine-readable report to
  `_tmp_evals/reports/latest.json`.
- `pnpm evals:update` (or `pnpm evals -- --update`) is the only mode that may
  rewrite committed baselines. Review every baseline diff and explain an
  accepted regression in the PR description.

Eval workers delete common provider API-key/token environment variables and
block non-loopback `fetch`, TCP, and TLS connections. Loopback is allowed only
for the real Host/SSE path. The suite must therefore pass without a network or
provider credential.

## Performance baseline

`evals/baselines/performance.json` covers one deterministic representative
path and records four independently reviewable gates:

| Metric | Scenario | Gate semantics |
| --- | --- | --- |
| `context.built.input_tokens` | long conversation that must compact | deterministic token count; increases fail |
| `run.model_calls` | direct-answer Runtime Run | deterministic call count; increases fail |
| `tool.call.p95_ms` | 20 bounded local `read_file` calls | wall-clock P95 with a 500 ms CI ceiling |
| `sse.first_byte_ms` | real loopback Host ledger stream | wall-clock first byte with a 1,500 ms CI ceiling |

The latency ceilings intentionally include broad scheduler/startup headroom;
they are regression alarms, not performance claims. The perf eval also builds
artificially too-low token and latency baselines and proves that both gates
fail closed.

The generated report is capped at 256 KiB, contains at most 512 test records
and 64 metric observations, and excludes assertion payloads and stack traces.
It is diagnostic output only; committed baseline JSON remains the review and
approval boundary.

## Production retrieval quality

`evals/quality/retrieval-rag-quality.eval.ts` exercises the G21 production
`@tracegraph/retrieval` package rather than the older controlled Memory fixture.
It ingests three Markdown documents through the real chunker and atomic JSONL
store, searches the resulting BM25 inverted index, then reads each winning
chunk back by id and verifies its source path and line range.

The report records four ratio metrics:

| Metric | Meaning in this fixed scenario |
| --- | --- |
| `retrieval.task_success_rate.without` | generic no-retrieval answer contains the repository-specific command |
| `retrieval.task_success_rate.with` | top-ranked production hit contains that command |
| `retrieval.citation_accuracy.without` | no-retrieval path can cite the expected source line |
| `retrieval.citation_accuracy.with` | hit content can be read back and its range contains the expected line |

The gate requires retrieval to improve both dimensions; the committed scenario
currently moves each from `0` to `1`. This is a deterministic integration-quality
check, not a general RAG benchmark, real-model success rate, online A/B result,
or proof of semantic retrieval. The current engine is lexical BM25 over local
JSONL data. It does not use embeddings, a vector database, Qdrant, or a reranker.

`evals/quality/memory-context-quality.eval.ts` remains useful as a controlled
Context-selection test, but it is no longer the only Memory evidence and must
not be described as the production retrieval implementation.

## Trace replay determinism

`evals/replay/time-travel.eval.ts` is the G23 time-travel regression. It records
the canonical snapshot at every run-local sequence, creates a new Runtime over
the same on-disk JSONL ledger, and verifies projection, anchor, and snapshot-hash
stability at every point. It also checks a structured forward diff and proves
that replay does not append ledger events; backward/same diff semantics remain
covered by Core unit tests.

This eval covers canonical Ledger-to-`RunProjection` replay. It does not claim
that a Web `WorkbenchSnapshot` is hash-stable, pause a background Agent, revoke
other clients' live capabilities, fork from history, merge multiple Runs, or
persist a browser replay cursor. Browser interaction remains covered by Web
unit tests; there is no real-browser Playwright E2E suite yet.
