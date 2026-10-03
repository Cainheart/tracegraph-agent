---
id: 2026-10-02-api-061-run-session-controller
title: Extract in-process Run and Session client controller
status: implemented
owners: [client-protocol]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/api, packages/host/webserver, run-session-commands]
supersedes: []
---

# Agent Note: Extract in-process Run and Session client controller

## Problem

API-060 introduced the first shared Run/Session protocol slice, but `packages/host/src/index.ts` combined Fastify setup with application orchestration: Run-start idempotency, the single-active-Run lease, workspace binding, Session scoping, and projection checks lived inside route handlers. A non-HTTP caller could not exercise these same application operations directly.

## Current state

- `@tracegraph/host` owns the Fastify server and local bearer/origin checks; Fastify routes now live in `packages/host/src/webserver/index.ts`, and the package root is a compatibility re-export.
- Start command deduplication and active-Run tracking are process-local `RunSessionController` state in `@tracegraph/api`.
- `DurableSessionController` in Core owns Session JSONL leases/recovery and canonical Run interaction; Host supplies workspace resolution and HTTP scope checks.
- API-060 added a private protocol schema subpath for the existing Run/Session operation slice. CLI uses Host HTTP through the SDK; no Desktop app exists.
- `architecture-policy.yaml` constrains `@tracegraph/api` to depend only on `@tracegraph/contracts`.

## Proposal

Create `@tracegraph/api`, a transport-neutral in-process Run/Session application controller. It will own Run start idempotency and active-Run coordination, bind client Run requests to Host-provided Workspace handles, enforce registered-project/Session identity consistency, and provide typed Run/Session queries. It will depend only on `@tracegraph/contracts` and narrow injected Runtime/Session ports, not Fastify, Node, apps, or the SDK.

Move the Fastify implementation under `packages/host/src/webserver/` and preserve the current package-root export as a compatibility re-export. The Host HTTP adapter retains loopback, Origin, capability/replay authentication, HTTP parsing/status/header behavior, and SSE streaming; the selected Run/Session routes call `@tracegraph/api`. The same API controller is directly callable by in-process tests and future RPC adapters.

This first controller slice corresponds to API-060's current Run/Session schema. Settings, project lifecycle, extensions, MCP/LSP, Team, Memory, Artifact content, and SSE transport remain Host route/controller seams and are not claimed as extracted by this task.

## Alternatives considered

- Moving all route logic into a new package at once was rejected because transport authentication, replay capability, binary attachments, SSE lifetimes, and optional Host seams have distinct ownership and would cause a risky bulk rewrite.
- Keeping the controller in the Fastify package was rejected because future RPC/in-process callers would still depend on the web transport family.
- Letting `@tracegraph/api` depend on the full SDK protocol package was rejected because the controller is domain/application logic; it should depend on canonical contracts and narrow ports, while transports adapt protocol messages.

## Invariants and boundaries

- `@tracegraph/api` has no Fastify, Node HTTP, React, CLI, Desktop, persistence-file, or SDK imports.
- The API controller receives workspace handles from trusted composition; client requests cannot create or select a filesystem capability except by choosing a Host-registered project id.
- Project scope is derived from the current Host registry. Session reads/list results must remain inside that scope and preserve Session/Run identity.
- One active Run and command-id replay semantics remain unchanged. A repeated id with the same fingerprint returns the existing canonical projection; reusing it with different input conflicts.
- The Host remains bound to loopback and validates bearer/replay authority before invoking an application controller.
- Canonical Run Event Ledger and DurableSessionController continue to own persistent state; the API controller keeps only process-local coordination/idempotency indexes.

## Migration and rollback

The package and Host webserver path are additive with a root re-export for current imports. Route behavior and URLs remain unchanged. Rollback restores the previous Host module and inline orchestration, removes the API package/policy entry and lockfile importer, and requires no persisted-data migration.

## Acceptance criteria

- [x] `@tracegraph/api` owns a typed in-process Run/Session controller and has no transport imports.
- [x] Host Run start/read and Session list/read/resume routes call the shared controller; Host retains transport security and response behavior.
- [x] Controller contract tests call it without Fastify and cover scope, Session binding, duplicate command replay/conflict, active-Run serialization, and Session resume binding.
- [x] Host route tests prove the local HTTP adapter preserves existing status, scope, and resume/current-active-Run behavior.
- [x] `@tracegraph/host` exposes `webserver` while preserving root compatibility; architecture policy, docs, and generated module graph agree.
- [x] Roadmap records the implemented slice and explicitly deferred route families.

## Risks and open questions

- Process-local active-Run and idempotency indexes retain their current single-Host limitation; durable multi-process coordination is not part of API-061.
- Host routes outside the Run/Session slice remain adapters around existing domain seams and require incremental controller coverage before other transports can expose them.

## Evidence

- Implementation: `packages/api/src/run-session-controller.ts`; Fastify implementation moved to `packages/host/src/webserver/index.ts`; `packages/host/src/index.ts` remains a root re-export; package manifest and architecture policy expose the new seam.
- Tests: `env -u NODE_OPTIONS pnpm --filter @tracegraph/api test:unit` (6 passed); `env -u NODE_OPTIONS pnpm --filter @tracegraph/host test:unit` (55 passed); API typecheck and API/Host builds passed.
- Verification: `verify:boundaries`, `verify:invariants`, `verify:package-readmes`, `verify:v2-docs`, `graph:modules:check`, `verify:lockfile`, and `git diff --check` passed. The initial V2 docs run caught a YAML scalar quoting issue; it was corrected before the passing run.
