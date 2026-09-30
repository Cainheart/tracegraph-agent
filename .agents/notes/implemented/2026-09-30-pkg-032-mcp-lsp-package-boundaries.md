---
id: 2026-09-30-pkg-032-mcp-lsp-package-boundaries
title: Extract MCP and LSP providers behind Core-owned ports
status: implemented
owners: [capabilities, core]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [mcp-package, lsp-package, core-ports, package-policy]
supersedes: [2026-09-29-core-021-seams-extraction]
---

# Agent Note: Extract MCP and LSP providers behind Core-owned ports

## Problem

The PKG-032 roadmap promotes the MCP and LSP seams only when each package has a stable contract, a real consumer or hard-isolation reason, public-API contract tests, and no dependency on Core's concrete Runtime. The current stdio clients and managers live in `packages/core/src/seams/{mcp,lsp}`. Their protocol/config contracts already live in `@tracegraph/contracts`, but the managers still import Core Tool definitions, extension lifecycle, result validation, and (for LSP) workspace path helpers. Moving those files directly would preserve an inward dependency on Core.

## Current state

- `@tracegraph/mcp` owns MCP stdio protocol/client and server lifecycle/catalog/call behavior in `packages/mcp/src/`; its contract types live in `@tracegraph/contracts`.
- `@tracegraph/lsp` owns LSP stdio protocol/client, lazy per-project sessions, diagnostics, and semantic locations in `packages/lsp/src/`; its contract types live in `@tracegraph/contracts`.
- Core owns structural Runtime ports and the MCP/LSP Tool adapters under `packages/core/src/seams/{mcp,lsp}/`. Core imports no provider package.
- The CLI directly composes `@tracegraph/mcp` and `@tracegraph/lsp` and injects managers through Core-owned ports.
- Package-root focused tests exercise fixture subprocesses, failure/degraded behavior, bounded results, LSP realpath containment, cancellation, and stop/deactivation.

## Decision

Extract two physical packages, `@tracegraph/mcp` and `@tracegraph/lsp`, each depending only on `@tracegraph/contracts`, `zod`, Node platform APIs, and its own family modules. Their subprocess protocol, process lifecycle, and bounded output form explicit hard-isolation boundaries; configuration/status/event contracts remain shared through `@tracegraph/contracts`.

Core retains Runtime ports and Tool adapters. It consumes structural manager ports and shared contract types without importing either provider package. The CLI remains the composition root and injects the providers. Core-specific dynamic Tool registration and raw-result conversion live outside the provider managers. The LSP provider uses a tested local resolver that rejects absolute paths, traversal, and symlink escapes after realpath.

Focused provider tests exercise each package root. Shared raw Tool-result validation lives in `@tracegraph/contracts`, with Core re-exports retained for its existing Tool implementation. Both packages are in the workspace and `architecture-policy.yaml`; CLI declares the provider dependencies.

This is a behavior-preserving package-boundary change. MCP HTTP/SSE, resources/prompts/PTC, LSP diagnostics redesign or automatic navigation tools, and changes to policy, approval, sandbox authority, event ordering, or persisted formats remain deferred.

## Alternatives considered

- Move the files as-is: rejected because provider packages would import Core Tool and workspace implementation details.
- Keep the managers permanently inside Core: rejected for this task because both families own independent child-process protocols and lifecycle/teardown, and their configuration, status, and event contracts are already explicit.
- Put Tool adapters in the new provider packages: rejected because that would make Core's Tool registry and Runtime integration provider implementation details.

## Invariants and boundaries

- `@tracegraph/mcp` and `@tracegraph/lsp` do not depend on `@tracegraph/core`, Host, CLI, or SDK.
- Core depends only on Core-owned ports and shared contracts; it has no provider-package dependency.
- CLI is the composition root and may depend on both provider packages.
- MCP/LSP process events and canonical Run event ordering remain unchanged; server configuration and secrets stay Host-owned.
- LSP reads only explicit workspace-relative paths after realpath containment. No provider is given Ledger or Tool policy authority.
- Each new package has an explicit root export, contract tests through that root, and managed dependency policy.

## Migration and rollback

Move provider clients, managers, and focused tests into their new package roots. Extract Tool adapters and raw-result conversion to Core-owned files, replace concrete Runtime manager types with narrow ports, and update only the CLI composition imports. There is no persistent-data or configuration migration. Rollback restores the provider files to Core, restores their compatibility exports and imports, and removes the package manifests/policy entries.

## Acceptance criteria

- [x] MCP and LSP providers build with no imports from Core or other apps.
- [x] Core has no dependency/import on `@tracegraph/mcp` or `@tracegraph/lsp`; CLI composes both through Core-owned ports.
- [x] Public package-root contract tests retain failure, degraded, subprocess, bounds, containment, cancellation, and shutdown coverage.
- [x] Core focused tests, CLI vertical e2e, workspace typecheck, boundary/invariant gates, and module-graph checks pass.
- [x] Current MCP/LSP module docs, package READMEs, package policy, roadmap status, and generated module graph agree with the implementation.

## Risks and open questions

- Moving the raw Tool-result schema to `@tracegraph/contracts` must preserve the strict Core output-validation behavior.
- LSP path checks must remain equivalent after removing Core's WorkspaceHandle helper.
- Existing Core-root exports of the provider classes move to the new package roots; callers must import provider implementations from their owning package.

## Evidence

- Implementation: [`@tracegraph/mcp`](../../../packages/mcp/src/index.ts), [`@tracegraph/lsp`](../../../packages/lsp/src/index.ts), Core-owned [MCP ports/adapter](../../../packages/core/src/seams/mcp/) and [LSP ports/adapter](../../../packages/core/src/seams/lsp/), CLI composition in `apps/cli/src/index.ts`, and package policy in `architecture-policy.yaml`.
- Tests: `pnpm test` passed all workspace unit and engineering tests (Core 410, MCP 6, LSP 2; engineering 48 plus coverage checks); `pnpm test:e2e` passed 4 CLI tests; Ledger replay eval passed 1 test; docs consistency eval passed 6 tests.
- Verification: `pnpm typecheck`, `pnpm verify:boundaries` (16 packages, 29 dependencies, 1,400 import references), `pnpm verify:invariants`, `pnpm verify:package-readmes`, `pnpm verify:v2-docs`, `pnpm graph:modules:check`, and `git diff --check` passed. Existing eval metric/report files were restored and their pre-run hashes verified.
