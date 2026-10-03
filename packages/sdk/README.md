# @tracegraph/sdk

Typed client for the local TraceGraph Host API. See [module 09](../../docs/modules/09-Host-与-SDK-接口层.md).

This workspace package is private. Its `@tracegraph/sdk/protocol` subpath defines
the transport-neutral Command/Query/Event/reply envelopes used by local client
surfaces, while the private `./client` and `./server` subpaths implement bounded
framed RPC over WHATWG streams. This is not a separately supported or published
developer SDK.

## Purpose

Give Web, Desktop and CLI consumers a schema-checked client for the same Host operations, Run/Session projections, Memory controls and real SSE streams. Desktop Main and CLI inject an authenticated HTTP transport over the private local channel; Web uses the loopback gateway.

## Public API

The package root exports `TraceGraphClient`, `TraceGraphHttpError`, client/stream options, response types, and SSE parsing. Shared controls include settings/CAS updates, capabilities, separate model testing, background resources and closed workbench commands, alongside the existing Run, approval, Todo, Artifact, attachments, Memory/Experience, Team and replay/rollback routes. Private subpaths expose protocol envelopes and the compatibility framed RPC client/server; none are external product APIs.

The protocol subpath reuses `@tracegraph/contracts` for Run command, Run/Session
query, projection, and event payloads. Its versioned envelope is additive and
transport-neutral. Durable ledger events, transient activity, and model-surface
events keep separate discriminators and cursors. Shared deterministic fixtures
are consumed by CLI, Web and Desktop adapters. Live Desktop subscriptions keep
independent canonical/activity/model cursors and stop only their subscription
when a view closes.

The private `./client` and `./server` subpaths use a four-byte unsigned
big-endian payload length followed by UTF-8 JSON. Frames default to an 8 MiB
maximum; pending/in-flight requests and queued output bytes are bounded, and
serialized writes wait for stream backpressure. Client AbortSignal cancellation
sends a transport `cancel` for one `request_id` and aborts only that server
handler signal. It does not cancel or roll back a domain Run. The server accepts
injected command/query handlers and does not own process launch, a network
listener, authentication, or Desktop/CLI integration.

The private `./client` export also owns the framework-independent locale catalog,
locale resolution, presentation translation and terminal environment precedence.
Web/Desktop consume it through the shared Workbench, and CLI startup labels use
the same catalog. See [locale governance](../../docs/i18n/README.md). This changes
presentation only; protocol values and model-produced content remain unchanged.

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

## Verified media output

`getImageConfig()`, `configureImageProvider(input)` and `clearImageProvider()` expose the dedicated provider's safe metadata. `startMediaRun({command_id, project_id?, operation})` admits the closed generate/diagram/chart operation through the shared Run/session controller. `getArtifactContent(runId, artifactId)` returns `{artifactId, mediaType, sha256, bytes}` only after bounded response and SHA-256 verification; the Host separately proves canonical project/Run relation, MIME, size and hash. Replay denies binary reads and media mutation.

Generated output is PNG or constrained self-contained SVG in this release; no remote output URL fetching or inferred image success from model prose. Commands are idempotent by full typed intent. Use explicit capability flags (`image.read/configure/clear`, `media.generate/diagram/chart`, `artifacts.binary.read`); callable methods do not imply that a configured provider or current policy permits the operation. [MEDIA-094 evidence and limits](../../docs/validation/media-094/README.md).
