---
id: 2026-09-30-mem-040-memory-contract-v2-migration
title: Define a versioned Memory V2 contract and a review-gated adjacent migration
status: implemented
owners: [memory, contracts]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-contract, memory-migration, memory-ownership]
supersedes: []
---

# Agent Note: Define a versioned Memory V2 contract and a review-gated adjacent migration

## Problem

G-21 persists strict, unversioned `MemoryRecord` rows in `<dataDir>/memory/records.jsonl`. Outlive V2 defines richer provenance, validity, governance, and lineage fields and assigns cross-Session Memory to an owner-scoped aggregate. Reinterpreting the current JSONL in place would make rollback and lossless comparison difficult; guessing an owner or eligibility from the originating Run would also conflate source history with Memory ownership.

## Current state

- `MemoryRecordSchema` is the current G-21 shape; `JsonlMemoryStore` reads and writes it directly. The store is the canonical admitted-record source and retrieval indexes are rebuildable projections.
- Current Memory Ledger facts are emitted in the invoking Run/Session. There is no independent Memory aggregate stream or V2 state machine yet.
- The current data directory is local and may contain user records. MEM-040 must not rewrite or inspect that live data as part of development validation.

## Decision and implementation

`MemoryRecordV1Schema` keeps the original strict G-21 shape and `MemoryRecordSchema` remains its compatibility alias with the same default and ZodObject API. `MemoryRecordV2Schema` is a separate executable contract. Its migration envelope preserves the exact parsed V1 row shape, including omitted defaulted fields. The converter requires explicit owner ID and migration time and never derives ownership from a source Run/Session. Imported rows are candidates requiring review; unclassified records cannot be used by the model or exported.

Core exports `migrateMemoryJsonlAdjacent()`. It validates the complete V1 JSONL, stages a mode-0600 sidecar, and publishes `records.v2.jsonl` by same-directory exclusive hard link. It leaves `records.jsonl` byte-for-byte unchanged, refuses to overwrite an existing target, and returns only path/count metadata. Removing the adjacent output is the rollback; no canonical-store cutover or dual write occurs in MEM-040.

The V2 contract expresses ownership as `ownerId + memoryId`; Session/Run identifiers remain source scope/provenance and are not part of aggregate identity. The migration preserves legacy `runId`, marks every imported record candidate, and defaults consent to none with model use/export disabled. MEM-040 defines this boundary but does not implement the Memory Ledger stream or lifecycle commands.

### Deferred

- Lifecycle transitions, independent Memory Ledger stream persistence, review UI, conflict resolution, MemoryUse, automatic Episode extraction, and auto-Recall policy changes remain in later roadmap tasks.
- Encryption, key lifecycle, physical deletion, backups, tombstones, and canonical-store cutover still require their own implementation-time ADR and recovery evidence.

## Alternatives considered

- Rewrite `records.jsonl` in place: rejected because an interrupted conversion would remove the direct rollback source.
- Guess an owner or promote legacy `confirmed` rows to V2 `active`: rejected because G-21 has no owner identity or V2 governance/consent evidence. Every migrated row therefore remains review-gated.
- Start a second Memory journal or dual-write Events: rejected because it would create two durable truths before the Memory aggregate and transaction boundary exist.

## Invariants and boundaries

- V1 parsing remains strict and lossless; current G-21 Runtime behavior remains on V1 for this task.
- V2 and migration-envelope schemas are strict, versioned, and tested for status, scope, provenance, validity, governance, and lineage constraints.
- Every envelope retains its exact parsed V1 source record; migration does not drop legacy admission metadata or widen source scope.
- Owner identity is explicit input. The Memory aggregate identity is independent of a Session/Run; source Session/Run facts remain in source evidence.
- Adjacent output is private, opt-in, non-overwriting, and never becomes canonical or eligible for recall automatically.

## Migration and rollback

Validate the full source JSONL, convert each row into a V2 review envelope, then publish one sibling `records.v2.jsonl` file. A malformed row, missing owner, invalid date, or existing target fails before publication. The original file is not modified. Rollback removes only the generated sibling file; runtime continues to read the V1 canonical file.

## Acceptance criteria

- [x] V1 schema/read path accepts existing rows without changing the V1 shape.
- [x] V2 schema tests cover status, scope/owner, provenance, validity, governance, and lineage invariants.
- [x] V1-to-V2 conversion is lossless and review-gated; missing ownership cannot be guessed.
- [x] Adjacent migration refuses overwrite and leaves the source byte-identical; invalid rows/options publish no output.
- [x] Memory module docs and roadmap distinguish shipped contract/migration tooling from deferred lifecycle/runtime cutover.

## Risks and open questions

- A future runtime cutover must supply a stable owner identity and decide how legacy Run scope maps into V2 authorization without widening it.
- MEM-041 has since implemented the owner-scoped lifecycle stream in the canonical Evidence Ledger with per-instance serialization, expected-sequence CAS, idempotency, and hash-chain checks. Historical Run/Session event migration policy remains deferred.
- Existing legacy expiry timestamps may not form a valid interval with creation time; those rows must remain readable in V1 and fail migration with a row-specific diagnostic rather than be silently repaired.
- Atomic no-overwrite publication requires same-directory hard-link support; unsupported filesystems fail closed without changing the canonical V1 file.

## Evidence

- Implementation: `packages/contracts/src/memory.ts` defines V1/V2 schemas and the exact-row migration envelope; `packages/core/src/domains/memory/memory-migration.ts` publishes an opt-in sibling file. `docs/modules/08-Memory-记忆子系统.md`, the V2 memory overview, the contracts/Core READMEs, and roadmap acceptance describe the actual cutover boundary.
- Tests: contracts 21 files / 142 tests passed; Core 42 files / 369 tests passed. New fixtures verify field-preserving migration, missing defaulted fields, owner/run scope, privacy mode, source-byte preservation, overwrite refusal, and invalid-row/options failure without output.
- Verification: full `pnpm typecheck` passed; `pnpm test:engineering` passed (48 Node tests + 8 coverage-gate tests); implementation-consistency eval passed (6 tests); `verify:boundaries` passed (18 packages, 34 dependencies, 1,455 import references); `verify:v2-docs` passed (11 documents, 62 tasks); package README, lockfile, invariants, generated graph/baseline, and `git diff --check` passed. The migration was tested only on isolated temporary fixtures; no local user Memory file was read or changed.
