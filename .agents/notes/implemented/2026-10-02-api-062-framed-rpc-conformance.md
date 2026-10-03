---
id: 2026-10-02-api-062-framed-rpc-conformance
title: Add bounded private framed RPC client and server conformance
status: implemented
owners: [client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/sdk/client, packages/sdk/server, client-protocol-v1]
supersedes: []
---

# Agent Note: Add bounded private framed RPC client and server conformance

## Problem

API-060 established the transport-neutral client protocol and API-061 separated the first Run/Session controller slice from Fastify. Desktop/CLI still have no shared byte transport or server dispatcher with evidence for partial reads, request cancellation, output backpressure, or protocol-version mismatch.

## Current state

- `@tracegraph/sdk/protocol` defines versioned Command, Query, Event, reply, and error envelopes backed by canonical contracts.
- `@tracegraph/api` provides in-process Run/Session operations; `@tracegraph/host` owns local HTTP/SSE and is not a dependency of this work.
- API-062 implements reusable private framing and dispatch seams. Desktop and framed RPC process integration still do not exist; this Note does not claim product integration.

## Proposal

Add private `@tracegraph/sdk/client` and `@tracegraph/sdk/server` subpaths. Use a four-byte unsigned big-endian payload length followed by one UTF-8 JSON protocol envelope. Enforce an 8 MiB default frame bound, strict UTF-8/JSON parsing, the existing `ClientProtocolMessageSchema`, and `CLIENT_PROTOCOL_VERSION` on every message.

The client correlates bounded in-flight command/query requests by `request_id`, surfaces server events, and sends a transport `cancel` message when its AbortSignal fires. The server dispatches command/query messages to injected protocol handlers, passes a cooperative AbortSignal and event writer, bounds in-flight requests, and returns safe protocol errors. Both sides serialize frame writes and await WHATWG WritableStream backpressure.

Transport cancellation targets the RPC `request_id`; it is not a `RunCommand`, does not mean a domain Run was cancelled, and cannot roll back a command the controller already accepted. Product callers must inspect the canonical reply/projection and use the domain cancel command when they intend to cancel a Run.

## Decisions and alternatives

- A four-byte big-endian length prefix is selected over Content-Length text headers to keep framing unambiguous, byte-counted, and independent of line parsing on private stdio/pipe transports.
- WHATWG `ReadableStream`/`WritableStream` are the transport seam. Node callers can adapt child-process stdio at composition; the SDK does not own process launch, endpoint security, Desktop Main/Preload, or Host lifecycle.
- The server uses injected handlers rather than depending directly on Fastify, Runtime internals, or one controller implementation. This keeps the transport reusable while API-061 controller coverage remains intentionally limited to its current operation slice.
- A version mismatch fails closed. A server emits `unsupported_version` when it can correlate the incoming request; a peer receiving an envelope with a different local protocol version rejects the connection result rather than guessing compatibility.
- No loopback listener, external RPC service, automatic CLI migration, or Desktop implementation is introduced.

## Invariants and boundaries

- Frames are non-empty, UTF-8 JSON envelopes and are bounded before any handler dispatch.
- Partial reads and multiple frames in one read produce the same validated messages as whole-frame reads.
- Concurrent dispatch and pending requests have explicit finite limits. Frame writes are serialized and await sink completion/backpressure; overflowing the bounded writer fails closed.
- A cancel frame only aborts the matching in-flight dispatch signal. Unknown/late cancellation is harmless and cannot target a different request.
- Unsupported versions and malformed envelopes are never dispatched. Generic handler failures do not echo internal exception details.
- `@tracegraph/sdk/client` and `@tracegraph/sdk/server` remain private package exports and do not create an external API product.

## Migration and rollback

The new client/server subpaths and cancel discriminator are additive. Existing HTTP/SSE SDK methods, CLI behavior, and Host routes remain unchanged. Rollback removes the subpaths, framing code/tests, and cancel discriminator; no persisted data or user configuration changes.

## Acceptance criteria

- [x] Client/server frame and dispatch APIs use the shared private protocol envelopes and enforce frame/in-flight bounds.
- [x] Conformance tests split frames across arbitrary partial reads and accept multiple frames in one chunk.
- [x] Client cancellation reaches only the targeted server AbortSignal and is documented as transport cancellation, not domain Run cancellation.
- [x] Backpressure tests show the server does not write later frames before the bounded stream writer can accept earlier frames.
- [x] Client/server version mismatch fails closed with a diagnosable stable error; mismatched input is not dispatched.
- [x] SDK client/server package subpaths, README, architecture policy, generated module graph, and roadmap agree; no external RPC product or CLI/Desktop migration is claimed.

## Risks and open questions

- Cancellation is cooperative. A controller handler that ignores AbortSignal may continue after the peer stops waiting; accepted domain commands remain governed by their durable receipt/projection.
- API-062 establishes byte framing and conformance, not authentication. Desktop private pipe ownership and one-time host token remain lifecycle/security responsibilities.
- Events share the ordered frame writer with replies; a later stream-level flow-control protocol may need cursor-based replay/snapshot recovery rather than larger transport queues.

## Evidence

- Implementation: `packages/sdk/src/protocol/index.ts`, `packages/sdk/src/transport/`, `packages/sdk/src/client/`, `packages/sdk/src/server/`, and private exports in `packages/sdk/package.json`.
- Tests: `env -u NODE_OPTIONS pnpm --filter @tracegraph/sdk test:unit` — 5 files, 59 tests passed; covers partial/coalesced frames, invalid/truncated/oversized frames, byte queue bound, write backpressure, request-scoped cancel, in-flight bound, and both directions of version mismatch.
- Verification: with the inherited broken Node preload unset, `env -u NODE_OPTIONS pnpm --filter @tracegraph/sdk build`, `env -u NODE_OPTIONS pnpm run verify:boundaries`, `env -u NODE_OPTIONS pnpm run verify:invariants`, `env -u NODE_OPTIONS pnpm run verify:package-readmes`, `env -u NODE_OPTIONS pnpm run verify:v2-docs`, `env -u NODE_OPTIONS pnpm run graph:modules:check`, `env -u NODE_OPTIONS pnpm run verify:lockfile`, and `git diff --check` all passed.
