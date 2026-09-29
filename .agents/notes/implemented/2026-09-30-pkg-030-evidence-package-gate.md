---
id: 2026-09-30-pkg-030-evidence-package-gate
title: Extract the Evidence family through an acyclic public package boundary
status: implemented
owners: [evidence]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [evidence, core, package-topology]
supersedes: []
---

# Agent Note: Extract the Evidence family through an acyclic public package boundary

## Problem

`PKG-030` depends on completed `CORE-028` and identifies `packages/evidence` for
the Event Ledger, Artifact Store, Projection, and Replay. A direct move would
leave those modules importing Core Kernel crypto functions and would leave
Projection importing Team/Todo projectors from Core. If Evidence then imports
Core to reuse those implementations while Core depends on Evidence, the
workspace graph cycles.

## Current state

- `packages/evidence` now owns Event Ledger, Artifact Store, Projection, and
  Replay implementations. Core keeps `action-wal.ts`, `attachment.ts`, and a
  local compatibility façade.
- Core's package root exports the compatibility façade. Its adapter imports
  only `@tracegraph/evidence`'s public root and binds the canonical Kernel
  helpers plus Team/Todo projectors.
- Runtime, credential migration, Team, Context, and other Core domains use the
  Evidence behavior or its contracts. They currently belong to one physical
  workspace package; Host calls Runtime's replay interface rather than
  consuming Evidence directly.
- `projectRun(events, ports)` is synchronous and imports no I/O APIs. The
  invariant gate now checks the package source location and still rejects I/O.
- Focused Core behavior tests remain in place. Package contract tests exercise
  Ledger integrity/idempotency, Artifact scope/hash, Projection purity, and
  Replay anchors/hashes through `packages/evidence/src/index.ts`.

## Accepted design

**Maintainer review accepted staged execution of `PKG-030` on 2026-09-30.**
The package has now been extracted behind the acyclic dependency direction:

- `@tracegraph/evidence` exposes a narrow root API over the selected Event
  Ledger, Artifact, Projection, and Replay modules.
- Existing Core-owned hash, redaction, ID, and Team/Todo projection functions
  are injected through typed ports. The Evidence package has no Core import.
- `@tracegraph/core` package-root exports and construction behavior remain
  compatible through the local runtime-service adapter.
- Selected implementations and package-level conformance tests live in the
  package. Package inventory, dependency policy, invariant paths, generated
  graph, README, and current module documentation are updated.

### Gate decision

Core is currently the only direct workspace-package consumer; Runtime,
Credentials, Context, Team, Todo, and other Core domains consume the service
inside that package. The accepted hard-isolation reason is the Evidence
boundary's independent append-only persistence, scope/hash verification, and
deterministic replay contract. Extracting it removes Core-owned implementation
imports from the public package surface and leaves a one-way `core -> evidence`
edge; typed ports preserve the single canonical crypto/redaction owner and
avoid moving Runtime authority or Team/Todo implementations. Public API
contract tests exercise the package independently of Core.

**Deferred:** Action WAL, Recovery Ledger, Attachment, changes to Ledger/Event
semantics, and any duplicate crypto or redaction implementation.

## Alternatives considered

- Let `@tracegraph/evidence` import `@tracegraph/core` for shared helpers and
  Team/Todo projection: rejected because Core must depend on Evidence and the
  package graph would cycle.
- Copy Core crypto/redaction into Evidence: rejected because the registered
  secret guard and canonical hashing/redaction rules must have one owner.
- Move Action WAL and Attachment along with the selected family: rejected
  because neither is in the PKG-030 scope and both have distinct authority
  and side-effect seams.

## Invariants and boundaries

- Canonical Ledger writes remain unique; Event schema, order, idempotency, and
  replay hashes remain unchanged.
- Projection remains synchronous, deterministic, redacted, and free of I/O.
- Evidence depends on `@tracegraph/contracts`, Zod, and Node platform APIs; it
  never depends on Core, Runtime, Team, Todo, Host, or apps.
- Core crosses into Evidence only through its declared package-root exports.
- No second implementation of the existing hash, redaction, or ID helpers is
  introduced; Runtime retains workspace, approval, and execution authority.

## Migration and rollback

Execution added the typed ports and Core adapter, then moved the selected
modules and their package contracts while preserving Core's consumer-facing
exports. If later package build, behavior parity, or cycle checks fail, restore
the selected modules to Core and remove the new workspace entry; no persisted
data migration is required.

## Acceptance criteria

- [x] `@tracegraph/evidence` has a narrow, documented root API and no Core
      dependency.
- [x] Core imports Evidence only through its package-root export; no deep
      cross-package paths or workspace cycles remain.
- [x] Contract tests cover Ledger integrity/idempotency, Artifact scope/hash,
      Projection purity, and Replay anchors/hashes through the public API.
- [x] Existing focused Core tests, CLI vertical E2E, and Ledger replay pass.
- [x] The single-writer and no-I/O Projection invariant gates follow the new
      source locations and retain failing fixtures.
- [x] Package policy, README, module graph, current docs, and baseline verify.

## Risks and open questions

- The Core-owned dependency adapters make the Evidence package's low-level
  constructor/functions explicit; keep them out of the user-facing Core API.
- Core remains the sole direct package consumer. Revisit extraction economics
  if a future Session or Host boundary would otherwise duplicate Evidence
  storage or replay behavior.

## Evidence

- Roadmap: `docs/outlive-agent-v2/roadmap.yaml` (`PKG-030`); `CORE-028` is
  complete.
- Package gate: `AGENTS.md` requires a stable boundary, two consumers or a
  hard-isolation reason, and contract tests.
- Source: `packages/evidence/src/{event-ledger,artifact-store,projection,replay}.ts`,
  `packages/core/src/domains/evidence/runtime-service.ts`,
  `packages/core/src/kernel/crypto.ts`,
  `packages/core/src/domains/team/team.ts`, and
  `packages/core/src/domains/todo/todo.ts`.
- Existing behavior coverage: `packages/core/src/domains/evidence/{storage,projection,replay}.test.ts`.

## Verification

- `pnpm --filter @tracegraph/evidence build`, `typecheck`, and `test:unit`:
  package builds cleanly; 3 public API contract tests pass.
- `pnpm --filter @tracegraph/core test:unit`: 416 tests pass; replay tests
  exercise sequence anchors, hash stability, and corruption rejection.
- `pnpm test:e2e`: CLI vertical E2E passes (4 tests).
- `pnpm typecheck` and `pnpm test`: all workspace builds, typechecks, unit
  tests, and engineering tests pass.
- `pnpm verify:boundaries`: 13 packages, 22 workspace dependencies, 1,364
  import references, zero legacy findings. `pnpm verify:invariants`: 176
  source files; `pnpm verify:package-readmes`: 13 package contracts.
- `pnpm verify:v2-docs`: 11 documents and 62 roadmap tasks. Module graph and
  current structural baseline checks pass. G16 performance eval passes 3/3;
  the generator restores all 8 metrics files and the latest report byte-for-byte.
- `pnpm test:engineering`: 48 Node tests and 8 Vitest gate tests pass, including
  a same-file duplicate Ledger writer counterexample.
- `pnpm release:check` and `git diff --check` pass.
