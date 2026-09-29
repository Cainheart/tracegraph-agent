---
id: 2026-09-29-core-023-extension-registration-lifecycle
title: Separate Extension registration contracts from lifecycle management
status: implemented
owners: [extensions]
created: 2026-09-29
last_reviewed: 2026-09-29
affects: [core-extensions, core-kernel, architecture]
supersedes: []
---

# Agent Note: Separate Extension registration contracts from lifecycle management

## Problem

`packages/core/src/extension.ts` currently defines the G-17 registration
contracts and implements extension lifecycle policy, owned registrations,
leases, status projection, timeout handling, and reload rollback in one module.
This makes the stable Extension API depend on the concrete manager and makes
the manager's ownership difficult to see in the Core module graph.

## Current state

- `kernel/registration.ts` owns the shared `Disposable` and the narrower
  Tool-only extension registration port.
- `extension.ts` owns the full `TraceGraphExtension` context contract and the
  `ExtensionManager` implementation.
- Runtime and Tool Registry import the flat `extension.ts` path; package-root
  exports flow through it.
- Lifecycle behavior is covered by `extension.test.ts` and
  `runtime.extension.test.ts`.

## Proposal

Implemented as a move-only refactor under CORE-023.

**Target:** move G-17 registration contracts to
`domains/extensions/registration.ts` and lifecycle implementation/public
manager types to `domains/extensions/manager.ts`. Add a domain barrel and retain
`extension.ts` as a compatibility facade. Runtime should depend on the manager
module, while Tool Registry should depend only on the registration contract.
Keep the shared `Disposable` and Tool-only port in `kernel/registration.ts`;
the full G-17 context includes extension-domain seams such as telemetry and
should not make the foundational kernel depend on those feature contracts.

**Deferred:** changing registration semantics, API version, timeout policy,
activation/deactivation ordering, reload atomicity, Run lease behavior,
trusted in-process execution, or public package-root names; opening arbitrary
module loading or sandbox claims; creating a new workspace package.

## Alternatives considered

- Put the entire G-17 context in `kernel/registration.ts`: rejected because
  the context includes extension-domain capabilities and would pull their
  contracts into the foundational kernel.
- Move the implementation and remove `extension.ts`: rejected because the
  root export and existing direct-source imports are established compatibility
  paths.

## Invariants and boundaries

- `domains/extensions/registration.ts` owns stable G-17 registration contracts;
  `domains/extensions/manager.ts` owns lifecycle state and mutation policy.
- `kernel/registration.ts` remains free of imports into `domains/` and `seams/`.
- `register`, `dispose`, `deactivate`, and `reload` observable behavior stays
  unchanged, including LIFO cleanup, timeout/error isolation, idle-only
  mutation, rollback, and Run lease snapshots.
- The package-root and old `extension.ts` import surface remain compatible.
- No persisted schema, Event format, or module-loading authority changes.

## Migration and rollback

Move the existing declarations/implementation, update internal relative imports,
and keep `extension.ts` as an explicit re-export facade. Roll back by restoring
the implementation and contracts to the flat module and deleting the new
domain files; no persisted data or configuration migration is required.

## Acceptance criteria

- [x] Registration contracts and manager lifecycle have separate source owners.
- [x] Existing direct imports and package-root exports remain compatible.
- [x] Focused lifecycle and Runtime-extension behavior tests pass unchanged.
- [x] Build/typecheck, architecture gates, module graph, and owning docs agree.
- [x] `register`, `dispose`, `deactivate`, reload success, and reload rollback
      behavior remain covered and unchanged.

## Risks and open questions

- Public declaration emit must preserve the existing type surface through the
  compatibility facade while allowing the manager module to import contracts
  without a runtime cycle.
- Current source-level callers may rely on unexported implementation paths;
  the selected domain paths must remain internal and kernel dependencies inward.

## Evidence

- Implementation: [`registration.ts`](../../../packages/core/src/domains/extensions/registration.ts), [`manager.ts`](../../../packages/core/src/domains/extensions/manager.ts), [`index.ts`](../../../packages/core/src/domains/extensions/index.ts), and the compatibility facade at [`extension.ts`](../../../packages/core/src/extension.ts).
- Tests: `extension.test.ts`, `runtime.extension.test.ts`, and `seams/mcp/mcp.test.ts` passed: 3 files, 24 tests. Tests cover partial-registration rollback, idempotent disposer behavior, deactivation cleanup, successful reload replacement, reload rollback, lease/mutation races, and Runtime-facing extension behavior through the compatibility path.
- Verification: `pnpm typecheck`; `pnpm test:engineering` (47 Node tests and 8 Vitest tests); `pnpm verify:boundaries` (12 packages, 20 workspace dependencies, 1,305 import references); `pnpm verify:v2-docs`; `pnpm verify:invariants`; `pnpm verify:package-readmes`; `pnpm graph:modules:check`; `pnpm baseline:current:check`; and `git diff --check` passed. `pnpm baseline:current` refreshed the structural baseline, its G16 performance eval passed 3/3, and the generator restored its snapshotted eval diagnostics.
