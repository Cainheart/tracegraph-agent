# `@tracegraph/mcp`

## Purpose

Host-side MCP stdio client and process-lifecycle manager. It validates MCP configuration and exposes bounded tool catalogs, results, status, and provider events. It does not register Core Tools or decide policy and approval.

## Public API

[`src/index.ts`](src/index.ts) exports the MCP client, manager, and their public types. Core adapts the manager through [`packages/core/src/seams/mcp/ports.ts`](../core/src/seams/mcp/ports.ts) and [`tool-extension.ts`](../core/src/seams/mcp/tool-extension.ts); the CLI composes both packages.

## Dependencies

Runtime dependencies are `@tracegraph/contracts`, `zod`, and Node platform APIs. No Core, Host, SDK, or other provider package is imported.

## State ownership

`McpManager` owns process-local server lifecycle, bounded status/catalog data, and event history. Host configuration, environment, and secret resolution remain supplied by the composition root; secret values are not returned in status or events.

## Extension points

Callers can inject `clientFactory`, `resolveSecret`, clock, environment, working directory, and bounded timeouts through `McpManagerOptions`. The Core-owned adapter maps discovered tools to the Core Tool registry.

## Model effect

This package has no model client or prompt policy. MCP tools become model-callable only after the Core Tool and policy path registers them.

## Verification

Run `pnpm --filter @tracegraph/mcp build`, `pnpm --filter @tracegraph/mcp typecheck`, and `pnpm --filter @tracegraph/mcp test:unit`. Tests import the package root barrel and use fixture subprocesses for protocol behavior.

## Known limitations

Only stdio transport is implemented. HTTP/SSE, resources, prompts, instructions, and PTC are deferred. This package does not grant workspace access or tool-policy authority.
