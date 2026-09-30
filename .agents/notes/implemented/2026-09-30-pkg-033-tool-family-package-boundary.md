---
id: 2026-09-30-pkg-033-tool-family-package-boundary
title: Extract the Tool enforcement kernel behind a narrow package API
status: implemented
owners: [tool, core]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [tool-package, core-tool-composition, tool-policy, approval]
supersedes: []
---

# Agent Note: Extract the Tool enforcement kernel behind a narrow package API

## Problem

PKG-033 promotes the Tool family only if its physical boundary is stable and has a second real consumer or a hard isolation reason, with contract tests. CORE-022 already separated Tool contracts, Registry, the sole executor, Policy Engine, and Approval Token Store into logical modules, but they still depend on Core-local contracts and utilities. The 20 built-in Tool implementations share the registry file and depend on Core Workspace, Sandbox, Artifact, Todo, Team, Skill, and Subagent capabilities. Moving that file as-is would pull Core Runtime and domain implementations into the proposed package.

## Current state

- `packages/core/src/kernel/tool/definition.ts` owns the Tool contract and the large Host-provided execution context.
- `packages/core/src/domains/tools/` owns Registry mechanics, built-in Tool construction, call validation, output bounding, Executor, Policy Engine, and one-shot Approval Token Store.
- `packages/core/src/domains/runtime/` is the enforcement coordinator. It evaluates policy and final approval bindings before Tool dispatch and before Action WAL or workspace mutation.
- The CLI composition root uses Core's trusted Tool Registry. Runtime and ExtensionManager are collaborators on that same in-process path, not independent package consumers counted toward the promotion gate.
- CORE-022 and current Core tests cover contract, policy, approval, and output behavior. The final-denial regression test asserts no Tool start, WAL, or mutation follows a denial.

## Proposal

Promote the generic Tool enforcement mechanisms as `@tracegraph/tool`: Tool definition and execution-context contracts, generic Registry and call-validation mechanics, the single bounded Executor, Policy Engine, Approval Token Store, and their generic utilities. The package may depend on `@tracegraph/contracts`, `zod`, and Node platform APIs, but not on Core or an app.

Keep Core-specific built-in Tool implementations, built-in Registry composition, ExtensionManager integration, Runtime orchestration, Action WAL, and Workspace/Sandbox providers in `@tracegraph/core`. Core adapts its providers into the public `@tracegraph/tool` contracts. Preserve existing Core package-root and source compatibility exports where callers rely on them; production ownership and tests move to the Tool package root.

The promotion gate is the side-effect enforcement boundary: a managed dependency rule must prevent the generic executor/policy package from importing Core orchestration or bypassing contracts. This is the explicit hard-isolation reason; the proposal does not claim a second independent product consumer.

Behavior is move-only. Policy denial, approval binding, action digest, dispatch, Action WAL, cancellation shield, mutation, Receipt/Observation, and event ordering must remain unchanged. Denials must still happen before dispatch, WAL intent, and mutation. Receipt/Observation mapping and Core-native tool implementations remain deferred.

## Alternatives considered

- Move `domains/tools/registry.ts` intact: rejected because it constructs built-in Tools by importing Core Workspace, Sandbox, and multiple Core domains.
- Promote only Tool type declarations: rejected because it would leave the security-critical Executor/Policy/Approval enforcement path in an unmanaged compatibility layer.
- Move Runtime/WAL or built-in domain behavior into the package: rejected because those are Core-owned authorities/providers and would make the Tool package depend inward on Core.

## Invariants and boundaries

- `@tracegraph/tool` has one explicit package-root API and no imports from `@tracegraph/core`, apps, Host, or provider implementations.
- Core remains the composition/authority owner for built-in Tool implementations, Run policy snapshot, Action WAL, Workspace, Sandbox, and Event Ledger integration.
- There is exactly one production `executeToolDefinition()` implementation. Every Runtime Tool call continues to pass through it.
- Policy/Approval denial remains before dispatch, WAL intent, and mutation. A package boundary cannot add an alternate execution path.
- Tool contracts and results remain bounded and schema validated. Persisted schema, public Event data, Tool inventory, and output semantics do not change.
- Contract tests import `@tracegraph/tool` through its package root; Core integration tests continue to exercise real composition and denial ordering.

## Migration and rollback

Move generic Tool contracts and enforcement modules into `packages/tool`, split generic Registry mechanics from Core built-in definitions, then update Core to depend on the public package root. Keep narrow Core compatibility re-exports only where they preserve existing consumer paths. Add the package to workspace manifests, `architecture-policy.yaml`, lockfile, generated module graph, and README contracts. Rollback restores generic modules to Core and removes the new package and policy entry; no persisted data or configuration migration is required.

## Acceptance criteria

- [x] `@tracegraph/tool` builds with no Core/app imports and exposes only its declared root API.
- [x] Core consumes the Tool package; Core-specific built-ins and Runtime/Extension composition remain in Core.
- [x] Package-root contract tests cover schema validation, output bounds, cancellation/timeout, deny/approval token failure, and Registry behavior.
- [x] Core integration proves final denial occurs before Tool dispatch, Action WAL intent, and workspace mutation; exactly one executor remains.
- [x] Workspace typecheck, unit/integration tests, boundary/invariant gates, package README, roadmap, and module-graph checks pass.
- [x] Current Tool docs identify package ownership and preserve stated deferred boundaries.

## Risks and open questions

- `ToolExecutionContext` currently groups several Host/Core-owned bridges. Its public shape must remain structural and must not transfer Workspace, WAL, Ledger, or Approval authority to the package.
- Canonical digest/stringification must not fork from the Core helpers or change persisted action/policy digests.
- The Core compatibility surface must not leave a second Registry or Executor implementation.

## Evidence

- Implementation: `packages/tool/src/index.ts` is the sole package API. Definition, generic Registry/call validation, bounded Executor, Policy Engine, one-shot Approval Token Store, output limits, crypto helpers, and sandbox ports now live under `packages/tool/src/`. Core's former source paths are thin package-root re-exports; Core retains built-in Tool construction/composition, Runtime, ExtensionManager, effective Run policy, Workspace/Sandbox authority, Action WAL, Receipt/Observation, and Ledger integration. Canonical `sha256`, `stableStringify`, and ID creation use the same package implementation through Core's crypto compatibility export.
- Tests: package-root suite covers model schema projection, reversible Registry registration, input-schema and approval denials, bounded output, cancellation, and timeout; the moved Policy and Approval tests import `./index.js`. Core's `runtime.permission.test.ts` final-denial case proves no `tool.started`, WAL intent, or file mutation occurs after the last hard deny. A source search found exactly one production `ToolRegistry` and one production `executeToolDefinition()` implementation.
- Verification: `pnpm typecheck`; `pnpm test` (Tool 24 tests, Core 390 tests, engineering gates 48 Node tests + 8 coverage-gate tests); `pnpm test:e2e` (4 CLI E2E tests); focused Runtime permission suite (13 tests); `pnpm verify:boundaries` (17 packages / 31 workspace edges / 1,431 import references); `pnpm verify:invariants`; `pnpm verify:package-readmes`; `pnpm verify:v2-docs` (11 documents / 62 tasks); `pnpm graph:modules:check`; `pnpm baseline:current:check`; lockfile verification; six implementation-consistency evals; `git diff --check`.
