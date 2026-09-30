# @tracegraph/host

Local HTTP/SSE transport around a composed TraceGraph Runtime. See [module 09](../../docs/modules/09-Host-与-SDK-接口层.md) for route and trust-boundary details.

## Purpose

Expose Host-owned project, Session, Run, artifact, Memory control, command, and stream operations over Fastify, applying local request, origin, capability-token, and schema checks at the transport boundary.

## Public API

The package root exports `createTraceGraphHost` and the Host option, controller, project, and lifecycle types. Memory control routes delegate to Runtime's single Core command/query service and derive scope from the Host-visible project registry. The package also has a development entry point; the regular public export is `.`.

## Dependencies

It depends on `@tracegraph/contracts`, `@tracegraph/core`, Fastify, `@fastify/cors`, and Zod. The SDK is a client of Host and is not a Host dependency.

## State ownership

Host owns the in-process composition and transport lifecycle. Core remains the canonical owner of Run facts and durable stores; Host does not create a parallel Run ledger.

## Extension points

The `TraceGraphHostOptions` controllers and providers let the composition inject project, Session, settings, and extension operations. The Host registers transport routes around those explicit seams.

## Model effect

Host does not infer model decisions. It validates and routes user commands to the composed Runtime, which may then call a model; projections and model-surface streams are returned as read data.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/host test:unit` from the repository root.

## Known limitations

The Host is single-process, single-user, and restricted to loopback addresses. Its local capability does not provide multi-user identity. Its request timeout limits request receipt, not Runtime handler execution; a client disconnect does not imply that an accepted operation was rolled back.
