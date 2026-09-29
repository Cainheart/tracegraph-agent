---
id: 2026-09-30-core-025-extract-run-turn-step-state-machine
title: Extract pure Run, Turn, and Step transitions
status: implemented
owners: [runtime]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [core-runtime, runtime-behavior, architecture]
supersedes: []
---

# Agent Note: Extract pure Run, Turn, and Step transitions

## Problem

`packages/core/src/domains/runtime/runtime.ts` owns loop progression decisions
alongside model/tool orchestration and Ledger writes. Turn-budget exhaustion,
finish handling, and durable user-input step numbering are embedded in
imperative control flow, making their transition table and compatibility
constraints difficult to test independently.

## Current state

- [run-state-machine.ts](../../../packages/core/src/domains/runtime/run-state-machine.ts)
  has pure turn-start, finish, and user-input-step transitions.
- [runtime.ts](../../../packages/core/src/domains/runtime/runtime.ts) uses
  those decisions. It still owns `RunState`, control locking, Ledger I/O,
  projections, event/error construction, and orchestration effects.
- [run-state-machine.test.ts](../../../packages/core/src/domains/runtime/run-state-machine.test.ts)
  covers root/child turn budgets, pending-input precedence, execute and plan
  finish branches, valid/malformed consumed input data, and step exhaustion.
- [Agent Runtime module docs](../../../docs/modules/02-Agent-Runtime.md) and
  the implementation roadmap describe the extracted boundary and verification.
- Event Ledger remains the durable source of truth; `projectRun()` and
  `projectTodos()` remain the reconstruction paths.

## Implemented decision

- **Target delivered:** table-test turn start/budget decisions, finish
  decisions for execute/plan mode with pending input and Todo availability,
  and monotonic durable input-step advancement including exhaustion.
- The existing control-lock boundary, projection reads, idempotency keys,
  append sites, event payloads, event order, terminal codes/messages, and
  cancellation timing remain in Runtime unchanged.
- The extracted module decides progression only; it neither owns nor persists
  Run state.
- **Deferred:** splitting Runtime into service façades, changing event schemas,
  changing loop policy or public projections, and changing any event order.

## Alternatives considered

- Move the entire loop and its RunState into a new owner: rejected for this
  task because it expands the change surface and risks mixing state decisions
  with effectful orchestration.
- Leave the decisions inline and add only more integration tests: rejected
  because CORE-025 explicitly requires an independently table-tested state
  machine.

## Invariants and boundaries

- Event Ledger remains the sole durable fact source; no new persisted state or
  parallel event format is introduced.
- A queued input wins against a concurrently validated finish Decision.
- Cancellation is consumed before the next model turn and does not increment
  the completed model-turn count.
- Plan mode without Todos fails with `plan_missing_todos`; execute mode keeps
  the existing `run.completed` transition.
- Input `at_step` remains at least 1, monotonically greater than the last
  valid consumed step, and fails above 1,000,000 with the same Runtime error.
- Per-Run control serialization and all Ledger append ordering remain owned by
  Runtime.

## Migration and rollback

The pure runtime module now supplies the progression decisions while Runtime
retains all effects. No data migration was needed because persisted formats and
event payloads are unchanged. Rollback can revert the helper and Runtime
call-sites, then restore the corresponding module/roadmap docs and generated
source inventory.

## Acceptance criteria

- [x] Table-driven tests cover turn start and both root/child budget failures.
- [x] Table-driven tests cover pending-input precedence, execute completion,
      missing plan Todos, and ready plan Todos.
- [x] Table-driven tests cover input-step progression, malformed historical
      consumed-event data, and exhaustion.
- [x] Focused Runtime tests preserve event ordering, cancellation, finish
      races, plan behavior, subagent budgets, and recovery/replay behavior.
- [x] CLI vertical E2E and owning-module docs pass/update after behavior is
      verified.

## Risks and open questions

- Regression-sensitive timing is preserved and tested: `state.turn` advances
  only after steering input is consumed without cancellation.
- Finish checks remain inside the existing per-Run control mutex, preserving
  the submit-vs-terminal race guarantee.

## Evidence

- Implementation: pure transitions in `run-state-machine.ts`; production
  call-sites in `runtime.ts`; module/roadmap documentation updated.
- Tests: state-machine and focused Runtime suites passed (5 files, 72 tests);
  full Core unit suite passed (41 files, 402 tests); CLI vertical E2E passed
  (4 tests); Ledger replay coverage passed in the Core suite.
- Verification: full `pnpm typecheck`; `pnpm test:engineering` (47 Node tests,
  8 Vitest tests); invariants (165 source files); boundaries (12 packages, 20
  workspace dependencies, 1,303 import references); V2 docs (11 documents,
  62 tasks); package README contracts (12 packages); generated module graph
  and current baseline drift checks; `git diff --check`.
