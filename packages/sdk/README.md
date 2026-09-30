# @tracegraph/sdk

Typed client for the local TraceGraph Host API. See [module 09](../../docs/modules/09-Host-与-SDK-接口层.md).

## Purpose

Give CLI/Web consumers a schema-checked HTTP and SSE client for Host operations, Run and Session projections, Memory control commands and queries, and live/model-surface streams.

## Public API

The package root exports `TraceGraphClient`, `TraceGraphHttpError`, client/stream options, response types, and SSE parsing. The client includes the shared Memory list/create/review/correct/revoke/delete routes and validates their contracts. The manifest exposes the root entry only.

## Dependencies

It depends on `@tracegraph/contracts` for request/response schemas and shared types.

## State ownership

The SDK is a transport client; it does not own canonical Run or Session state. Any local stream cursor or request state is transient and must be reconciled against Host projections.

## Extension points

The client options supply the base URL and fetch/transport behavior. Consumers can use the exported client interface shape to provide test doubles while preserving the shared contracts.

## Model effect

The SDK does not call a model. It sends user commands to Host and transports model-produced facts and public model-surface events back to the UI.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/sdk test:unit` from the repository root.

## Known limitations

It requires a compatible Host and does not turn request success into proof of completed Runtime work. Callers should reread canonical state after timeouts or connection loss; unsupported Host features remain explicit errors.
