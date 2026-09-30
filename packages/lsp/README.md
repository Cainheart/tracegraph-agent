# `@tracegraph/lsp`

## Purpose

Host-side stdio Language Server client and per-project lifecycle manager. It exposes bounded diagnostics, semantic locations, status, and provider events without registering Core Tools or selecting policy.

## Public API

[`src/index.ts`](src/index.ts) exports the LSP client, manager, and their public types. Core adapts the manager through [`packages/core/src/seams/lsp/ports.ts`](../core/src/seams/lsp/ports.ts) and [`tool-extension.ts`](../core/src/seams/lsp/tool-extension.ts); the CLI composes both packages.

## Dependencies

Runtime dependencies are `@tracegraph/contracts`, `zod`, and Node platform APIs. No Core, Host, SDK, or other provider package is imported.

## State ownership

`LspManager` owns process-local server/session lifecycle, bounded diagnostic caches, and event history. The Host supplies server configuration and process environment. Workspace paths are resolved and checked for realpath containment before reads.

## Extension points

Callers can inject `clientFactory`, clock, environment, and working directory through `LspManagerOptions`. The Core-owned adapter exposes the supported diagnostics Tool and stops the provider during extension deactivation.

## Model effect

This package has no model client or prompt policy. Diagnostics reach the model only through an explicitly invoked Core Tool and its normal policy path.

## Verification

Run `pnpm --filter @tracegraph/lsp build`, `pnpm --filter @tracegraph/lsp typecheck`, and `pnpm --filter @tracegraph/lsp test:unit`. Tests import the package root barrel and use a fixture language server.

## Known limitations

Only stdio transport and explicit diagnostics/definition/references requests are implemented. There is no remote registry, complete workspace index, automatic Context injection, or PTC. The provider receives only explicit workspace-relative paths and has no Ledger or policy authority.
