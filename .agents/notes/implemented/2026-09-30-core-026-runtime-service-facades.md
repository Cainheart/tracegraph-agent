---
id: 2026-09-30-core-026-runtime-service-facades
title: Route Runtime through Context, Tool, and Evidence façades
status: implemented
owners: [runtime]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [core-runtime, context, tools, evidence, architecture]
supersedes: []
---

# Agent Note: Route Runtime through Context, Tool, and Evidence façades

## Problem

`domains/runtime/runtime.ts` imports Runtime dependencies directly from
Context, Tool, and Evidence implementation files. This couples the coordinator
to file layout and makes domain integration surfaces implicit. CORE-026 calls
for explicit service façades while preserving the current execution behavior.

## Current state

- CORE-025 has extracted pure Run/Turn/Step transition decisions. Its changes
  are present in the working tree and remain uncommitted.
- Runtime now imports Context, Tool, and Evidence through their curated
  `runtime-service.ts` modules; a Runtime source test rejects direct imports
  from those domains' implementation files.
- The façades re-export only the symbols consumed by Runtime. The classes,
  functions, event operations, and module implementations stay in their
  existing owners.
- Domain implementation files are internal to `@tracegraph/core`; the package
  root `src/index.ts` remains the external public API.
- The canonical Event Ledger remains the source of durable Run facts.

## Implemented decision

- **Target delivered:** `context/runtime-service.ts`,
  `tools/runtime-service.ts`, and `evidence/runtime-service.ts` export the
  symbols Runtime consumed before extraction. `runtime.ts` uses those three
  entrypoints; a source-level test enforces that dependency boundary.
- Implementations, package-root exports, constructors, method calls,
  persistence ownership, and append/projection order are unchanged.
- **Deferred:** turning the façades into new service objects, moving behavior
  out of implementation files, changing Runtime dependency injection, adding
  physical packages, and extracting feature drivers or the main loop.

## Alternatives considered

- Create broad domain `index.ts` barrels: rejected for this slice because they
  would make unrelated implementation exports look like a general domain API.
- Move the implementations into Runtime or compose new service objects: not
  selected because CORE-026 is a behavior-preserving boundary extraction and
  those changes would widen the responsibility/constructor migration.

## Invariants and boundaries

- Runtime imports Context/Tool/Evidence through one explicit façade per domain;
  facades expose only the Runtime integration symbols.
- Facades are internal Core modules, not new `@tracegraph/core` package-root
  exports and not new workspace packages.
- The Event Ledger remains the only durable Run fact source. No event schema,
  data format, idempotency key, status projection, or event ordering changes.
- Tool validation, policy, approval, execution, and reconciliation remain in
  their current owners with the same call order.
- Existing `CORE-025` work and all unrelated user changes remain intact.

## Migration and rollback

Add the three curated export modules and rewrite only Runtime's imports from
the named domains. Rollback removes these modules and restores the prior import
specifiers; no data or external API migration is needed.

## Acceptance criteria

- [x] Runtime imports Context/Tool/Evidence only through the three façades; a
      regression test rejects deep implementation imports.
- [x] Façades export exactly the symbols Runtime consumes; no package-root
      exports are added.
- [x] Core focused/full tests, Ledger replay coverage, and CLI vertical E2E
      preserve behavior, including failure, cancellation, recovery, and event
      order.
- [x] Full typecheck and relevant engineering, boundary, invariant, docs,
      module-graph, and current-baseline checks pass.
- [x] Current Runtime docs and roadmap evidence are updated after verification.

## Risks and open questions

- Re-export-only façades make the dependency boundary explicit but do not yet
  reduce Runtime's orchestration responsibilities. CORE-028 remains responsible
  for that reduction.
- Export lists must stay curated so implementation helpers do not become an
  accidental domain API.

## Evidence

- Implementation: the three domain `runtime-service.ts` façades; Runtime
  imports routed through them; source-boundary regression test; module and
  roadmap docs updated. No package-root exports or behavior changes.
- Tests: Core unit suite passed (42 files, 403 tests), including Ledger replay,
  Runtime recovery, cancellation, plan, and steering cases; CLI vertical E2E
  passed (4 tests).
- Verification: full workspace `pnpm typecheck`; `pnpm test:engineering` (47
  Node tests and 8 Vitest tests); invariants (168 source files); boundaries (12
  packages, 20 workspace dependencies, 1,313 import references); package README
  contracts; V2 docs; generated module graph and current baseline checks; and
  `git diff --check`.
