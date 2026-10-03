# @tracegraph/desktop-host

## Purpose

This package is the Desktop-facing façade for the shared local Host. `ensureLocalHost`, `connectLocalHost` and `ConnectedLocalHost` are re-exported from `@tracegraph/host`; Electron Main uses these APIs rather than composing an independent Runtime.

## Public API

The authenticated private UDS/Windows-pipe transport reuses the shared typed HTTP routes, three SSE feeds, controller set and one background Runtime. The same profile serves CLI and the loopback Web gateway. `close()` detaches only this connection; `stop()` explicitly stops the owner. Native project registration/root lookup and backup-first migration run only through the private authenticated channel. No renderer filesystem path or bearer is accepted as authority.

## Dependencies

`@tracegraph/host` owns the shared composition. Legacy compatibility uses API, Core, Contracts, SDK framing, Session, Zod and Test Support; those dependencies do not create an additional live Desktop owner.

## State ownership

The shared Host owns durable Ledger/Session/project/configuration state. A trusted standalone Node resolver remains public for legacy compatibility and verifies Node 22.19+ within 22.x or Node 24+ without Electron.

## Extension points

`createDesktopHostRuntime`, `launchDesktopHostProcess`, `createDesktopHostDispatcher` and `DesktopHostNativeClient` retain the older framed/private-worker implementation for compatibility and focused tests. Their process lifecycle and framed vocabulary are not the live Desktop connection path. Adding a live workflow belongs in the shared Host/typed SDK and fixed Desktop adapter, rather than duplicating controllers here.

## Model effect

Default macOS credentials retain the platform Keychain backend; tests explicitly select disposable private-file profiles. The Host resolves model decisions and persists only credential references in configuration. Saving metadata does not test connectivity.

## Verification

Package `build`, `typecheck`, `test:unit` and `test:e2e` preserve compatibility. Host local transport tests cover shared owner/authentication/recovery/migration. Desktop fixed bridge tests and [real transport acceptance](../../docs/validation/unified-workbench/desktop-transport.mjs) validate the live private connection, public SSE, approvals, bytes/receipts and background continuation. All executable fixtures use synthetic providers and disposable data; they make no external-user/provider-quality claim.

## Known limitations

The live shared Host exposes a loopback HTTP gateway as well as its private channel. This façade adds no separate listener or Runtime. See [Host module](../../docs/modules/09-Host-与-SDK-接口层.md) for the owner composition and [Desktop package](../desktop/README.md) for native isolation and setup.
