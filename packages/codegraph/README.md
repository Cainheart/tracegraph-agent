# @tracegraph/codegraph

Current implementation of bounded static TypeScript code analysis. The source-grounded behavior and limits are in [module 07](../../docs/modules/07-CodeGraph-代码图.md).

## Purpose

Read a workspace to produce static file/import/export and top-level symbol graph facts, with snapshot diff and bounded impact-neighborhood helpers.

## Public API

The package root exports `analyzeCodeGraph`, `CodeGraphAnalysisError`, `diffGraphSnapshots`, `getImpactNeighborhood`, and their option/result types. Package deep imports are not part of the declared export surface.

## Dependencies

It depends on `@tracegraph/contracts` for graph and CodeIntel schemas and on TypeScript for AST analysis.

## State ownership

Analysis is request-scoped and reads the selected workspace. The package does not own a persistent index or canonical Run facts; Runtime/Host own the surrounding event and projection state.

## Extension points

The `CodeGraphProvider` seam lets Runtime request snapshots and deltas. CLI composition supplies the current provider; Host and Web consume the resulting canonical facts rather than constructing scanners.

## Model effect

CodeGraph does not call a model. When explicitly composed, its bounded facts can contribute to Runtime context and CodeIntel projections, and therefore influence model input indirectly.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/codegraph test:unit` from the repository root.

## Known limitations

This is a current TraceGraph implementation, not an Outlive V2 built-in capability. It has no incremental cache and does not resolve method-level or dynamic calls, dependency injection, routes, reflection, or cross-language semantics; configured file/byte limits reject oversized analysis.
