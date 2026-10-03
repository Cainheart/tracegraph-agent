---
id: 2026-09-30-mem-043-episode-consolidation
title: Derive review-gated Memory candidates from settled Run episodes
status: implemented
owners: [memory, contracts, evidence, runtime]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-episodes, memory-background-pipeline, memory-control, evidence-ledger]
supersedes: []
---

# Agent Note: Derive review-gated Memory candidates from settled Run episodes

> Follow-up (2026-10-03): deterministic cross-Run candidate/diff consolidation and the durable task-status UI are implemented in [MEM-043 closure](2026-10-03-mem-043-cross-run-job-control.md). Deferred statements below describe the initial 2026-09-30 slice.

## Problem

MEM-040–046 provide V2 contracts, provenance, lifecycle, conflict/feedback governance, and a visible candidate control plane. MEM-043 adds a first vertical slice for deriving a bounded Episode projection and reviewable candidate proposals from settled Run evidence. Extraction must not extend Run settlement, rewrite active Memory, or create a second authoritative Ledger.

## Current state

- Run facts are stored in the canonical Evidence Ledger; `run.completed`, `run.failed`, and `run.cancelled` are the settlement boundary.
- V2 candidate seeds are immutable local payloads; control/lifecycle facts use the same Evidence Ledger and status is replayed.
- Core now has a deterministic one-Run/one-terminal Episode projector with complete stream/hash validation. Episodes are projections, not separately persisted canonical records.
- A post-settlement owner-scoped worker stores content-free per-Run operational state, uses a process queue plus a cross-process owner lease, streams recovery inventory in batches of 32, and applies at most five attempts with exponential backoff.
- An optional ModelAdapter capability gets bounded, redacted, allowlisted event JSON. Returned candidate references are limited to rows actually sent and are revalidated against the canonical Run Ledger before the Memory control plane creates a candidate.
- Focused and Runtime behavior verification passes: projector identity/outcome/bounded-input checks; recovery, retry/idempotency, cross-process and expired-lease behavior; source mismatch/deletion and shutdown cancellation fail-closed behavior; and a Runtime vertical test for post-settlement extraction, review gating, duplicate no-op, and V2 Recall remaining off.
- G-21 V1 `remember()`/`recall()` remains current Runtime behavior and V2 Recall is not connected. Experience Cases, cross-Run consolidation, and a separately persisted Episode/task-status surface remain deferred.
- G-21 V1 `remember()`/`recall()` remains current Runtime behavior; V2 Recall is not connected.

## Proposal

- Add strict Run-event evidence references and an Episode projection contract. Episodes are deterministically rebuilt from a fully validated settled Run stream and are not a second source of Run facts.
- Schedule bounded extraction after settlement through a process-local queue; persist only rebuildable operational job state, lease expiry (file mtime), retry time, and source digest. On startup, stream terminal Run IDs in bounded batches to repair the commit-before-enqueue crash window.
- Use an optional `ModelAdapter` extraction capability. It receives a bounded, redacted, allowlisted projection of source events, treats that input as untrusted data, and returns untrusted candidate drafts that Core validates against exact event references. Lack of the capability produces an Episode without a candidate and does not affect the Run.
- Create derived candidates through `MemoryControlService` and the canonical Memory control stream. Derived candidate facts identify a system extractor and Episode but contain no claim text. All candidates remain review-gated, model use/export are disabled, and no V2 Recall path is enabled.
- Consolidation is deterministic and scope-local: an exact existing claim/key is a no-op; a changed claim on an explicit matching key creates another candidate with linked lineage so MEM-045 can expose conflicts. No active record is edited or superseded automatically.
- Use stable extraction version + Episode + candidate slot as the idempotency identity; a changed retry result for the same slot fails closed instead of creating another candidate. Bound events, output count/size, concurrent jobs, attempts, lease duration, and exponential retry delay. Invalid references fail closed and job state never retains derived claim text.

## Alternatives considered

