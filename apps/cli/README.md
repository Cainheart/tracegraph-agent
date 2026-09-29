# @tracegraph/cli

This is the TraceGraph command-line entry point and local composition root. The current implementation is documented in [module 11](../../docs/modules/11-CLI-与装配.md).

## Purpose

Start and configure the local TraceGraph Host, compose the Runtime with model, workspace, retrieval, telemetry, and other providers, and expose the supported `tracegraph` commands.

## Public API

The package exposes the `tracegraph` executable through `apps/cli/package.json`; it is an application entry point, not a reusable TypeScript library. Current commands include `serve`, `extensions`, `team`, `skills`, and `mcp`.

## Dependencies

The composition uses `@tracegraph/core`, `@tracegraph/contracts`, `@tracegraph/host`, `@tracegraph/sdk`, `@tracegraph/codegraph`, `@tracegraph/retrieval`, `@tracegraph/retrieval-service`, `@tracegraph/telemetry`, and `@tracegraph/test-support`.

## State ownership

The CLI selects local data/configuration paths and constructs their stores. Canonical Run and Session facts remain in Core's Ledger and Session stores; retrieval indexes and Telemetry queues are separate projections with their own lifecycles.

## Extension points

`apps/cli/src/composition.ts` is the standard composition seam. Provider implementations are passed into Runtime there; adding a provider or configuration source requires an explicit composition change.

## Model effect

The CLI resolves model configuration and credentials and passes the selected adapter into Runtime. That selection affects the provider used for model requests; model decisions, tool policy, and durable outcomes are owned by Core.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/cli test:unit` from the repository root. The unit command excludes the separately named end-to-end test.

## Known limitations

The CLI is a local Host launcher and has a deliberately narrow command surface. Startup-resolved environment settings require a Host restart to change, and remote Retrieval does not make the Runtime or Workspace remote.
