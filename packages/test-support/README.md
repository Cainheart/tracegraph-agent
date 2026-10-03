# @tracegraph/test-support

Reusable test fixtures and deterministic provider helpers for TraceGraph. Current evaluation boundaries are described in [module 12](../../docs/modules/12-评测体系.md).

## Purpose

Create controlled fixture workspaces and temporary data directories, provide deterministic IDs and fake model/provider implementations, and exercise cross-package Runtime behavior.

## Public API

The package root exports fixture path/helpers, `createSequentialIdFactory`, temporary-data helpers, the mock-provider module, and the recorded-session schemas/runner. It is intended for repository tests, not runtime application composition.

## Dependencies

It depends on `@tracegraph/contracts`, `@tracegraph/core`, and Zod so fixtures can exercise the same Runtime contracts as production code.

## State ownership

Helpers create temporary test state and provide cleanup functions. Durable state produced during a test belongs to its temporary fixture directory and must not be treated as product data.

## Extension points

Tests can compose the exported fixture helpers with Core provider seams, adding bounded deterministic fixtures when a new invariant needs executable evidence.

Recorded-session cases live under the repository-level `snapshots/` directory. Run `pnpm run build` before `pnpm run test:snapshots` to replay the accepted completion, recovery, cancellation, Memory recall, and subagent cases. `replay` is read-only and uses only the checked-in model script; `record --case <profile/scenario> --source <capture.json> --write` imports a supported offline capture into the ignored `snapshots/candidates/` review area and never replaces a case. Capture import currently supports `minimal-completion`; the four SNAP-071 cases use bounded synthetic scripts. `refresh --case <profile/scenario>` prints event and workspace-manifest diffs; pass `--write` only after review to replace `expected.json`.

## Model effect

The fake providers do not contact real model endpoints. Snapshot replay does not read provider credentials. Record/refresh scan strict bounded fixtures for credential fields, common token patterns, private-key blocks, and personal absolute paths before writing; candidates still require human review before promotion. A fixture pass does not establish real-provider quality or production behavior.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/test-support test:unit` from the repository root. The package unit suite includes an isolated keyless child-process replay of the minimal accepted fixture and direct replays for all four SNAP-071 cases; root `pnpm test` replays all accepted cases immediately after build, before recursive package tests.

## Known limitations

Coverage is limited to explicit fixtures and injected fakes. SNAP-071 covers interrupted approval recovery with one approved synthetic patch, user cancellation of a blocked model request, reviewed V2 Memory recall, and one readonly subagent. Accepted scenarios compare semantic Run events and sorted workspace path/content digests; they do not cover live-session export, real model quality, OS-level crash injection, arbitrary workspace mutation replay beyond that synthetic patch, UI rendering, arbitrary external systems, or production deployment conditions.
