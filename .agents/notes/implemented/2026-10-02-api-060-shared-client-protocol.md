---
id: 2026-10-02-api-060-shared-client-protocol
title: Shared internal client protocol v1
status: implemented
owners: [client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/sdk/protocol, packages/contracts, apps/cli, apps/web]
supersedes: []
---

# Agent Note: Shared internal client protocol v1

## Problem

The repository had canonical domain schemas and a Host HTTP/SSE SDK, but no transport-neutral Command/Query/Event envelope for the product entrypoints. A shared schema is needed before controller separation and framed RPC without creating a separate public SDK/API.

## Decision and implementation

`packages/sdk/src/protocol/` owns a private, transport-neutral `tracegraph.client-protocol.v1` envelope. It reuses `@tracegraph/contracts` for Run commands, Run/Session queries and typed result payloads. Events explicitly distinguish durable `ledger` messages from transient `activity` and `model_surface` messages; their existing event sequences/cursors stay owned by the source contract.

The package exports `@tracegraph/sdk/protocol` as a private subpath. A deterministic fixture set is exported there and consumed by CLI and Web conformance checks. `packages/sdk` remains private. Existing HTTP routes, SDK behavior, Host authentication, and Runtime execution are unchanged. There is no Desktop app yet; a future Desktop client can use the same schema and fixture path.

This is the Run/Session contract slice, not a full controller catalog. Workspace, Memory, Operation, Artifact, and Profile commands/queries can be added from their owning contracts in later tasks. Controller separation and transport framing remain API-061/API-062.

## Invariants and boundaries

- The protocol depends on `@tracegraph/contracts`; contracts do not depend on SDK or applications.
- Receipt of a protocol message creates no SessionEvent and carries no authority. Host/Controller remains responsible for deriving actor, scope, and workspace capability.
- Unknown message kinds, query operations, event streams, and error codes fail schema parsing. Unknown optional envelope fields are stripped so an older client can ignore additive fields.
- Durable ledger, live activity, and model-surface event semantics remain separate; transient events cannot be used as ledger replay evidence.
- The protocol package is an internal implementation detail, not a published SDK/API.

## Migration and rollback

The change is additive. Existing callers keep using their current Host routes and SDK methods. The protocol subpath and fixture checks can be removed without data migration or ledger rewrite if the v1 envelope changes before API-061 adopts it.

## Acceptance criteria

- [x] The private protocol subpath exports versioned Command/Query/Event/reply/error schemas and inferred types.
- [x] Deterministic fixture coverage includes Run command, Session query, durable event, live activity, model-surface event, and typed reply.
- [x] SDK contract tests reject malformed/unknown discriminators, preserve stream separation, and cover additive envelope fields.
- [x] CLI and Web conformance checks parse the same fixture set from the same package subpath.
- [x] Current docs and roadmap describe the implemented slice and Desktop limitation without claiming a transport/controller migration.

## Risks and open questions

- The first version covers only the owned Run/Session slice. API-061 must add additional operations from canonical contracts and preserve Host authority binding.
- The Desktop consumer remains pending until the Desktop app exists.

## Evidence

- Implementation: `packages/sdk/src/protocol/index.ts`, `constants.ts`, `fixtures.ts`; private subpath in `packages/sdk/package.json`.
- Consumers: `apps/cli/src/protocol-conformance.test.ts` and `apps/web/src/protocol-conformance.test.ts` import the shared fixtures and parser.
- Tests: SDK 47 tests, CLI unit 66 tests, and Web unit 149 tests passed.
- Verification: SDK build/typecheck; CLI and Web typecheck; `verify:boundaries` (18 packages, 34 workspace dependencies, 1,713 import references, 0 legacy findings), `verify:invariants` (229 source files), `verify:package-readmes` (18 packages), `verify:v2-docs` (11 documents, 64 tasks), `graph:modules:check`, `verify:lockfile` (19 manifests), and `git diff --check` passed.
- Current docs: `docs/modules/09-Host-与-SDK-接口层.md` and `docs/outlive-agent-v2/06-clients-protocols-desktop/01-shared-protocol-controller.md`.
