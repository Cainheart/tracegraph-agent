# @tracegraph/host

Local HTTP/SSE transport around the composed Outlive Agent Runtime. See [module 09](../../docs/modules/09-Host-与-SDK-接口层.md) for route and trust-boundary details. The `@tracegraph` package namespace and existing event schemas remain compatibility identifiers.

## Purpose

Expose Host-owned project, Session, Run, artifact, Memory control, command, and stream operations over Fastify, applying local request, origin, capability-token, and schema checks at the transport boundary.

## Public API

The package root preserves the `createTraceGraphHost` and Host type exports as a compatibility facade; the Fastify implementation is available at `@tracegraph/host/webserver`. Run start/read and Session list/read/resume orchestration is shared through `@tracegraph/api`; HTTP authentication, status mapping, cache headers, and SSE remain in the webserver adapter. Memory control routes delegate to Runtime's single Core command/query service and derive scope from the Host-visible project registry. The package also exposes `ensureLocalHost`, `connectLocalHost`, `readLocalHostStatus`, `startLocalHost`, and `stopLocalHost`, shared profile discovery and owner leases, workspace admission, and explicit legacy migration preview/commit operations. Web HTTP and private local HTTP use the same Fastify routes and Runtime. Client `close()` detaches; explicit Host stop shuts down Runs and resources.

## Dependencies

It depends on `@tracegraph/api`, `@tracegraph/contracts`, `@tracegraph/core`, Fastify, `@fastify/cors`, and Zod. The SDK supplies the authenticated private local client facade; Host-owned composition also uses the public Session, MCP, LSP, retrieval and telemetry packages. `node-pty` provides the managed terminal backend. Pinned `playwright-core` controls an isolated matching Chromium distribution. Installed builds use verified bundled manifests for Chromium and the platform computer helper; missing resources disable that capability without downloading a substitute or using the user's browser profile.

## State ownership

Host owns the in-process composition and transport lifecycle. Core remains the canonical owner of Run facts and durable stores. Host settings and resource indexes are durable projections; business commands and schedule triggers use the existing validated SessionEvent Ledger format. Requested commands without a receipt are not retried after restart.

## Extension points

The `TraceGraphHostOptions` controllers and providers let the composition inject project, Session, settings, and extension operations. The Host registers transport routes around those explicit seams. Browser, computer, Goal and personal-data controllers expose the same operations to typed HTTP, fixed Desktop IPC and CLI adapters. Human permission prompts are a trusted composition callback independent of native directory picking; model and HTTP bodies cannot claim that permission was confirmed.

## Model effect

Host does not infer model decisions. It validates and routes user commands to the composed Runtime, which may then call a model; projections and model-surface streams are returned as read data.

## Verification

Run `pnpm --filter @tracegraph/host build && pnpm --filter @tracegraph/host test:unit` from the repository root.

## Known limitations

The Host is single-process, single-user, and restricted to loopback addresses. Its local capability does not provide multi-user identity. Its request timeout limits request receipt, not Runtime handler execution; a client disconnect does not imply that an accepted operation was rolled back.

The browser currently controls isolated headless tabs with DOM observations and PNG evidence. A Chrome extension and visible manual browsing surface are pending. Native computer effects require separate OS and application grants, monitored input ownership and verified target identity; file access does not grant computer control. Windows source/build machinery is not native Windows acceptance. Goal budgets and human continuation are implemented, while autonomous whole-requirement delivery and final product acceptance remain separate. See the [current capability matrix](../../docs/validation/product-workbench-2026-10-05/capability-matrix.md).
