---
id: 2026-10-02-snap-070-recorded-session-harness
title: Keyless recorded-session snapshot harness
status: implemented
owners: [test-support, quality]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/test-support, snapshots, package-scripts, docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n]
supersedes: []
---

# Agent Note: Keyless recorded-session snapshot harness

## Problem

The repository has deterministic mock providers and Runtime integration fixtures, but no top-level recorded-session fixture format or runner. P7 requires ordinary replay to work without credentials, and requires fixture creation/refresh to be explicit and sanitized. Snapshot layout and update commands also need a reviewable boundary before CI depends on them.

## Current state

- `@tracegraph/test-support` exports a zero-network `ScriptedMockProvider`, temporary Runtime data helpers, and controlled workspaces.
- Integration tests verify Runtime behavior in-process, but there is no root `snapshots/` fixture tree or mode-aware snapshot command.
- The recorded-session layout in `docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/03-recorded-session-snapshots.md` remains proposed and includes broader scenarios than SNAP-070.

## Proposal

Add a narrow top-level harness to `@tracegraph/test-support` and one synthetic Runtime completion fixture. The fixture uses strict JSON metadata, a recorded `ScriptedMockProvider` response, a semantic expected projection, and a redaction review file. Replay uses only the checked-in response script and never initializes a network provider or reads API-key environment variables.

Expose explicit `replay`, `record`, and `refresh` modes. `record` imports a caller-selected JSON capture into a new case directory; this first increment does not connect to a live provider or capture a real user's Session. `refresh` re-runs the recorded inputs and only replaces expected output when `--write` is present. Both write modes require an explicit destination/identity, reject overwriting a case during record, validate strict schemas and run the redaction gate before writing. `replay` is read-only.

SNAP-071 owns recovery/cancel/Memory/subagent fixtures and assertions over workspace outcomes. A live Session exporter, broad format migration, snapshot UI replay, and automatic baseline promotion are deferred.

## Alternatives considered

- Vitest snapshots alone: they do not separate replay from explicit capture/import and refresh policies, and encourage updating expected values without the fixture-level redaction gate.
- Direct live-provider recording in the first slice: it would couple the baseline to credentials/network and exceed the current acceptance scope; importing a selected offline capture keeps CI replay keyless.

## Invariants and boundaries

- Replay is deterministic and read-only; it cannot create a provider client, access a live credential store, or rewrite fixture files.
- `record` and `refresh` are never the default mode and require `--write` to persist output.
- Fixture schemas are strict and bounded. Secret-bearing field names, common credential/token patterns, personal absolute paths, and private-key blocks fail closed before persistence.
- Expected output pins stable semantic fields (terminal status/outcome and ordered canonical event types/summaries) while excluding volatile IDs, timestamps, machine paths, and hidden model reasoning.
- Snapshots are test evidence, not product data or an alternate Event Ledger.

## Migration and rollback

No Runtime or persisted product format changes. Existing tests remain valid. Removing the runner or fixture is safe; CI replay can be disabled independently, and no fixture data is migrated into user state. Future fixture schema versions must remain explicit and be handled by a separate compatibility change.

## Acceptance criteria

- [x] Checked-in synthetic Runtime snapshot replays in an isolated process with no provider-key environment variables and produces the pinned semantic output.
- [x] Replay is read-only; unknown/missing modes fail without writing.
- [x] Record creates only a new case from an explicit input and write target; refresh changes expected output only with explicit `--write`.
- [x] Schema bounds and secret/path redaction checks reject unsafe source data before creating or replacing a fixture.
- [x] Test-support, root runner command, CI replay, owning docs, and paired Notes describe the same behavior and deferred scope.

## Risks and open questions

- The initial semantic projection is intentionally small; it must not be mistaken for coverage of recovery, cancellation, Memory, subagents, workspace writes, or UI behavior.
- Importing an offline capture is not a live recorder. A future real-session exporter must define consent, source authority, and redaction before it is added.

## Evidence

- Implementation: `packages/test-support/src/recorded-session/` provides strict schemas, bounded redaction checks, CLI modes, deterministic Runtime replay and semantic diff. The accepted synthetic case is `snapshots/runtime/minimal-completion/`; record candidates are ignored under `snapshots/candidates/`.
- Tests: test-support typecheck passed; all 62 test-support tests passed, including five snapshot harness cases for keyless child-process replay, read-only/mode failures, explicit record, credential/path redaction, checked-in model-stream field redaction, no overwrite, and refresh behavior. One existing timeout assertion was narrowed to the Tool receipt because retry-policy metadata also contains the word `timeout`.
- Verification: root `pnpm typecheck`, `pnpm test:engineering`, `pnpm verify:v2-docs`, `pnpm verify:package-readmes`, `pnpm verify:boundaries`, `pnpm graph:modules:check`, `pnpm snapshots replay --case runtime/minimal-completion`, and `git diff --check` passed. An attempted root `pnpm test` fails in the Core subagent capacity test (`ProjectionError: subagent concurrency exceeds 1`); the root script now runs the SNAP-070 replay immediately after build, before recursive package tests. The test-support suite passed independently.
