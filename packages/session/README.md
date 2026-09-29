# @tracegraph/session

## Purpose

Own the durable Session JSONL reader/writer, format migration, and query store
behind a narrow package boundary. Session entries reference canonical Ledger
events; they do not duplicate Run event bodies.

## Public API

The package root exports `SessionStore`, `SessionLease`,
`JsonlSessionStore`, `migrateSessionEntry`, and typed persistence errors. There
are no supported deep imports. The Core compatibility adapter supplies the
canonical title redactor; direct composition roots must provide that port.

## Dependencies

The package depends on `@tracegraph/contracts`, Zod, and Node platform APIs.
It does not import Core, Runtime, Evidence, Host, or application packages.

## State ownership

Session JSONL files, generation migration, path safety, file leases, and
soft-deletion into the configured local trash directory are owned here. Ledger
event bodies and Run lifecycle facts remain owned by their canonical stores.

## Extension points

`JsonlSessionStoreOptions.redactSensitiveText` supplies Core's canonical
redaction function. Clock, process identity, lease timeouts, and the trash root
remain injectable for controlled composition and tests.

## Model effect

None. The package performs no model calls or tool dispatch. Its query API
returns validated Session summaries and event references.

## Verification

Run `pnpm --filter @tracegraph/session test:unit` and
`pnpm --filter @tracegraph/session typecheck`. Workspace boundary and package
README gates validate the dependency direction and public contract.

## Known limitations

The package currently provides local JSONL persistence only. Lifecycle
recovery, Session-to-Run orchestration, and resume policy remain in Core's
`DurableSessionController`.
