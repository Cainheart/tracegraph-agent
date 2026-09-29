---
id: 2026-09-29-core-022-tool-definition-executor-policy-split
title: Separate Tool contracts from Core Tool execution and policy ownership
status: implemented
owners: [tool]
created: 2026-09-29
last_reviewed: 2026-09-29
affects: [core-kernel, core-tools, architecture]
supersedes: []
---

# Agent Note: Separate Tool contracts from Core Tool execution and policy ownership

## Problem

Tool contracts currently live in `kernel/types.ts`, while the flat
`tool-registry.ts` owns Tool schemas, definitions, registry composition,
validation, and the single execution boundary. Policy evaluation and approval
token storage are also flat Core modules. This leaves the kernel importing a
sandbox implementation type and obscures the ownership boundary between a
stable Tool contract and its executable/policy implementation.

## Current state

- `ToolDefinition`, `ToolExecutionContext`, and Tool bridge contracts are
  exported from `kernel/types.ts`.
- `tool-registry.ts` owns the built-in Tool set, extension contributions,
  validation, `executeToolDefinition()`, and the output contract boundary.
- `policy-engine.ts` and `approval-token-store.ts` own policy evaluation and
  one-time approval token behavior.
- Package-root and in-repository imports use the flat source paths; Core's
  documented Tool behavior and G-20 source evidence point at those paths.

## Decision

Move the Tool contract types into `kernel/tool/definition.ts`, with a local
barrel, and make `kernel/types.ts` re-export those types to retain current
imports. Move the registry, the one `executeToolDefinition()` implementation,
Policy Engine, and Approval Token Store into `domains/tools/`. Leave their old
flat source paths as thin re-export facades so package-root and direct-source
callers keep their current names and behavior. Keep built-in Tools, policy
decisions, approval binding, cancellation, result validation, and output
bounding unchanged.

Accepted and implemented as a move-only CORE-022 refactor. `kernel/tool/` owns Tool contracts; `domains/tools/` owns Tool
definitions/composition, registry, executor, Policy Engine, and approval-token
implementation.

Deferred: changing Tool semantics or inventory; changing policy or approval
rules; moving Runtime orchestration, Extension lifecycle, Todo, or Sandbox
implementations; promoting a physical package.

## Alternatives considered

- Move implementation files without compatibility facades: rejected because
  the package-root exports and direct source imports are established caller
  paths.
- Keep the registry and executor together: rejected because CORE-022 explicitly
  separates the Tool definition/registry boundary from its unique execution
  boundary.
- Move Tool contracts into `domains/tools/`: rejected because other kernel
  ports and Runtime-facing types need a stable contract without importing a
  domain implementation.

## Invariants and boundaries

- Exactly one `executeToolDefinition()` implementation remains, and every
  Runtime Tool invocation continues through it.
- No Tool is added or removed; no input/output contract, policy, approval,
  timeout, cancellation, or side-effect behavior changes.
- `@tracegraph/core` root exports and the existing flat source import names
  remain compatible through facades.
- `kernel/` may depend on contracts and sibling kernel ports; it must not
  import `domains/` or `seams/` implementations.
- `domains/tools/` may depend on kernel contracts/ports and existing Core
  collaborators needed by Tool composition; it must not create a second
  execution path.

## Migration and rollback

Move the implementation modules, adjust only relative imports, and replace
their original files with re-export facades. Update current-source docs and
implementation-consistency evidence after the code locations are verified.
Rollback restores the implementation files to their original paths and
removes the new facades/directories; no persisted data or configuration
migration is required.

## Acceptance criteria

- [x] Tool contract types live under `kernel/tool/` and old type imports remain
      valid.
- [x] Registry, executor, Policy Engine, and approval implementation live under
      `domains/tools/`; old module paths remain compatible.
- [x] Exactly one executor implementation and unchanged built-in inventory are
      structurally verified.
- [x] Monorepo build/typecheck and required repository gates pass; existing
      behavior suites remain available and their test sources typecheck.
- [x] Current Core docs and generated module graph identify the new owners.

## Risks and open questions

- `ToolExecutionContext` references a SandboxRunner port. The moved Tool
  contract must retain a type-only dependency on the kernel registration port
  so this move does not create a runtime cycle or import a Sandbox
  implementation.
- Current source-level consumers may rely on non-package-root paths; the
  compatibility facades must preserve all exported values and types.

## Evidence

- Implementation: [`kernel/tool/`](../../../packages/core/src/kernel/tool/),
  [`domains/tools/`](../../../packages/core/src/domains/tools/), and compatibility
  facades at the former flat paths.
- Tests: [Tool Registry](../../../packages/core/src/tool-registry.test.ts),
  [Policy Engine](../../../packages/core/src/policy-engine.test.ts),
  [Approval Token Store](../../../packages/core/src/approval-token-store.test.ts),
  [Runtime permissions](../../../packages/core/src/runtime.permission.test.ts),
  [Plan Mode](../../../packages/core/src/runtime.plan-mode.test.ts),
  [Runtime extensions](../../../packages/core/src/runtime.extension.test.ts),
  [Extension lifecycle](../../../packages/core/src/extension.test.ts),
  [Todo tools](../../../packages/core/src/todo.test.ts),
  [Skill tools](../../../packages/core/src/skill.test.ts), and
  [process boundary](../../../packages/core/src/process.test.ts) suites passed
  in a focused run: 13 files, 121 tests. The baseline generator also ran its
  G16 performance eval (3/3 passed) and restores the snapshotted metrics/report
  in a `finally` block.
- Verification: `pnpm typecheck`, `pnpm verify:boundaries`,
  `pnpm verify:v2-docs`, `pnpm verify:package-readmes`,
  `pnpm verify:invariants`, `pnpm graph:modules:check`, and `git diff --check`
  passed. `pnpm baseline:current` refreshed the structural inventory after the
  source move, and `pnpm baseline:current:check` confirmed it matches.
