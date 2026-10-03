---
id: 2026-10-02-snap-071-core-recorded-scenarios
title: Core recorded-session scenarios
status: implemented
owners: [test-support, snapshots]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [SNAP-070, SNAP-071]
supersedes: []
---

# Agent Note: Core recorded-session scenarios

## Problem

SNAP-070 replays only a minimal completion and compares its semantic Run events. SNAP-071 requires recorded recovery, cancellation, Memory recall, and subagent scenarios, with both event and workspace outcomes checked.

## Current state

The bounded fixture harness now has five accepted synthetic Runtime cases. See `packages/test-support/src/recorded-session/` and `snapshots/{runtime,memory}/`.

## Implemented decision

Keep the SNAP-070 command and five-file fixture layout. Add four strict scenario IDs and finite scripted inputs for restart/resume from approval, user cancellation of a blocked provider request, reviewed Memory recall, and one bounded readonly subagent. Extend expected output with sorted before/after workspace entries containing relative paths and content digests; replay compares these alongside ordered semantic events. All accepted fixtures remain synthetic, bounded, secret-scanned, and read-only during replay.

### Target

- Run each scenario through the real Runtime with the existing offline provider and fixture sandbox.
- Record stable event type/summary pairs and workspace entry kind/path/content digest before and after.
- Show event and workspace differences in refresh output while preserving explicit `--write` behavior.

### Deferred

- Live-session export, real-user captures, UI replay, arbitrary tool scripts, and mutation snapshots requiring third-party code or credentials.
- OS-level crash injection; recovery replay exercises the durable interrupted/resume path with synthetic data.

## Alternatives considered

- Keep a single completion-only scenario: rejected because it cannot satisfy SNAP-071's four required areas.
- Compare only event output: rejected because it cannot detect a workspace mutation that leaves the event summary unchanged.

## Invariants and boundaries

- Runtime/Ledger remains authoritative; expected fixture data is an offline regression oracle only.
- Snapshot scripts and files remain schema-bounded and redaction-gated. Workspace paths are relative; content is represented only by SHA-256 digests.
- Recovery and cancellation controls are selected by scenario ID, not by arbitrary executable fixture input.
- The existing minimal-completion capture importer remains available and never overwrites an accepted case.

## Migration and rollback

Regenerate the accepted minimal fixture under the new expected-output schema and add four synthetic fixtures. Rollback removes the four cases and returns the harness schema/runner to the SNAP-070 schema; no product data or user workspace is changed.

## Acceptance criteria

- [x] Each of the four cases exercises its named Runtime behavior and asserts ordered semantic events.
- [x] Replay independently compares before/after workspace manifests; expected and actual event/workspace differences are readable.
- [x] Snapshot read remains bounded, strict, redacted, and non-writing; root `pnpm test` replays every accepted case.
- [x] Owning docs and implementation roadmap describe the delivered boundary and known limits.

## Risks and open questions

Event summaries and synthetic workspace manifests can drift with intentional Runtime changes; refresh remains review-only unless `--write` is explicit.

## Evidence

- Implementation: [`runner.ts`](../../../packages/test-support/src/recorded-session/runner.ts), [`schema.ts`](../../../packages/test-support/src/recorded-session/schema.ts), root `test:snapshots` script.
- Tests: [`runner.test.ts`](../../../packages/test-support/src/recorded-session/runner.test.ts), five accepted fixtures under `snapshots/`.
- Verification: `pnpm test` passed, including build, all five accepted snapshot replays, all workspace package unit tests, and engineering gates; Core passed 56 files / 457 tests and test-support passed 4 files / 67 tests.
