---
id: 2026-10-02-cli-063-run-session-client
title: Route CLI Run and Session commands through the shared client protocol
status: implemented
owners: [cli, client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [apps/cli, packages/sdk/protocol, packages/api/run-session-controller]
supersedes: []
---

# Agent Note: Route CLI Run and Session commands through the shared client protocol

## Problem

API-060 established shared Run/Session protocol envelopes, API-061 made the Host Run/Session controller the application authority, and API-062 added bounded private framing. The CLI still has no Run/Session command surface that emits protocol messages or demonstrates that CLI event output matches the canonical Host/Web event stream.

## Current state

- `tracegraph` composes the local Host with one Runtime; existing `team`, `memory`, `mcp`, and `extensions` subcommands connect to a running Host through `TraceGraphClient`.
- Host Run/Session HTTP routes call one process-local `RunSessionController`; its active-Run and idempotency state must remain shared with Web requests.
- The private protocol already defines Run start/read and Session list/read messages and typed event/reply envelopes. The current CLI only validates the common fixture set.

## Decision

Add CLI `run start|get|events` and `sessions list|get` commands. The commands form and validate the existing shared protocol envelopes, then adapt the supported operation to the existing typed `TraceGraphClient`. This reaches the same running Host and `RunSessionController` as Web, keeps Runtime and process-local coordination singular, and does not create a second Host or RPC listener. Machine output is JSON Lines containing protocol reply/event envelopes; diagnostics go to stderr.

`run events` reads the canonical projection timeline by default and can follow the Host event stream with `--follow`. It serializes each canonical `WireSessionEvent` inside the shared `ledger` event envelope. This CLI slice does not add new domain operations, alter authority, or connect the CLI to a Desktop stdio/framed-RPC process.

## Invariants and boundaries

- CLI arguments are validated against the existing contracts/protocol; no workspace handle, actor, policy, or filesystem authority is accepted from argv.
- Run start preserves the explicit command id through the existing Host API/controller idempotency boundary.
- CLI JSONL stdout contains only schema-validated protocol replies/events. Usage and Host failures remain on stderr and return a nonzero exit code.
- Event payloads are the Host's canonical ledger facts and use the same protocol event schema/fixture as Web conformance.
- Existing `serve` composition, Host lifetime, HTTP/SSE routes, and non-Run CLI subcommands retain their behavior.

## Acceptance criteria

- [x] `run start|get|events` and `sessions list|get` use the shared protocol schemas and the existing typed Host client/controller path.
- [x] JSONL output is schema-valid and stdout contains no diagnostics; invalid input and Host failure produce no success-shaped stdout.
- [x] CLI event messages retain canonical event identities/sequences and compare equal with the same Host Web/SDK event stream.
- [x] CLI unit and Host-backed integration coverage pass; package README, module 11, protocol/controller docs, roadmap, and generated module graph agree.
- [x] No second Runtime/controller, new listener, external API, Desktop integration, or unrelated CLI command migration is introduced.

## Migration and rollback

The new command branches are additive. Remove the Run/Session CLI module and dispatch branches to roll back; the Host, SDK, persisted event ledger, and existing commands require no migration.

## Risks and open questions

- A long-running `--follow` invocation depends on the existing Host SSE reconnection behavior; operators can stop waiting with SIGINT without altering the Run.
- Only the API-060/061 Run/Session slice is exposed here. Approval, steering, rollback, and broader client catalogs remain owned by their current commands/routes and later roadmap work.

## Evidence

- Implementation: `apps/cli/src/run-session-command.ts`, `apps/cli/src/index.ts`; the commands use `TraceGraphClient` and Host's existing RunSessionController routes.
- Tests: `env -u NODE_OPTIONS pnpm --filter @tracegraph/cli test:unit` (17 files, 70 tests) and `env -u NODE_OPTIONS pnpm --filter @tracegraph/cli test:e2e` (4 tests). E2E covers all five commands, CLI Run start and exact CLI ledger-vs-SDK SSE event equality; unit coverage includes schema-valid JSONL, invalid-input/bootstrap ordering, Host failure output, and follow cursor.
- Verification: `env -u NODE_OPTIONS pnpm --filter @tracegraph/cli build`; `verify:boundaries`, `verify:invariants`, `verify:package-readmes`, `verify:v2-docs`, `graph:modules:check`, `verify:lockfile`, and `git diff --check` all pass.
