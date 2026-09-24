# Changelog

[中文](CHANGELOG.zh.md) · English

All notable TraceGraph Agent changes are recorded here. The project follows
semantic version identifiers, but remains pre-release while every workspace
package is private.

## [0.1.0-alpha.0] - 2026-09-19

### Added

- Durable Session recovery, Context compaction, provider usage accounting, Patch
  Action WAL/reconciliation, strict Tool execution, policy presets, Plan/Todo,
  sandbox reporting, runtime steering, Telemetry, and offline evaluations.
- G22 engineering gates: three-job CI, global and critical-surface coverage
  thresholds, exact dependency/lockfile checks, high-severity audit gate,
  deterministic release manifests, bilingual entry points, and executable
  documentation mappings.
- G23 interactive Trace Replay Debugger: sequence-bounded canonical snapshots,
  stable replay hashes, forward/backward structured diffs, rotating read-only
  Host capabilities, SDK authority restoration, and Web timeline time travel.
- G21 production retrieval path: Markdown-aware chunking with intact code
  fences and exact source lines, project-isolated atomic JSONL indexes, local
  BM25 ranking and source read-back, durable Runtime remember/recall events and
  budgeted Context injection, an optional strict loopback retrieval service
  with CLI fallback composition, and offline task/citation quality comparison.
- G07 bounded subagent delegation: Host-owned trusted profiles, independent
  child Run/Session/Ledger and recovery state, depth/parallel/token/step/tool
  limits, four strict control tools, hash-linked parent lifecycle receipts,
  restart reconciliation, relation-scoped Host/SDK reads, and a read-only Web
  child ledger view.
- G08 bounded Agent Team coordination: a root-Run Ledger roster, durable
  mailbox, optimistic-version shared task board, child-ledger completion
  evidence, explicit heartbeat/sweep, atomic lost-member task reopening,
  strict Host/SDK/CLI surfaces, and a mostly read-only Web Team panel.

### Release boundary

- All workspace packages remain `private` and no npm publication is performed.
- A matching `v0.1.0-alpha.0` tag produces a checksummed GitHub Actions build
  artifact only after the complete verification chain succeeds.
- G21 currently provides lexical JSONL/BM25 retrieval only; it does not claim
  embedding-based semantic search, a vector database, or a production
  distributed retrieval deployment.
- G08 remains a single-Host coordinator on top of G07's synchronous spawn:
  there is no cross-Host consensus, background liveness daemon, automatic
  worker restart/task reassignment, or arbitrary non-blocking parent loop.
  Persistent parent terminal-receipt append failure still deliberately
  fail-stops until Host restart reconciliation.
