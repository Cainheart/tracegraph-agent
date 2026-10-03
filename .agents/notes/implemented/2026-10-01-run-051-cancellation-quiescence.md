---
id: 2026-10-01-run-051-cancellation-quiescence
title: Fence Runtime dispatch and settle owned cancellation jobs
status: implemented
owners: [runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, tools, sandbox]
supersedes: []
language: en
---

# Agent Note: Fence Runtime dispatch and settle owned cancellation jobs

## Problem

Durable cancellation already aborts the Run signal and prevents later control mutations. The Tool wrapper can return on abort before the underlying executor settles, however, and the POSIX process runner currently resolves when its group leader closes even if a descendant remains alive. A `run.cancelled` fact can therefore precede proof that Runtime-owned work has stopped.

## Current state

Runtime owns a per-Run `AbortController`, serializes durable user input through the Event Ledger, gates `tool.started`, and uses a cancellation shield for irreversible writes and child launch. The model loop and generic Tool executor race work against the abort signal. `run_test` uses a detached POSIX process group with TERM-to-KILL escalation, but its promise observes the group leader rather than all descendants. See [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md), [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts), [`packages/tool executor`](../../../packages/tool/src/executor.ts), and [`process-runner.ts`](../../../packages/core/src/seams/sandbox/process-runner.ts).

## Implemented decision

Each Run now owns a process-local `CancellationController`. Its synchronous fence admits and registers model, approval-answerer, and actual Tool executor promises, including executor work that outlives the Tool wrapper's abort race. Durable cancel fences future dispatch and aborts active work. The finalizer waits up to 1,000 ms for tracked jobs; if any remain, it keeps the durable cancel pending and retries when the last job settles. Explicit recovery can finish a pending cancel in a new Host process because the prior process and its owned jobs have exited. Legacy `stop` uses the same quiescence wait before terminalization.

The POSIX process runner retains its process-group identity after the direct child closes, sends SIGTERM and then SIGKILL after a 250 ms grace period, and resolves only after the group is gone. It also reclaims descendants left behind by a normally exiting group leader. Tool execution may return a bounded abort result to its caller while the controller separately tracks the underlying executor until it settles.

### Deferred

Cross-Host cancellation locks, forcefully stopping arbitrary in-process JavaScript that ignores AbortSignal, Windows descendant process-tree enforcement, and a new public cancellation-progress event remain deferred. An uncooperative in-process job can keep a Run in durable cancellation-pending state until it settles or the Host restarts; Runtime must not claim `run.cancelled` while that job is still owned.

## Alternatives considered

- Treat `AbortController.abort()` as proof of cancellation: rejected because abort is a request and does not prove executor or descendant settlement.
- Wait indefinitely inside the cancellation command: rejected because the caller needs a bounded response. The durable cancel remains pending after the bounded wait and is finalized later when safe.

## Invariants and boundaries

- The Event Ledger remains the durable source for cancel intent and terminal outcome.
- The controller is volatile per-Run state; after restart, recovery may infer old process jobs are gone only because the owning Host process has exited.
- Dispatch admission and cancellation fencing have a single synchronous linearization point in the Runtime process.
- `run.cancelled` is appended only after the controller reports no active owned jobs; cancellation shields still settle their irreversible durability boundary first.
- POSIX `run_test` completion proves the spawned process group has been reclaimed. This is not a Host container or a cross-process lock.

## Migration and rollback

No persisted Event schema or user command changes. Rollback can restore the direct AbortController and existing executor wrapper; historical cancel inputs and terminal Events remain replayable. Process cleanup changes are local to the bounded runner.

## Acceptance criteria

- [x] No model, approval-answerer, or Tool executor dispatch begins after cancellation fences the Run.
- [x] A durable cancel does not append consumption or `run.cancelled` while a tracked job remains active; it finalizes after the job settles.
- [x] POSIX process-group cleanup kills descendants that ignore SIGTERM and does not resolve until the group is gone.
- [x] Recovery finishes a durable pending cancellation without dispatching model or Tool work.
- [x] Current Runtime documentation and the RUN-051 roadmap row describe verified behavior and the uncooperative-job limit.

## Risks and open questions

Arbitrary third-party executors can ignore AbortSignal and never settle. The safe behavior is to preserve the pending cancellation rather than publish a false terminal proof. The controller is local to one Runtime process and does not coordinate concurrent Hosts.

## Evidence

- Implementation: [`cancellation-controller.ts`](../../../packages/core/src/domains/runtime/cancellation-controller.ts), [`agent-loop.ts`](../../../packages/core/src/domains/runtime/agent-loop.ts), [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts), [`packages/tool executor`](../../../packages/tool/src/executor.ts), and [`process-runner.ts`](../../../packages/core/src/seams/sandbox/process-runner.ts)
- Tests: [`cancellation-controller.test.ts`](../../../packages/core/src/domains/runtime/cancellation-controller.test.ts), [`runtime.steering.test.ts`](../../../packages/core/src/domains/runtime/runtime.steering.test.ts), [`runtime.subagent.test.ts`](../../../packages/core/src/domains/runtime/runtime.subagent.test.ts), [`memory-g21.test.ts`](../../../packages/core/src/domains/memory/memory-g21.test.ts), and [`process.test.ts`](../../../packages/core/src/seams/sandbox/process.test.ts)
- Documentation: [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md) and [implementation roadmap](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- Verification: `pnpm --filter @tracegraph/core test:unit` passed (54 files, 438 tests); `pnpm --filter @tracegraph/tool test:unit` passed (3 files, 24 tests); Core and Tool builds and typechecks passed; `pnpm verify:v2-docs`, `pnpm verify:boundaries`, `pnpm verify:invariants`, `pnpm verify:package-readmes`, and `git diff --check` passed.
