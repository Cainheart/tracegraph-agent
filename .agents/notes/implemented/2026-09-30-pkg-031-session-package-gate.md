---
id: 2026-09-30-pkg-031-session-package-gate
title: Extract the Session persistence family behind a public package boundary
status: implemented
owners: [session]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [session, core, cli, package-topology]
supersedes: []
---

# Agent Note: Extract the Session persistence family behind a public package boundary

## Before PKG-031

`packages/core/src/domains/session/session-store.ts` owns the JSONL reader and
writer, v0-to-v1 record migration, listing/query behavior, path safety, and
cross-process leases. Its format is already expressed by
`@tracegraph/contracts`; the store has a stable `SessionStore` port and focused
reader/writer/migration tests. The file currently imports Core's canonical
title redactor. `DurableSessionController` coordinates session lifecycle with
`AgentRuntime` and remains a Core composition concern.

## Gate review

Proceed with a staged package extraction. The boundary is the existing
`SessionStore` port and contract-owned JSONL records. Core Runtime consumes
the port; the CLI composition root constructs the durable implementation, so
both become direct consumers of the new package. The independent persisted
format generation/migration obligation and file/lease safety are additional
isolation reasons. Public package contract tests will cover migration, durable
write/read, and listing through the package root. Title redaction remains
canonical in Core and is injected through a required typed constructor port;
the package must not import Core or copy redaction logic.

## Implemented design

- Add `@tracegraph/session` for `SessionStore`, `SessionLease`, JSONL format
  migration, and the durable file-store implementation.
- Keep `DurableSessionController`, recovery orchestration, and session-to-Run
  coordination in Core because they depend on `AgentRuntime`.
- Keep existing Core root exports and constructor behavior through a thin
  compatibility adapter; have the CLI construct the package implementation
  directly at the composition root.
- Register the new package and allowed dependency edges in
  `architecture-policy.yaml`; generate current module graph and baseline docs.

## Deferred

Do not change Session record versions, query semantics, retention/deletion
behavior, recovery policy, or event ownership. Do not extract the lifecycle
controller or move Run projection/recovery authority into the package.

## Acceptance criteria

- [x] Package depends only on `@tracegraph/contracts`, Zod, and Node platform
      APIs; Core-owned redaction is required through a typed port.
- [x] Core and CLI are real direct consumers; Core compatibility exports remain
      source-compatible.
- [x] Public-root contract tests cover v0 migration, current-generation
      reader/writer behavior, and query/list behavior.
- [x] Existing Core Session Runtime tests, CLI vertical E2E, typechecks, and
      package/boundary/doc gates pass.
- [x] Current documentation describes only the behavior verified in code.

## Migration and rollback

Move the store implementation behind the new package root, leave a Core
adapter for its existing API, then switch CLI construction to the package.
There is no on-disk migration. If package or parity gates fail, keep the
compatibility adapter and restore implementation ownership to Core; persisted
JSONL files remain unchanged.

## Evidence and verification

- Implementation: `packages/session/src/session-store.ts` and its public root
  `packages/session/src/index.ts`; Core retains the compatibility adapter at
  `packages/core/src/domains/session/session-store.ts`.
- Composition: Core Runtime depends on the Session store port; CLI directly
  constructs `JsonlSessionStore` and injects Core's canonical title redactor.
- Contract coverage: `packages/session/src/session-contract.test.ts` exercises
  version migration, current-format write/read after restart, redaction-port
  behavior, and listing through the package root.
- `pnpm --filter @tracegraph/session test:unit`: 2 tests passed.
- `pnpm --filter @tracegraph/core test:unit`: 416 tests passed, including the
  existing reader/writer/migration, safety, and recovery coverage.
- `pnpm --filter @tracegraph/cli test:e2e`: 4 tests passed.
- `pnpm typecheck`: all workspace builds, package typechecks, and eval
  typechecks passed.
- `pnpm verify:boundaries`: 14 packages, 25 workspace dependencies, 1,376
  import references; zero legacy findings.
- `pnpm verify:package-readmes`: 14 package README contracts passed.
- `pnpm verify:invariants`: 178 source files passed.
- `pnpm verify:v2-docs`: 11 manifest documents and 62 roadmap tasks passed.
- `pnpm test:engineering`: 48 Node tests and 8 Vitest gate tests passed.
- `pnpm graph:modules` and `pnpm baseline:current` regenerated the current
  package/module graph and structural baseline.
- `pnpm graph:modules:check`, `pnpm baseline:current:check`,
  `pnpm verify:lockfile`, and `pnpm release:check` passed.
