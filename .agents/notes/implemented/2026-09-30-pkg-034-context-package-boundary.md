---
id: 2026-09-30-pkg-034-context-package-boundary
title: Extract the Context model-visible boundary behind a package API
status: implemented
owners: [context, core]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [context-package, model-visible-context, package-policy]
supersedes: []
---

# Agent Note: Extract the Context model-visible boundary behind a package API

## Problem

PKG-034 promotes the Context family only after the boundary is stable, has two real consumers or a hard-isolation reason, and has contract tests. The current builder and compaction chain are implemented under `packages/core/src/domains/context/`. The builder already emits a `ContextManifest` and model-visible context, but imports Core model types, Core's crypto compatibility module, and the shared Tool-output compaction threshold. Moving it unchanged would retain an inward dependency on Core.

## Current state

- `context.ts` and `context-compaction.ts` implement deterministic assembly, manifest/node lineage, strategy compaction, and spill locators. `token-meter.ts` implements calibration persistence and remains in Core, aligned with the future LLM family in the package topology.
- Core Runtime is the only production consumer of the builder. Runtime internals are not counted as separate consumers.
- `ContextManifestSchema` and related policy/item/node contracts live in `@tracegraph/contracts`; Core Runtime appends canonical lifecycle events and owns ArtifactStore/provider/model adapters.
- Existing Context and token-meter tests cover assembly and compaction; tests for compaction currently use Core's ArtifactStore implementation.

## Proposal

Promote Context assembly, the model-visible projection, compaction algorithms, and spill ports to `@tracegraph/context`, depending only on `@tracegraph/contracts`, `@tracegraph/tool`'s shared digest/ID/output-threshold helpers, and Node platform APIs. The package exports a narrow `TokenMeter` consumer port; the calibrated meter implementation remains in Core pending LLM-family extraction. Core consumes the package root through its curated Context Runtime façade and retains model-provider integration, ArtifactStore, Ledger/event lifecycle, and Run authority.

The hard-isolation reason is the model-visible trust boundary: the package must construct a bounded projection from attributed, potentially untrusted inputs and expose enough manifest evidence to reconstruct that exact projection, while remaining unable to import Runtime, provider implementations, apps, or Ledger authorities. This is an explicit isolation rationale, not a second-consumer claim.

This is move-only. The model-visible context string must be reconstructable from included manifest items in the same stable order. Policy defaults, byte/token limits, compaction ordering/fallback, Artifact refs, notices, calibration format, Ledger event timing, and provider calls remain unchanged. New Context providers, policy changes, schema changes, and general memory/model redesign are deferred.

## Alternatives considered

- Keep Context in Core: rejected for PKG-034 because it leaves the model-visible projection and its manifest invariant inside the same module boundary as Runtime orchestration.
- Count AgentLoopCoordinator and Runtime as two consumers: rejected because both are internal collaborators on one Core production path.
- Move Context unchanged: rejected because the package would keep imports of Core-owned model types and utilities.

## Invariants and boundaries

- `@tracegraph/context` has a public root API and does not import Core, Host, apps, or provider implementations.
- Context policy and manifest schemas remain owned by `@tracegraph/contracts`; their persisted shape does not change.
- Runtime remains the only production consumer for now and owns canonical event writes, ArtifactStore lifecycle, provider selection, cancellation settlement, and run authority.
- Context never treats model summary output or retrieved/tool data as trusted instructions; its projection is bounded and attributed.
- Package contract tests exercise the public Context API and reconstruct visible input from manifest items; Core integration tests continue to exercise real ArtifactStore and Runtime composition.

## Migration and rollback

Move the Context sources and focused tests into `packages/context`, replace Core-private types with narrow structural Context ports, and add the package to workspace manifests and managed architecture policy. Update Core's curated façade and imports to the Context package root. No persisted schema or data migration is required. Rollback restores the sources under Core, restores the old façade imports, and removes the package/policy entry.

## Acceptance criteria

- [x] `@tracegraph/context` builds without Core/app imports and exposes only its declared root API.
- [x] Package-root tests cover deterministic assembly, context/manifest reconstruction, compaction ordering and fallback, spill/refetch, and cancellation/error behavior; Core retains calibration persistence tests.
- [x] Core tests exercise package consumption with the real ArtifactStore and Runtime; model-visible output and canonical event behavior stay unchanged.
- [x] Package is registered as managed; Core has no direct imports from the moved Context implementation paths.
- [x] Current Context module docs, package README, roadmap, package policy, and generated module graph agree with the implementation.

## Risks and open questions

- `@tracegraph/tool` currently owns the shared Tool-output compaction threshold and canonical digest helpers. Context must consume those stable helpers without importing Tool execution mechanisms or duplicating values.
- The Core `ModelObservation` and `ContextSummaryInput` types are provider/Runtime-facing. The extracted package needs structurally compatible Context-owned types without moving provider ownership into Context.
- Existing tests that depend on Core ArtifactStore must remain covered as Core integration tests; package contract tests need an isolated ArtifactStore port fake.

## Evidence

- Implementation: `packages/context` owns the Context builder, compaction, manifest reconstruction, and public `TokenMeter` port; Core retains the calibrated meter implementation and Runtime/ArtifactStore/Ledger/provider authority. The bilingual Note is implemented without claiming a second production consumer; the hard-isolation rationale is the bounded, replayable model-visible Context projection.
- Tests: `packages/context` focused suite passed (27 tests); Core suite passed (41 files, 365 tests), including the real ArtifactStore Context package integration; CLI end-to-end suite passed (4 tests).
- Verification: Context build/typecheck and workspace `pnpm typecheck` passed; `pnpm test:engineering` passed (48 Node tests and 8 coverage-gate tests); `pnpm coverage` passed (1,009 tests, 77.83% overall line coverage, Context builder 90.51%, Tool policy engine 93.9%); boundary, package README, V2 docs, lockfile, generated graph, and generated baseline checks passed.
