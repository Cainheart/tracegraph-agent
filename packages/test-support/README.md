# @tracegraph/test-support

Reusable test fixtures and deterministic provider helpers for TraceGraph. Current evaluation boundaries are described in [module 12](../../docs/modules/12-评测体系.md).

## Purpose

Create controlled fixture workspaces and temporary data directories, provide deterministic IDs and fake model/provider implementations, and exercise cross-package Runtime behavior.

## Public API

The package root exports fixture path/helpers, `createSequentialIdFactory`, temporary-data helpers, and the mock-provider module. It is intended for repository tests, not runtime application composition.

## Dependencies

It depends on `@tracegraph/contracts`, `@tracegraph/core`, and Zod so fixtures can exercise the same Runtime contracts as production code.

## State ownership

Helpers create temporary test state and provide cleanup functions. Durable state produced during a test belongs to its temporary fixture directory and must not be treated as product data.

## Extension points

Tests can compose the exported fixture helpers with Core provider seams, adding bounded deterministic fixtures when a new invariant needs executable evidence.

## Model effect

The fake providers do not contact real model endpoints. Their controlled responses influence test Runtime decisions only; a fixture pass does not establish real-provider quality or production behavior.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/test-support test:unit` from the repository root.

## Known limitations

Coverage is limited to explicit fixtures and injected fakes. These helpers do not validate arbitrary external systems, real model quality, or production deployment conditions.
