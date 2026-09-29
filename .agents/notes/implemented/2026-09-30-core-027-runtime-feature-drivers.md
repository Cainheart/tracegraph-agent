---
id: 2026-09-30-core-027-runtime-feature-drivers
title: Register Runtime feature drivers as lifecycle contributions
status: implemented
owners: [runtime]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [core-runtime, memory, team, todo, attachment, architecture]
supersedes: []
---

# Agent Note: Register Runtime feature drivers as lifecycle contributions

## Problem

`runtime.ts` still performs Memory recall inline in the model-turn loop and
constructs Todo/Team bridges and claims Attachments at feature-specific call
sites. These paths make optional Runtime capabilities difficult to disable
without editing the coordinator and leave their lifecycle contribution points
implicit. CORE-027 requires individually disableable Memory, Team, Todo, and
Attachment drivers while keeping the agent loop free of feature-specific
branches.

## Current state

- CORE-025 extracted pure Run/Turn/Step transitions and CORE-026 routed
  Context/Tool/Evidence dependencies through curated façades. Those changes are
  present in the working tree and remain uncommitted.
- CORE-027 adds `RuntimeFeatureDriverRegistry` and registers built-in Memory,
  Team, Todo, and Attachment lifecycle contributions. All remain enabled by
  default; `disabledRuntimeFeatures` can disable each independently.
- Disabled features omit their Tool contributions, reject feature-specific
  Runtime API calls, and skip Memory/Attachment store initialization where
  applicable.
- Todo and Team facts, Attachment relations, and Memory evidence remain
  canonical Ledger facts; Memory records remain in the canonical Memory store.

## Implemented decision

- **Delivered:** Added a Runtime feature-driver registry with ordered lifecycle
  contributions for Run creation, model-turn Context, and Tool execution.
  Registered the existing Memory, Team, Todo, and Attachment integrations
  through that registry. Added a composition option to disable any of those
  drivers independently; all four remain enabled by default for compatibility.
- Disabled capabilities are unavailable through their Runtime APIs and
  model-visible Tools. Supplying staged uploads to a Run with Attachment
  disabled fails before Run side effects. Starting in plan mode requires the
  Todo driver because plan edits are Todo ledger mutations.
- Preserve existing enabled behavior, canonical event ordering, public
  projections, and replay. Keep existing persisted records/events intact when
  a feature is disabled; disabling is process configuration, not deletion.
- **Deferred:** third-party package loading, hot reload, state/schema migration,
  moving feature domain-service ownership, and extracting the full agent loop.
  CORE-028 remains responsible for shrinking `runtime.ts`.

## Alternatives considered

- Add feature checks directly to every loop branch: rejected because it keeps
  feature-specific policy in the coordinator and makes future contributions
  require more coordinator edits.
- Turn off the corresponding Tool definitions globally: rejected because
  feature availability is per Runtime composition and must not mutate a shared
  Tool registry.
- Delete disabled feature data: rejected because configuration must not alter
  canonical history or make earlier Runs unreplayable.

## Invariants and boundaries

- The registry owns enabled-driver lookup, contribution ordering, Tool
  ownership, and generic availability checks. Domain services remain the
  owners of Memory, Team, Todo, and Attachment behavior and state.
- The Event Ledger remains the source of Run facts. Memory's existing store
  remains canonical for admitted records. No event schema, event order,
  idempotency key, persisted format, or projection changes are introduced.
- Feature disablement must fail closed for explicit APIs and omit the
  corresponding model Tool bridges/schemas. Enabled default behavior must be
  unchanged.
- Feature contributions run in stable registration order. A contribution
  failure follows the current Runtime failure boundary; it is not silently
  ignored.
- The existing extension manager remains the trusted module/tool lifecycle
  owner; feature drivers are internal lifecycle contributions and do not load
  module paths or gain authority beyond their supplied Runtime bridge.

## Migration and rollback

Add the registry and built-in contributions, then route existing lifecycle
calls through it. Default-on configuration keeps current callers compatible.
Rollback removes the registry option and restores the existing direct
contribution calls; no data rewrite is required. A deployment that has disabled
a feature can re-enable it without migrating persisted state.

## Acceptance criteria

- [x] Memory, Team, Todo, and Attachment can each be disabled independently;
      unavailable APIs and Tools fail closed, while unrelated drivers continue.
- [x] The agent-turn loop consumes generic contributions and contains no
      Memory/Team/Todo/Attachment feature-specific branch.
- [x] Default-on focused Runtime tests preserve turn Context, Tool calls,
      Attachment event order, recovery behavior, and canonical Ledger replay.
- [x] Full Core, CLI vertical E2E, typecheck, architecture/docs/boundary checks
      pass; module graph and current baseline are regenerated.
- [x] Current Runtime documentation and roadmap evidence are updated after
      verification.

## Risks and open questions

- Subagent lifecycle writes Team facts internally to preserve existing G-07
  coordinator recovery and G-08 member projection. Disabling the Team feature
  removes the explicit Team APIs and model Tool, while internal subagent
  bookkeeping remains necessary for active child Runs.
- Plan approval and historical Todo projection remain readable from the
  canonical Ledger; disabling Todo blocks new Todo writes and plan-mode Run
  creation, but does not erase earlier plans.

## Evidence

- Implementation: `packages/core/src/domains/runtime/runtime-feature-drivers.ts`
  and `runtime.ts`; the Runtime option `disabledRuntimeFeatures` controls the
  four built-in drivers. Tests cover independent disablement, missing model
  Tools, API rejection, storage initialization, loop source boundaries, driver
  registration conflicts, and atomic Tool ownership.
- Tests: `pnpm --filter @tracegraph/core test:unit` passed (44 files, 416
  tests); `pnpm test:e2e` passed (4 CLI E2E tests), including Ledger-backed
  Runtime behavior covered by the Core suite.
- Verification: `pnpm typecheck`; `pnpm test:engineering` (47 Node tests and 8
  Vitest tests); `pnpm verify:package-readmes`; `pnpm verify:v2-docs`; generated
  module graph/current baseline checks; and `git diff --check` all passed.