- Store Episodes as a second canonical event format: rejected because Run facts already belong to the Evidence Ledger; Episodes are projections.
- Call the extractor synchronously before appending a Run terminal event: rejected because network/model latency or failure would block settlement.
- Reuse V1 `remember()` or silently change active V2 records: rejected because both bypass the V2 review control plane and immutable candidate lifecycle.
- Run model extraction when an adapter capability is absent: rejected; extraction is optional and failure must not alter Run outcome.

## Invariants and boundaries

- Only a hash-validated, terminal Run stream can be projected. Every candidate evidence reference must identify an exact event in that stream and preserve project, Run, Session, sequence, and hash identity.
- Model output is untrusted. It cannot choose owner, actor, project, scope, source trust, consent, active status, or model-use/export policy.
- The extractor sees only bounded, redacted event fields; source claims and provider output are never copied into extraction-job metadata or content-free Ledger facts.
- Every derived Memory starts as a candidate, is visible in the existing review surface, and requires an explicit user lifecycle transition before activation. V2 automatic Recall remains off by default.
- Per-scope consolidation is serialized by a lease; retries are bounded and idempotent. A lost lease cannot commit a second candidate or change active Memory.
- G-21 V1 stores, recall, and Run event histories are not migrated or rewritten.

## Migration and rollback

No existing Memory or Run data is rewritten. The queue and Episode projection are rebuildable from terminal Run streams; candidate creation remains idempotent through stable command IDs. Rollback may stop scheduling or disable the optional extractor but must retain committed candidate seeds and Ledger facts. Removing a derived candidate follows MEM-046 review/revoke/delete controls; it is not removed by clearing the operational queue.

## Acceptance criteria

- [x] Strict Episode/evidence/extractor contracts validate identity, boundedness, success/failure/abandoned outcome, and exact source references.
- [x] Terminal Run scheduling is fire-and-forget; startup repair is bounded; leases, retry backoff, and idempotency survive restart.
- [x] Extraction and deterministic consolidation only create inspectable V2 candidates; duplicate replay is a no-op and active records never change.
- [x] Candidate records and control facts preserve provenance without copying claims into append-only facts; model use/export remain disabled.
- [x] Failure, stale lease, shutdown cancellation, source mismatch/deletion, malformed evidence output, duplicate claims, and conflicting claims fail closed.
- [x] Focused tests, Runtime integration tests, and owning Memory/roadmap docs agree with shipped behavior; the implemented single-Run slice is distinguished from deferred cross-Run and Experience Case scope.

## Risks and open questions

- Model-assisted extraction adds a background provider request and cost. The composition must expose only an explicitly available extraction capability and must not retry beyond the persisted bound.
- An Episode with no safe extractable candidate is a successful no-op, not an extraction failure.
- Experience Case generation and index mutation remain separate tasks; this pipeline does not add a parallel retrieval index.

## Evidence

- Implementation: `packages/contracts/src/memory-episode.ts`, `packages/core/src/domains/memory/memory-episode.ts`, `packages/core/src/domains/memory/memory-background-pipeline.ts`, `packages/core/src/domains/memory/memory-control.ts`, `packages/core/src/domains/runtime/runtime.ts`, and `packages/evidence/src/event-ledger.ts`.
- Tests: `packages/core/src/domains/memory/memory-episode.test.ts`, `packages/core/src/domains/memory/memory-background-pipeline.test.ts`, and `packages/core/src/domains/runtime/runtime.memory-episode.test.ts` (12 focused/Runtime cases). Coverage includes settled/hash-validated Episode outcomes, bounded/redacted citations, restart recovery, retry after partial commit, owner lease serialization and stale takeover, source digest mismatch/deletion, cancellation, review gating, conflict lineage, duplicate no-op, and V2 Recall remaining off.
- Verification: `env -u NODE_OPTIONS pnpm --filter @tracegraph/core exec vitest run src/domains/memory/memory-episode.test.ts src/domains/memory/memory-background-pipeline.test.ts src/domains/runtime/runtime.memory-episode.test.ts` passed (3 files, 12 tests); `env -u NODE_OPTIONS pnpm --filter @tracegraph/core typecheck` passed; `env -u NODE_OPTIONS pnpm run verify:v2-docs` passed (11 documents, 62 roadmap tasks); `git diff --check` passed.
