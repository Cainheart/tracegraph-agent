---
id: 2026-10-02-desk-064-desktop-host-lifecycle
title: Add an exact-version Desktop Host process lifecycle
status: implemented
owners: [desktop, client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [apps/desktop-host, packages/core, packages/session, packages/api, packages/sdk/server]
supersedes: []
---

# Agent Note: Add an exact-version Desktop Host process lifecycle

## Problem

API-062 provides private bounded framing and API-061 provides the first in-process Run/Session controller, but the repository has no Desktop Host process. A future Electron Main must know that it launched a compatible Host build, receive a bounded protocol channel, and close or restart the process without losing the canonical Run ledger.

## Current state

- `@tracegraph/core` creates the Runtime and owns the canonical event ledger; `@tracegraph/session` owns the durable Session reference index.
- `@tracegraph/api` binds the existing Run/Session operations to registered Workspace capabilities.
- DESK-064 now provides `@tracegraph/desktop-host`: an exact-version child process with a private Node IPC startup handshake and versioned framed RPC over stdin/stdout. It opens no network listener and has no GUI.
- Core and Session recovery already mark a nonterminal Run interrupted after process loss; recovery does not automatically rerun model or tool work.

## Decision

The private app `@tracegraph/desktop-host` waits for a trusted parent start message over Node IPC, validates the expected package version, protocol version, absolute data directory, and registered Workspace handles, then creates one Runtime and Session controller. The ready reply includes the exact app/protocol versions and startup recovery report. Version mismatch fails before the Host accepts protocol frames.

Node IPC carries startup configuration and readiness only. Run/Session command and query traffic uses API-062 framed RPC over child stdin/stdout. The process does not open an HTTP/TCP listener. The initial dispatcher binds `start_run` and the current Run/Session read queries to the existing `RunSessionController`; unsupported Run commands fail closed pending later route-family work.

EOF on the private input stream stops dispatch, closes the framed writer, waits for bounded handler settlement, then shuts down Runtime background Memory work and flushes Telemetry. Abrupt process loss is recovered from the existing durable Session/Ledger state at next startup; active Runs become `interrupted` and are not automatically replayed.

## Invariants and boundaries

- The parent must request an exact package version and protocol version; the child validates both and reports both in readiness.
- Workspace handles arrive only from the trusted parent process and are validated before Runtime/controller composition. Renderer-supplied paths are not accepted.
- Exactly one Runtime, Session store, DurableSessionController, and RunSessionController are composed per child process.
- Framed RPC remains bounded by the existing SDK frame/request/queue rules; transport cancellation is not domain Run cancellation.
- Graceful shutdown and restart do not claim that an active operation completed. Durable recovery decides its canonical state.
- This task creates no Electron window, Renderer bridge, TCP listener, automatic crash-loop restart policy, or new persisted schema.

## Acceptance criteria

- [x] The child reports exact package and protocol versions; mismatch rejects startup before RPC requests are accepted.
- [x] A no-GUI smoke test launches the built child and completes a schema-valid framed Session query.
- [x] A durable active Run is reconciled during child startup after simulated process loss; the recovery report and canonical Projection show `interrupted` without a second Run execution.
- [x] EOF performs bounded graceful shutdown; abrupt child termination followed by relaunch preserves durable data and does not duplicate recovery facts.
- [x] Current module docs, package README, architecture policy, generated module graph, roadmap, and paired Note agree.

## Migration and rollback

The app and process boundary are additive. Rollback removes `apps/desktop-host` and its architecture/roadmap entry; existing CLI/Web Host processes and stored Session/Ledger data require no migration.

## Risks and open questions

- The first dispatcher intentionally covers only Run start/read and Session read. Approval, steering, cancel, artifacts, live event subscriptions, credential/profile composition, and automatic process restart remain later work.
- Node IPC provides local process isolation, not remote authentication. The trusted parent/child ownership boundary must be retained when Electron Main is added.

## Evidence

- Implementation: `apps/desktop-host/src/desktop-host.ts`, `host-process.ts`, `worker.ts`, and strict lifecycle schemas.
- Tests: `desktop-host.test.ts` (2 passed); built-child `desktop-host.e2e.test.ts` (3 passed, including recovery and second crash/relaunch).
- Verification: package build/typecheck plus `verify:boundaries`, `verify:invariants`, `verify:package-readmes`, `verify:v2-docs`, `graph:modules:check`, `verify:lockfile`, and `git diff --check` passed.
