---
id: 2026-09-30-mem-041-memory-lifecycle
title: Implement Memory V2 lifecycle transitions in the canonical Evidence Ledger
status: implemented
owners: [memory, contracts]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-lifecycle, memory-contract, memory-persistence]
supersedes: []
---

# Agent Note: Implement Memory V2 lifecycle transitions in the canonical Evidence Ledger

## Problem

MEM-040 defines a versioned V2 record and a review-gated migration sidecar, but it does not define lifecycle commands, transition events, or their concurrency boundary. The current G-21 JSONL store must remain the canonical V1 store until a separately reviewed cutover.

## Current state

- `MemoryRecordV2Schema` defines candidate/active/disputed/superseded/revoked/expired states.
- The V1 runtime and Run Event Ledger are Session/Run scoped. MEM-041 adds an owner-scoped Memory aggregate stream to the canonical Evidence Ledger without changing Run `SessionEvent` envelopes.
- V1-to-V2 sidecars contain candidate records but are not loaded by Runtime.
- Core exposes a lifecycle service over an immutable V2 candidate seed; G-21 Runtime remains on V1.

## Decision

Implement a V2-only lifecycle service over an owner-and-memory keyed append-only stream owned by the canonical `@tracegraph/evidence` Event Ledger. `JsonlEventLedger` stores it under a dedicated hashed namespace within the existing Evidence Ledger root; Core does not create a second event store. The stream is the source of lifecycle transition facts; the V2 record/sidecar remains the source of claim and provenance data. Every `memory.lifecycle.transitioned` event records aggregate identity, exact record version, sequence, action, from/to status, actor, reason code, optional related memory, and hash-chain linkage. It excludes claim text and free-form review prose.

The service uses an expected lifecycle sequence for optimistic concurrency and an idempotency key for retries. The Evidence Ledger serializes writes through one ledger instance, publishes the stream under its existing durable replace/hash-chain boundary, and rejects sequence, hash-chain, schema, status-chain, and identity drift. One aggregate stream is bound to a fixed Memory record version; content changes require a new Memory version/aggregate decision. Multiple ledger instances/processes sharing a root remain unsupported until cross-process coordination is added.

The lifecycle API is opt-in and is not wired into G-21 `remember()`/`recall()`, Runtime startup, or the V1 store. Active status does not itself authorize model use or export; existing scope and governance checks remain required. A migrated `legacy_unclassified` record cannot activate until a separate user-reviewed record supplies valid classification and governance. It may be rejected/revoked while remaining unusable.

## Transition policy

- Candidate: explicit user `review_activate` may activate it; `review_reject` revokes it.
- Active: user/system evidence may dispute; an active replacement may supersede it; user/system governance may revoke it; system retention/policy may expire it.
- Disputed: user review may restore active or resolve as superseded; it may also be revoked.
- Superseded: it may only be revoked.
- Expired: user `revalidate` returns it to candidate with a future validity end and resets `validFrom`; it may also be revoked.
- Revoked is terminal. No transition silently edits claim content or makes a candidate active without explicit user review.

Each transition is one event. Supersession records a related memory ID but does not atomically mutate another aggregate; callers must coordinate successor admission separately until a cross-aggregate transaction is designed.

## Alternatives

- Store lifecycle Events in the originating Run stream: rejected because Memory ownership is independent of its originating Run. Keep a separate owner-scoped Memory aggregate stream inside the canonical Evidence Ledger instead.
- Rewrite the V1 `records.jsonl` or make the MEM-040 sidecar canonical: rejected because this task must not implicitly migrate user data or switch Runtime reads.
- Keep only an in-memory state machine: rejected because lifecycle changes must survive restart and be replayable.

## Invariants

- Illegal status/action pairs and actor/reason combinations are rejected before persistence.
- The projection is deterministic from a candidate seed record and its verified lifecycle events.
- Each committed state transition has exactly one append-only event; retries with the same idempotency key resolve to that event.
- A stale expected sequence cannot append a competing transition.
- V2 content version stays fixed within one lifecycle stream; status transitions do not create content revisions.
- Memory owner identity is never inferred from Run or Session IDs.
- Lifecycle events never contain raw claim text; they carry only bounded reason codes.
- No Runtime or UI behavior changes until a later task explicitly composes this service.

## Migration and rollback

No existing data is read or changed by default. Callers opt in with an Evidence Ledger and a V2 candidate seed. Rollback consists of stopping use of the new API while preserving already committed lifecycle events in the canonical Ledger. Physical deletion of those facts follows a separate retention/deletion decision. V1 records and MEM-040 sidecars remain untouched.

## Acceptance criteria

- [x] Strict lifecycle command/event schemas and valid transition policy.
- [x] Illegal transitions, invalid activation, wrong identity/version, stale sequence, corrupt chain, and conflicting idempotency keys fail closed.
- [x] Replay reconstructs status and revalidation validity from the candidate seed plus events.
- [x] Each successful transition emits one owner-scoped, content-free event; restart and retry semantics are explicit.
- [x] Current Memory module docs and roadmap distinguish this shipped API from the unchanged V1 Runtime.

## Risks and open questions

- The ledger currently provides single-instance writer serialization only; multiple instances/processes sharing a directory remain unsupported.
- Superseding two Memory aggregates is not atomic. The later Memory control plane must sequence and reconcile these writes safely.
- Physical deletion, key destruction, encryption, canonical V2 record storage, and Runtime/UI integration remain deferred.

## Evidence

- Implementation: `packages/contracts/src/memory.ts`; `packages/evidence/src/event-ledger.ts`; `packages/core/src/domains/memory/memory-lifecycle.ts`; public Core/Evidence package exports.
- Tests: `packages/contracts/src/memory-v2.test.ts`; `packages/core/src/domains/memory/memory-lifecycle.test.ts`; existing Core Memory and Evidence test suites.
- Generated docs: `docs/generated/module-graph.md` and `docs/generated/current-baseline.md` were regenerated after their check commands found them stale. The baseline change captures the whole current working tree, including the already-present PKG-032–035 package extractions; its 18-package/60,840-line/143-test-file counts must not be attributed to MEM-041 alone.
- Verification: `pnpm typecheck` passed workspace build/typecheck across all projects; Contracts focused tests (6), all Core Memory tests (19), and all Evidence tests (3) passed. `pnpm verify:v2-docs` passed (11 manifest docs/62 roadmap tasks), `pnpm verify:boundaries` passed (18 packages/34 dependencies/1,466 imports/0 legacy findings), `pnpm verify:package-readmes` passed (18 packages), `pnpm verify:invariants` passed (203 source files), `pnpm graph:modules:check` and `pnpm baseline:current:check` passed after regeneration, and `git diff --check` passed. Commands were run with `NODE_OPTIONS` unset because the shell's inherited preload path was unavailable.
