---
id: 2026-10-03-mem-043-bounded-job-index
title: Bound Memory job queries and validate corrected model lineage
status: implemented
owners: [memory, workbench]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [memory-background-pipeline, memory-control, workbench]
supersedes: []
---

# Bound Memory job queries and validate corrected model lineage

## Problem

Review found two gaps: corrected model-derived records retain model origin and gain user evidence, so the original derived-only check excludes trusted corrections; job queries scan every Run twice despite the 100-row response cap.

## Current state

Deterministic consolidation and inspectable persisted jobs exist. Corrected model Memory now participates through authenticated user revision ancestry; job GET reads a replayable per-project latest-100 index and exposes cold-start history recovery to the UI.

## Decision

Validate a corrected record through at most 64 canonical correction links to its original derived seed. Every correction must bind user actor, immutable claim digest, exact scope, version, supersession and the expected appended user evidence; the original Run evidence must still validate.

Maintain a read-only in-memory job projection grouped by canonical project scope, retaining at most 100 latest jobs per project. Background recovery rebuilds the projection from canonical Run identity plus operational job state; successful local job writes update it. Requests read only selected project buckets, merge and return at most 100. Empty scope performs no reads. The optional `backgroundJobsLoading` field explicitly marks incomplete cold-start history; the UI must not call an incomplete empty snapshot 'no jobs'.

## Alternatives

A separate authoritative job database duplicates canonical facts. Scanning all Run streams for every refresh leaves request cost unbounded. Neither is selected.

## Invariants

The cache is disposable and never grants scope or Memory authority. Project scope derives from canonical Run events. Correction ancestry never permits missing/deleted/uncommitted or foreign-scope evidence to participate. Historical projection warmup and rescan are background work, not a request dependency.

## Migration and rollback

No Memory or job payload migration is required. The additive optional history-loading field preserves older replies. Removing the cache recreates the previous scan path; canonical records remain unchanged.

## Acceptance

- [x] Derived -> user correction -> activation -> next Run supports exact and changed-key comparison.
- [x] Broken correction lineage and deleted ancestor Run cannot bypass validation.
- [x] Large multiple-project history yields bounded request reads, zero reads for empty scope and explicit cold-start loading.
- [x] Focused tests, Runtime integration and current docs agree.

## Risks

The cache reflects the last background refresh plus successful writes by this worker; multi-Host sharing remains outside the supported Memory control deployment. Source removal is reconciled on background refresh. Earlier-than-100 jobs per project are intentionally omitted.

## Evidence

- Implementation: [correction chain validation](../../../packages/core/src/domains/memory/memory-control.ts), [job recovery and bounded query](../../../packages/core/src/domains/memory/memory-background-pipeline.ts), [Runtime loading](../../../packages/core/src/domains/runtime/runtime.ts), [optional response field](../../../packages/contracts/src/memory-control.ts), [shared UI](../../../packages/workbench/src/components/MemoryBackgroundJobs.tsx).
- Tests: [jobs and ancestry](../../../packages/core/src/domains/memory/memory-background-pipeline.test.ts), [Runtime](../../../packages/core/src/domains/runtime/runtime.memory-episode.test.ts), [contract](../../../packages/contracts/src/memory-background-jobs.test.ts), [UI](../../../packages/workbench/src/components/MemoryBackgroundJobs.test.tsx), [real Desktop Host](../../../apps/desktop-host/src/desktop-host.e2e.test.ts).
- Current documentation: [Memory module](../../../docs/modules/08-Memory-记忆子系统.md), [Memory V2](../../../docs/outlive-agent-v2/04-memory-and-experience/README.md), [Episode](../../../docs/outlive-agent-v2/04-memory-and-experience/01-evidence-episode-pipeline.md).
- Verification on 2026-10-03 (process-scoped `env -u NODE_OPTIONS`): Core typecheck/build, pipeline 17 + Runtime 1, contracts 2, Workbench typecheck/UI 4, and built Desktop Host real e2e 4 passed. The 350-Run two-project fixture performs 350 recovery reads, then zero Ledger reads for repeated single/multiple/empty-scope GETs. Independent read-only review ran the 17 pipeline tests successfully; the final Core full suite passed 56 files / 468 tests.
- Negative evidence: a missing correction parent, forged appended user reference or deleted ancestor Run cannot provide deduplication or lineage. A competing worker previously returned early on terminal prior state, leaving its cached running marker unchanged; it now indexes the canonical project state before skipping extraction. The two-worker same-Run regression proves one extraction and both indexes reaching complete. An early test queried after file rename but before directory fsync/index publication, causing a restart snapshot mismatch; the test now waits for the persisted index state without publishing before fsync completes.
