---
id: 2026-09-29-core-024-map-core-modules-to-domains
title: Map flat Core source modules into domain owners
status: implemented
owners: [core]
created: 2026-09-29
last_reviewed: 2026-09-29
affects: [core-domains, architecture, documentation]
supersedes: []
---

# Agent Note: Map flat Core source modules into domain owners

## Problem

`packages/core/src` still contains many production modules and their tests at
its root. The kernel, seams, tools, and extensions have begun to establish
internal ownership, but evidence, session, context, model, memory, runtime,
and other feature code still relies on flat paths. This obscures module
ownership and leaves internal callers coupled to historical locations.

## Implemented state

- The CORE-024 roadmap dependencies CORE-021, CORE-022, and CORE-023 are
  implemented.
- Core implementation and tests now live under `domains/`, `kernel/`, or
  `seams/`; `src/index.ts` is the only file at the source root.
- Package-root exports point directly to the new owners and retain the
  `Disposable` type export. Internal relative imports, eval source imports,
  coverage paths, and Ledger/Projection invariant paths use the new locations.
- `DIRECTORY.md`, current module docs, V2 source mappings, the generated module
  graph, and the current baseline were synchronized.

## Implementation

Completed as a move-only refactor under CORE-024.

**Target:** move remaining Core implementation and tests into domain owners:

- `domains/evidence/`: Action WAL, Artifact store/attachment, Event Ledger,
  Projection, Replay, and their tests;
- `domains/context/`, `credentials/`, `memory/`, `model/`, `session/`,
  `skill/`, `subagent/`, `team/`, and `todo/`: each feature implementation
  and its focused tests;
- `domains/runtime/`: Runtime, runtime telemetry, and Runtime integration
  tests, without extracting or changing the loop;
- `domains/tools/`: Tool output limits and existing Tool/Policy/Approval
  tests; `domains/extensions/` retains its CORE-023 ownership;
- `kernel/` and `seams/sandbox/`: move their remaining root-level tests next
  to the implementation owners.

Keep `src/index.ts` as the only root-level file. Rewrite package-root exports
to point directly to the new owners, update internal relative imports and the
single eval source import, and synchronize all current module documentation,
directory references, and source-path checks. Preserve every package-root
export and declaration while removing obsolete flat compatibility facades.

**Deferred:** changing behavior, public exports, persisted formats, Runtime
state ownership, internal service boundaries, dependency policy, package
topology, or task responsibilities assigned to CORE-025 through CORE-028.

## Alternatives considered

- Keep flat re-export facades for each former module: rejected because CORE-024
  requires `src/` to contain only `kernel/`, `domains/`, `seams/`, and
  `index.ts`.
- Leave tests at the source root: rejected because it would leave the flattened
  source tree and its ownership signals incomplete.

## Invariants and boundaries

- Relocation only: no function body, branch, schema, event ordering, filesystem
  effect, or runtime policy changes.
- The `@tracegraph/core` package-root export names and types stay compatible.
- Internal imports resolve to their new owning modules; no source imports a
  compatibility facade because those facades are removed.
- Existing focused, CLI vertical E2E, and Ledger replay behavior suites remain
  in place and pass without semantic expectation changes.
- All non-directory entries at `packages/core/src/` consist solely of
  `index.ts`; directories are limited to `kernel/`, `domains/`, and `seams/`.
- Current docs and machine-consumed source-path references identify the new
  locations; proposed architecture claims remain labelled as such.

## Migration and rollback

Move files using the ownership map, rewrite relative module specifiers from the
pre-move resolution graph, update the root export barrel and source-linked
docs, then run Core, CLI E2E, replay, and architecture checks. Rollback restores
the previous paths/import graph and old root barrel. No data or config
migration is required.

## Acceptance criteria

- [x] Only `kernel/`, `domains/`, `seams/`, and `index.ts` remain at Core `src/` root.
- [x] Package-root exports retain their prior names and declaration behavior.
- [x] Focused Core tests, CLI vertical E2E, and Ledger replay checks pass.
- [x] Current module docs, `DIRECTORY.md`, eval source references, and generated
      module graph point to the moved modules.
- [x] Build/typecheck, engineering gates, boundaries, docs, and diff checks pass.

## Migration observations

- Cross-domain relative imports were rewritten against the pre-move resolution
  graph and verified by full workspace typecheck and Core tests.
- Source-path references in current docs, evals, coverage, and architecture
  invariant checks were synchronized; line-numbered Runtime excerpts were
  preserved because the implementation body did not change.
- `runtime.ts` moved intact. Its later state-machine extraction and
  responsibility reduction remain owned by CORE-025 and CORE-028.

## Evidence

- Implementation: 59 modules/tests relocated to domain owners; four old flat
  facades removed; 229 internal relative imports rewritten; package-root barrel
  maintained; coverage and architecture invariant paths moved with their owners.
- Tests: Core unit/focused suites passed (40 files, 385 tests); CLI vertical E2E
  passed (4 tests); Ledger Replay is included in the passing Core suite;
  implementation-consistency and Memory Context evals passed (7 tests).
- Verification: full workspace build/typecheck including eval typecheck;
  engineering gates (47 Node tests and 8 Vitest tests); boundary check (12
  packages, 20 workspace dependencies); invariants (164 production source
  files); V2 docs (11 manifest documents, 62 roadmap tasks); package README
  contracts (12 packages); module graph and current baseline drift checks;
  `git diff --check`.
