---
id: 2026-10-03-mem-043-cross-run-job-control
title: Make cross-Run candidate consolidation and background jobs inspectable
status: implemented
owners: [memory, contracts, workbench]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [memory-background-pipeline, memory-control, workbench]
supersedes: []
---

# Agent Note: Make cross-Run candidate consolidation and background jobs inspectable

## Problem

MEM-043 currently extracts one Episode per settled Run. Derived candidate creation compares stored claims and keys, but its cross-Run decision is not independently inspectable and background job files have no client surface.

## Current state

The owner lease serializes Run extraction; five bounded attempts and stable candidate commands survive recovery. Run and Memory control facts use the Evidence Ledger. Job v2 additionally persists content-free result references and request digests; v1 remains readable with an explicit no-details marker. The shared Memory controller exposes records, conflicts and project-scoped jobs to Web and Desktop.

## Decision

Core now performs deterministic consolidation across prior committed, scope-local Run candidates. Exact kind/key/claim matches produce an unchanged result; changed claims with an evidence-backed matching key create review-gated candidates with comparison lineage. Prior invalid, revoked, expired, rejected, untrusted, uncommitted, deleted, or out-of-scope records must not become consolidation evidence. The worker persists bounded content-free result references after every settled slot and exposes a scope-filtered job projection through the existing Memory list query. A dedicated UI section displays waiting/running/retry/complete/exhausted state, attempts, failure code, candidate IDs, source Run IDs, and before/after comparisons from the existing visible records.

Delivered: inspectable deterministic cross-Run candidate/diff consolidation and durable task state. Inventory filenames are resolved back to canonical event Run IDs (including `run:UUID`); retry cannot change or omit an already committed result slot. Partial results survive extractor reconfiguration and retry. Error codes use an explicit allowlist. Deferred: semantic/model-driven cross-Run synthesis, scheduling controls and separate canonical Episode storage.

## Alternatives considered

A separate canonical consolidation event store would duplicate Memory facts; the proposal retains immutable candidate seeds and the existing control/lifecycle journal. Silent active-record edits remain prohibited.

## Invariants and boundaries

Owner/project scope and canonical source validation remain authoritative. Consolidation never activates, edits or supersedes a Memory. Operational jobs contain IDs, digests, counts and codes, never claims or extracted text. The optional additive list field preserves existing clients and v1 job reads.

## Migration and rollback

Existing v1 job files are read with `resultDetailsAvailable: false`; their legacy proposal counts are not labelled as new candidates. New writes use v2. No existing Memory record is migrated. For rollback to an old reader, first stop workers, retain canonical Run/Memory data and discard only v2 operational job files before regenerating from settled Runs. Stable Memory command IDs prevent duplicated committed candidates.

## Acceptance criteria

- [x] Two settled Runs demonstrate unchanged and changed-key outcomes without changing an active record.
- [x] Cross-project, uncommitted, invalid source and revoked records fail closed or cannot participate.
- [x] Job state survives restart, shows retry/exhaustion/waiting and contains no claim text.
- [x] Shared protocol and UI expose scoped job state independently of the record list.
- [x] Focused tests, typechecks and current Memory documentation agree.

## Risks and open questions

Exact matching intentionally does not assert semantic equivalence. The status surface exposes bounded recent operational history. The [bounded job index follow-up](2026-10-03-mem-043-bounded-job-index.md) defines background recovery, history loading and authenticated user-correction ancestry.

## Evidence

- Implementation: [control service](../../../packages/core/src/domains/memory/memory-control.ts), [worker](../../../packages/core/src/domains/memory/memory-background-pipeline.ts), [Runtime query](../../../packages/core/src/domains/runtime/runtime.ts), [contract](../../../packages/contracts/src/memory-control.ts), [job UI](../../../packages/workbench/src/components/MemoryBackgroundJobs.tsx).
- Tests: [worker and cross-Run negatives](../../../packages/core/src/domains/memory/memory-background-pipeline.test.ts), [Runtime integration](../../../packages/core/src/domains/runtime/runtime.memory-episode.test.ts), [contract](../../../packages/contracts/src/memory-background-jobs.test.ts), [shared controller](../../../packages/api/src/memory-experience-controller.test.ts), [SDK](../../../packages/sdk/src/index.test.ts), [UI rendering](../../../packages/workbench/src/components/MemoryBackgroundJobs.test.tsx).
- Current documentation: [Memory module](../../../docs/modules/08-Memory-记忆子系统.md), [Episode pipeline](../../../docs/outlive-agent-v2/04-memory-and-experience/01-evidence-episode-pipeline.md).
- Verification (2026-10-03, process-scoped `env -u NODE_OPTIONS`): Contracts build and 8 focused tests; Core build/typecheck and 24 focused Memory/Runtime tests; shared API 3 tests; SDK 45 tests; Workbench typecheck and 68 focused/live-client tests passed. Core full unit suite then passed 56 files / 462 tests. After the final legacy-count projection fix, worker 11 tests plus Core typecheck/build passed again. Changed Markdown links and `git diff --check` passed.
- Negative evidence: the Runtime test initially found an empty job list for `run:UUID` because recovery queried a sanitized filename identity; resolving canonical IDs fixed it. The prior partial-commit test expected zero candidates although one was durably created; the persisted count and test now agree. Changed retry content produces `memory_background_result_changed` and retains the earlier result. A full-suite timeout exposed a real resume race: `waiting` was durable before the previous worker released its lease; active-task deduplication discarded the wakeup. `resumeWaiting()` now waits for that worker to settle before enqueuing, and the restart/configuration regression passes without increasing its timeout. Unavailable SDK locale declarations briefly blocked Workbench typecheck until the concurrently updated SDK was rebuilt; the final typecheck passed.
