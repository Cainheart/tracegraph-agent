---
id: 2026-09-29-core-021-seams-extraction
title: Move sandbox, LSP, and MCP adapters behind Core seams
status: implemented
owners: [core]
created: 2026-09-29
last_reviewed: 2026-09-29
affects: [core-seams, core-kernel]
supersedes: []
---

# Agent Note: Move sandbox, LSP, and MCP adapters behind Core seams

## Problem

Core's platform and protocol adapters live at the source root (`sandbox/`,
`lsp/`, and `mcp/`). LSP and MCP managers also import the tool-registry output
schema and extension lifecycle types, so merely moving the directories would
leave implementation seams coupled inward to Core orchestration.

## Current state at task start

- Sandbox runner contracts already live in `kernel/registration.ts`; sandbox
  implementations depend on those contracts and `@tracegraph/contracts`.
- LSP and MCP clients/managers are exported from the package root, but their
  implementations live in `src/lsp/` and `src/mcp/`.
- Both managers import `RawToolResultSchema` from `tool-registry.ts` and
  `Disposable`/`TraceGraphExtension` from `extension.ts`.
- Runtime and built-in tool composition import the managers from those
  implementation directories; root package consumers use wildcard exports.

## Proposal

- Move sandbox, LSP, and MCP implementation modules under `src/seams/`, keeping
  their names and runtime behavior unchanged.
- Move the shared RawToolResult validation schema into a kernel-owned module
  and keep the current `tool-registry.ts` re-export for compatibility.
- Define the narrow Tool extension/disposal ports used by LSP and MCP in
  `kernel/registration.ts`; keep the full extension lifecycle manager in its
  existing owner for the separate `CORE-023` task.
- Preserve package-root public names by redirecting existing root exports to
  the new seam paths.

## Decision

Accepted and implemented as the behavior-preserving P2 seam extraction. The
LSP/MCP adapters now depend on kernel-owned Tool/result/extension ports, while
the full ExtensionManager lifecycle remains in its existing owner for
`CORE-023`.

## Alternatives considered

- Move directories without removing inward imports: rejected because seam
  implementations would still depend on Core orchestration.
- Move the full extension lifecycle implementation into `kernel/`: rejected
  because it owns runtime registration and is explicitly separated by
  `CORE-023`.
- Promote sandbox, LSP, or MCP to physical packages: deferred until the
  repository's package-promotion evidence is satisfied.

## Invariants and boundaries

- No tool behavior, canonical Event shape/order, public export name, or
  persisted format changes.
- Seam implementations may depend on kernel/contracts, platform libraries,
  and collaborating modules within their own seam family; they must not import
  Core Runtime, tool-registry, extension lifecycle, or domain implementations.
- `packages/core/src/index.ts` remains the compatibility boundary.
- No new package is introduced and no capability is added.

## Migration and rollback

Move the three adapter directories and their focused tests, rewrite internal
imports, and redirect the package-root exports. To roll back, restore the
original source paths and import specifiers; there is no persisted-data or
configuration migration.

## Acceptance criteria

- [x] Sandbox, LSP, and MCP sources live under `src/seams/`.
- [x] Production cross-layer imports from seams resolve only to kernel/contracts and
      declared platform libraries; intra-seam collaboration stays local.
- [x] Existing package-root export names and canonical Event contracts remain
      unchanged.
- [x] Core build/typecheck and existing focused, CLI vertical e2e, and Ledger
      replay checks show no unexpected behavior changes.
- [x] Current Core docs and generated module graph point to the new source paths.

## Risks and open questions

- Structural extension ports must remain assignable to the existing
  `TraceGraphExtension` API without changing extension manager behavior.
- The `RawToolResultSchema` move must preserve its strict validation behavior
  and the tool-registry's package-root export.

## Evidence

- Implementation: [`packages/core/src/seams/`](../../../packages/core/src/seams/),
  kernel-owned tool-result schema and extension ports, and compatibility exports
  in [`packages/core/src/index.ts`](../../../packages/core/src/index.ts).
- Focused tests: [`sandbox.test.ts`](../../../packages/core/src/seams/sandbox/sandbox.test.ts),
  [`lsp.test.ts`](../../../packages/core/src/seams/lsp/lsp.test.ts),
  [`mcp.test.ts`](../../../packages/core/src/seams/mcp/mcp.test.ts),
  Runtime integration suites, and [CLI e2e](../../../apps/cli/src/e2e.test.ts).
  The focused Core run passed across 9 files and 71 tests
  (`sandbox`, `process`, LSP, MCP, Runtime code-intel, extension, permission,
  recovery, and session). `pnpm test:e2e` passed 1 CLI file and 4 tests.
- Ledger replay eval: [`time-travel.eval.ts`](../../../evals/replay/time-travel.eval.ts)
  passed 1 test using `pnpm exec vitest run --config vitest.evals.config.ts
  evals/replay/time-travel.eval.ts`.
- Current documentation: [Runtime](../../../docs/modules/02-Agent-Runtime.md),
  [Tools and sandbox](../../../docs/modules/04-工具与策略审批.md),
  [MCP](../../../docs/modules/18-MCP客户端.md), and
  [LSP](../../../docs/modules/19-LSP客户端.md).
- Verification: Core build and test-source typecheck passed. `graph:modules`,
  `graph:modules:check`, `verify:v2-docs`, `verify:package-readmes`,
  `verify:boundaries`, `verify:invariants`, and `git diff --check` passed.
  The pre-existing `_tmp_evals/metrics` files and eval report directory were
  restored; all eight metric-file hashes match their pre-eval values.
