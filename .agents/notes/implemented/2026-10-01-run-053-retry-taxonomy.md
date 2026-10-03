---
id: 2026-10-01-run-053-retry-taxonomy
title: Separate bounded provider retries from Tool and Action dispatch
status: implemented
owners: [runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, contracts, events, tools, recovery]
supersedes: []
language: en
---

# Agent Note: Separate bounded provider retries from Tool and Action dispatch

## Problem

Retrying a transient model transport failure, replaying a Tool, and re-executing an uncertain external Action have different safety properties. A shared retry loop could duplicate a side effect or conceal an unknown result.

## Current state

Runtime records a bounded retry taxonomy in each `model.request_started`. Tool execution has a one-dispatch policy; external Action uncertainty is handled by RUN-052's read-only reconciliation contract. See [`agent-loop.ts`](../../../packages/core/src/domains/runtime/agent-loop.ts), [`retry-policy.ts`](../../../packages/core/src/domains/runtime/retry-policy.ts), [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts), and the [Runtime module guide](../../../docs/modules/02-Agent-Runtime.md).

## Implemented decision

The model Provider gets at most three attempts for a `ModelRequestError` with an explicit transient HTTP or transport code. The deterministic exponential delays are 250 ms and 500 ms, with a 1,000 ms policy ceiling. Runtime does not retry arbitrary adapter errors, permanent HTTP responses, invalid Decisions, cancellations, or a request attempt that has already reported usage. `model.retry_scheduled` durably records the retry number, reason class, and actual delay. The final `model.decision` or `model.request_failed` records total attempts and delays. Cancellation aborts the delay and RUN-051's controller gates every next dispatch.

Tool executor calls are never automatically replayed; a failed Tool ends the Run. A new model-authored Tool call is a separate Action governed by the Run turn budget, policy, unique action identities, and RUN-050 no-progress guard. Each canonical Action operation is dispatched once. An unknown external result may only be queried through RUN-052 reconciliation. Patch WAL recovery remains separately bounded by its one automatic recovery attempt. Retry timers are in-process and are not resumed after Host restart.

### Deferred

Automatic Tool replay, blind Action replay, jitter or `Retry-After` support, provider-specific retry overrides, and durable retry scheduling across process restarts.

## Invariants and boundaries

- Only allowlisted transient `ModelRequestError` codes can schedule a provider retry.
- A valid provider usage report closes the retry window for that attempt.
- Each Tool dispatch has one `tool.started` and one terminal Tool Event; there is no executor replay loop.
- Unknown external Action state authorizes reconciliation queries only, never redispatch.
- Retry facts use the canonical Session Event Ledger; live activity and Telemetry are projections.

## Migration and rollback

The new `model.retry_scheduled` Event is appended to the existing Event type list. Existing Event payloads remain readable and Projection version does not change because the new fact does not alter a replayed projection. Disabling the provider retry loop restores one-shot model calls without requiring a data migration.

## Acceptance criteria

- [x] Transient model failures retry at most three times with exact durable backoff facts.
- [x] Permanent, untyped, usage-reported, invalid-output, and cancelled requests do not retry.
- [x] Tool dispatch and Action execution remain single-attempt; unknown Action results only reconcile.
- [x] The retry Event contract is validated and projected as safe live activity and Telemetry.
- [x] Runtime documentation and RUN-053 roadmap row describe the delivered behavior.

## Evidence

- Implementation: [`retry-policy.ts`](../../../packages/core/src/domains/runtime/retry-policy.ts), [`agent-loop.ts`](../../../packages/core/src/domains/runtime/agent-loop.ts), [`event.ts`](../../../packages/contracts/src/event.ts), [`retry.ts`](../../../packages/contracts/src/retry.ts), [`runtime-telemetry.ts`](../../../packages/core/src/domains/runtime/runtime-telemetry.ts)
- Tests: [`retry-policy.test.ts`](../../../packages/core/src/domains/runtime/retry-policy.test.ts), [`runtime.usage.test.ts`](../../../packages/core/src/domains/runtime/runtime.usage.test.ts), [`runtime.telemetry.test.ts`](../../../packages/core/src/domains/runtime/runtime.telemetry.test.ts), [`retry.test.ts`](../../../packages/contracts/src/retry.test.ts), and the existing [`runtime.external-action-reconciliation.test.ts`](../../../packages/core/src/domains/runtime/runtime.external-action-reconciliation.test.ts)
- Documentation: [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md) and the [implementation roadmap](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- Verification: Contracts 28 files / 177 tests passed; Core 56 files / 455 tests passed. Contracts/Core builds and typechecks passed. `verify:v2-docs`, `verify:boundaries`, `verify:invariants`, `verify:package-readmes`, `graph:modules:check`, and `git diff --check` passed.
