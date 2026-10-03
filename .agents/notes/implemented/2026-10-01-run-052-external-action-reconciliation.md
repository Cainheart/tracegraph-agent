---
id: 2026-10-01-run-052-external-action-reconciliation
title: Reconcile uncertain external actions through a typed provider contract
status: implemented
owners: [evidence-runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, tools, events, recovery]
supersedes: []
language: en
---

# Agent Note: Reconcile uncertain external actions through a typed provider contract

## Problem

Action WAL recovery currently proves filesystem outcomes for `commit_patch`. A tool that talks to another system can time out after dispatch or lose its Host process after `tool.started`; Runtime has no provider seam to query that external state, and must not infer success or failure from transport status.

## Current state

`tool.started` persists the Runtime-owned operation identity and bounded tool name. Tool execution now receives that Run-scoped `operationId`; filesystem Action WAL recovery remains specific to `commit_patch`. Raw Tool results can be `unknown`; the optional Host reconciler adds a query path for configured external Tools without changing their execution or retry behavior. See [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md), [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts), and [`definition.ts`](../../../packages/tool/src/definition.ts).

## Implemented decision

`AgentRuntimeOptions.externalActionReconciler` accepts a Host-owned provider ID, an immutable snapshot of supported Tool names, and a read-only `reconcile()` callback. Runtime passes the canonical `operationId` from `tool.started` into `ToolExecutionContext`; providers combine it with project/Run identity for external correlation. Recovery queries supported operations when `tool.started` has no terminal result, or a Tool ends unknown, times out, or is cancelled. Requests contain Run/action/operation identity and trigger state, not raw Tool arguments or credentials.

Provider outcomes become Ledger facts. `confirmed` means the expected postcondition is evidenced; `failed` means the provider evidences non-application; both require an evidence digest and close automatic reconciliation. `unknown` records uncertainty and can be queried later without re-executing the Tool. `diverged` or a result for another operation identity writes sticky `action.diverged` for manual review. Provider exceptions, timeouts, and invalid results map to `unknown`. The query deadline defaults to 5 seconds and is Host-configurable up to 30 seconds. This remains separate from Action WAL patch recovery.

One repository-controlled provider exercises the four outcomes end to end, including recovery through a fresh Runtime instance. The contract does not add an external Agent Adapter or a general retry policy.

### Deferred

External provider implementations, credentials and capability onboarding, generic action execution retries, public UI for reconciliation, cross-Host provider coordination, and Langfuse evaluation remain deferred. `unknown` never authorizes blind action replay.

## Invariants and boundaries

- Event Ledger tool lifecycle remains the durable source for dispatch identity; the operation ID is minted/canonicalized by Runtime.
- Reconciliation reads provider state and never re-executes the action.
- Only a Host-configured reconciler may classify the Tool names it explicitly supports.
- `unknown` stays unknown and may be queried again; `diverged` is sticky and cannot silently return to ordinary execution.
- Provider output is schema-validated and bounded before it enters the Ledger.
- A digest binds the provider's evidence bytes but does not authenticate a provider; provider configuration remains a Host trust boundary.

## Acceptance criteria

- [x] A custom Tool receives its stable Runtime-generated `operationId`.
- [x] Recovery after Host restart finds unresolved supported operations from durable events and leaves unsupported tools untouched.
- [x] A controlled provider produces durable `confirmed`, `failed`, `unknown`, and `diverged` outcomes end to end.
- [x] Reconciliation never re-dispatches the Tool; an `unknown` action can be queried again, and `diverged` enters manual review.
- [x] Current Runtime documentation and RUN-052 roadmap row describe the implemented boundary.

## Evidence

- Implementation: [`action-reconciliation.ts`](../../../packages/contracts/src/action-reconciliation.ts), [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts), [`definition.ts`](../../../packages/tool/src/definition.ts)
- Tests: [`action-reconciliation.test.ts`](../../../packages/contracts/src/action-reconciliation.test.ts), [`runtime.external-action-reconciliation.test.ts`](../../../packages/core/src/domains/runtime/runtime.external-action-reconciliation.test.ts)
- Documentation: [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md), [`@tracegraph/tool README`](../../../packages/tool/README.md), and [implementation roadmap](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- Verification: Core 55 files / 446 tests passed; Contracts 27 files / 176 tests passed; Tool 3 files / 24 tests passed. Contracts/Tool/Core builds and typechecks passed. `pnpm verify:v2-docs`, `pnpm verify:boundaries`, `pnpm verify:invariants`, `pnpm verify:package-readmes`, and `git diff --check` passed.
