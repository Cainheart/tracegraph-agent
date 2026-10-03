---
id: 2026-10-01-orch-055-job-continuation
title: Recover post-settlement background jobs without confusing acknowledgement and completion
status: implemented
owners: [workflow-jobs, memory, runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [memory-background-jobs, runtime, evidence-ledger]
supersedes: []
language: en
---

# Agent Note: Recover post-settlement background jobs without confusing acknowledgement and completion

## Problem

An asynchronous command acknowledgement does not prove that background work
finished. A Host can also stop after a source Run settles but before a worker is
queued, or while extraction is active. Recovery must derive eligible work from
canonical evidence, retry idempotently, and keep review-gated output distinct
from completed extraction.

## Current state

The repository has a bounded post-settlement Job slice in
[`MemoryBackgroundPipeline`](../../../packages/core/src/domains/memory/memory-background-pipeline.ts).
Its source is a terminal Run in the Evidence Ledger. V2 candidate and control
facts are written through `MemoryControlService` and remain review-gated. The
Runtime start route returns the current `RunProjection`; the public Run status
schema has no `accepted` terminal state. The CLI end-to-end test observes
`indexing|running` from start before it later observes approval/completion.

## Implemented decision

- Use the terminal Run Ledger as the source for whether extraction work exists.
  Startup recovery scans terminal Run IDs in bounded batches, so a crash between
  terminal append and queue insertion does not lose the Job.
- Keep the per-Run job file as a content-free operational projection, not a
  second business Event stream. It records `waiting`, `running`, `retry`,
  `complete`, or `exhausted`, plus the source digest, attempt count, retry time,
  candidate count, and safe error code.
- Write `running` before calling the extractor. A stale `running` marker is
  re-enqueued after restart; the owner lease prevents concurrent extraction.
  Retry after shutdown/failure is bounded to five attempts with exponential
  delay. Stable extractor/Episode/candidate-slot command IDs make replay after
  partial candidate writes idempotent.
- Mark the Job `complete` only after all candidate writes return. Completion
  means extraction and candidate creation finished; a resulting Memory remains
  a `candidate` until a separate user review transition activates it.
- Treat command transport success and current Run projection as acknowledgement
  or observation only. A terminal Run result still requires its canonical
  terminal Event; no `accepted` response is converted into `completed`.
- This closes ORCH-055's durable background continuation acceptance with the
  existing single-Run Memory Episode Job. It does not claim that a general
  Workflow DAG runner or detached operation query resource has shipped.

## Alternatives considered

- Add a second Job Event journal beside the canonical Run and Memory ledgers:
  rejected for this slice because it would duplicate lifecycle evidence and
  create another writer/recovery format. The operational Job state remains
  rebuildable from source Run Events and idempotent Memory commands.
- Treat HTTP success, queue insertion, or `running` as completion: rejected
  because none proves that the durable candidate command finished.

## Invariants and boundaries

- Only a validated terminal Run stream can be extracted; its source digest is
  pinned while the Job is retried.
- An active owner lease serializes extraction for one owner across local Host
  processes. It is not a distributed workflow scheduler.
- Job state never stores extracted claim text. The candidate store and canonical
  Memory control Ledger own their respective content and review facts.
- `complete` is an operation status, not a statement that the candidate was
  accepted, reviewed, activated, or used by a model.

## Migration and rollback

The existing `tracegraph.memory-background-job.v1` operational record gains an
additive `running` state. Existing `waiting`, `retry`, `complete`, and
`exhausted` records remain valid. On restart, `running` is treated as
recoverable work, and stable candidate command IDs protect any partial output.
The test and documentation changes can be reverted without data migration;
disabling extraction leaves the canonical terminal Run and any existing
reviewable candidate facts intact.

## Acceptance criteria

- [x] Recovery finds terminal Runs when the crash happened before enqueue.
- [x] An in-flight Job has an explicit `running` state and is re-enqueued after
      restart rather than skipped as complete.
- [x] Interrupted extraction creates no candidate; resumed execution produces
      one idempotent review-gated candidate before the Job reaches complete.
- [x] Start response/current projection, job completion, and candidate review
      state remain separate.
- [x] Focused Job tests, CLI Run start/terminal behavior, and owner docs agree.

## Evidence

- Implementation: [`memory-background-pipeline.ts`](../../../packages/core/src/domains/memory/memory-background-pipeline.ts),
  [`memory-control.ts`](../../../packages/core/src/domains/memory/memory-control.ts),
  [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts), and
  the [`RunProjection` status contract](../../../packages/contracts/src/projection.ts).
- Tests: [`memory-background-pipeline.test.ts`](../../../packages/core/src/domains/memory/memory-background-pipeline.test.ts)
  covers terminal inventory recovery, stale `running` recovery, retry/idempotency,
  lease serialization, and shutdown; [`e2e.test.ts`](../../../apps/cli/src/e2e.test.ts)
  observes Run status separately from later completion.
- Verification: Core Memory Episode/Job/Runtime tests passed (3 files / 13
  tests); CLI end-to-end tests passed (1 file / 4 tests). Core build and test
  typecheck passed. `verify:v2-docs`, `graph:modules:check`, `verify:boundaries`,
  `verify:invariants`, `verify:package-readmes`, and `git diff --check` passed.
- Documentation: [`08-Memory-记忆子系统.md`](../../../docs/modules/08-Memory-记忆子系统.md),
  [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md), and the
  [implementation roadmap](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md).

## Deferred

General Workflow definitions and dependency graphs, independent durable
operation resources/query APIs, client cursor continuation, workflow-level
retry/verifier/compensation policies, and detached Subagent ownership.
