---
id: 2026-09-30-mem-046-memory-control-plane
title: Unified V2 Memory review and governance control plane
status: implemented
owners: [memory-api, contracts, evidence, host, cli, web]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-control, memory-lifecycle, evidence-ledger, host-api, cli, web]
supersedes: []
---

# Agent Note: Unified V2 Memory review and governance control plane

## Problem

MEM-040–045 provide V2 contracts, lifecycle, Context/MemoryUse provenance, conflict detection, and feedback governance, but do not provide a user-visible way to inspect candidates, sources, status, or use requests and issue review, correction, revoke, or delete commands. CLI, Web, and a future Desktop client must not write files independently or implement different state machines. This work must not switch G-21 V1 recall.

## Current state

- `MemoryControlService` is the sole Core command/query service for V2 Memory. `AgentRuntime` owns its instance.
- A local owner-scoped V2 seed store is added at `<dataDir>/memory-v2/<sha256(owner)>/records.jsonl`. Each seed is immutable and has candidate status; current status is always derived by replaying MEM-041 lifecycle events.
- Host exposes list/create/review/correct/revoke/delete routes at `/api/memory`; SDK and CLI use Host. Host authenticates a local capability and derives `allowedScopeIds` from currently visible projects. Request bodies cannot choose owner or actor.
- The Web Memory panel can create candidates; inspect source, status, conflicts, feedback, and MemoryUse request stages; review, correct, revoke, and delete a correction lineage.
- Create, correction, and delete append content-free `memory.control.commanded` facts to the existing Evidence Ledger. Review and revoke use `memory.lifecycle.transitioned`. MemoryUse, feedback, lifecycle, and control remain separate aggregates/read models.
- Delete first commits a content-free tombstone containing lineage IDs and scope IDs, then rewrites the local V2 record file with fsync + rename. Repeated deletion replays the same family; a deleted ID cannot be recreated with the same command. Cross-scope access is hidden with 404.
- This repository currently has CLI, Web, and retrieval-service under `apps/`, but no Desktop client. The stable Host/SDK seam is ready for a future Desktop client; the roadmap's Desktop UI acceptance remains pending until that surface exists.

## Decision

Core control service is the only domain write entry point. Host performs authentication, command ID consistency checks, and scope derivation. Clients only transport domain commands; they cannot choose owner/actor or directly modify the seed store, projection, or Ledger. Current owner and user actor come from local Runtime configuration (default local single-user identity); this is not multi-user account or remote identity authentication.

V2 content and lifecycle state remain separate: the seed store contains candidate seeds, and status is rebuilt by replaying immutable lifecycle transitions. Content-free control events record create/correction/delete facts and tombstones; review/revoke do not copy claim text. Correction creates a new Memory identity/version and lineage, coordinated by events on two aggregates; the operation does not claim cross-aggregate transaction atomicity.

The current deletion promise is limited to the local V2 canonical candidate payload file. After the family tombstones are durably committed, that owner file is rewritten. Run, feedback, lifecycle, and control audit events remain. This does not clear G-21 V1 records, external Artifacts, backups, filesystem snapshots, or media remnants, and is not crypto-erase. Full erasure requires a separate decision on Artifact/key/backup lifecycle and replaying tombstones before recovery.

G-21 `remember()`/`recall()` and V1 `records.jsonl` are unchanged. The V2 recall gate is not connected to Runtime; MemoryUse status does not prove Provider acceptance or causal model use.

## Invariants

- All writes pass strict domain commands and are represented by Evidence Ledger lifecycle/control events; clients do not write files or projections.
- Host derives scope from currently visible registered projects on each request. An invisible record and a missing record both return 404. If a correction family crosses an invisible scope, the operation fails as a whole.
- New Memory defaults to `allowModelUse=false`; explicit user review is required to move a candidate to active. Model-use permission does not replace lifecycle review.
- Seed claim digest must match the create/correction control fact. Reusing an identical command is idempotent; reusing an identity/command with different claim, scope, or governance options is rejected.
- Delete tombstones contain IDs, scope IDs, digest/hash-chain metadata, and no Memory claim. Payload removal follows durable tombstone commit, and a retry cannot resurrect a deleted ID.
- Revoke changes eligibility without erasing content. Delete erases only the local V2 payload store. V1 and Run Ledger data are not rewritten.
- Web and CLI use the same Host/SDK seam. There is no current Desktop app, so future Desktop readiness is not reported as an existing UI delivery.
- The control queue and V2 payload writes are serialized only within one Runtime/Core service instance; multiple Hosts sharing one dataDir are unsupported.

## Migration and rollback

No automatic migration of existing V1 rows occurs; creating a V2 record does not read or rewrite the G-21 store. On code rollback, appended lifecycle/control/tombstone events remain. A rollback must not recreate deleted payload. If the UI/CLI entry point is disabled, Ledger interpretation and tombstone enforcement must remain available.

## Acceptance

- [x] Candidate inspect/create, review, correct, revoke, and family delete use the sole Core service.
- [x] Host/SDK, CLI, and Web use the same command/query seam; Host auth, command ID, and scope negative cases pass.
- [x] Provenance, conflicts, feedback review gates, and exact-version MemoryUse status are queryable; Adapter hand-off is not described as causal model use.
- [x] Negative cases cover revoked, deleted, cross-scope, repeated commands, lineage deletion, recreate-after-delete, and content-free tombstones.
- [x] G-21 V1 store/recall are unchanged; current/target documentation explains the V2-only payload deletion boundary.
- [ ] Desktop visibility and commands: no Desktop client exists in this repository; integrate when `DESK-065`/`CLIENT-068` provides that surface.

## Evidence

- Contracts: `packages/contracts/src/memory-control.ts`.
- Core: `packages/core/src/domains/memory/memory-control.ts`; Runtime entry points are in `packages/core/src/domains/runtime/runtime.ts`.
- Ledger: `packages/evidence/src/event-ledger.ts`.
- Host/SDK/CLI/Web: `packages/host/src/index.ts`, `packages/sdk/src/index.ts`, `apps/cli/src/memory-command.ts`, `apps/web/src/components/MemoryControlPanel.tsx`.
- Focused verification: 6 Core Memory control tests, 34 Core Memory tests, 55 Host tests, 3 CLI control tests, 12 Contracts Memory tests, and 4 Evidence public API tests passed.
- Full `pnpm typecheck` passed (build/typecheck for 18 workspace packages plus eval typecheck); `pnpm test:engineering` passed 48 Node checks and 8 Vitest checks; `pnpm verify:invariants` passed across 211 source files; `verify:v2-docs` validated 11 manifest documents and 62 roadmap tasks; the README gate validated all 18 packages; the boundary gate validated 18 packages, 34 dependencies, and 1,532 imports with zero legacy findings; `git diff --check` passed.
