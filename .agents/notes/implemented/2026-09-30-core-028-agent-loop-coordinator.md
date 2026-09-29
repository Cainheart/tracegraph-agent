---
id: 2026-09-30-core-028-agent-loop-coordinator
title: Extract the model turn loop behind an explicit Runtime port
status: implemented
owners: [runtime]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [core-runtime, agent-loop, ledger, approval, workspace]
supersedes: []
---

# Agent Note: Extract the model turn loop behind an explicit Runtime port

## Problem

`packages/core/src/domains/runtime/runtime.ts` still contains the entire model
turn loop, including turn-budget checks, Context assembly, model request and
Decision validation, Tool batch authorization, scheduling, and terminal/failure
decisions. The large inline loop obscures the coordinator's responsibility and
makes its stateful seams harder to review. CORE-025 through CORE-027 already
provide transition functions, service façades, and generic feature contributions.

## Current state

- `AgentRuntimeImpl.#continueRun` is an approximately 795-line private method
  in a roughly 10,280-line `runtime.ts`.
- The method already uses the extracted Run/Turn/Step transitions, curated
  Context/Tool/Evidence façades, and `RuntimeFeatureDriverRegistry`.
- Runtime owns canonical Ledger writes, approval timing, per-Run control locks,
  model-surface publication, external workspace authority, and failure handling.

## Implemented decision

- Moved turn orchestration into `packages/core/src/domains/runtime/agent-loop.ts`
  as `AgentLoopCoordinator.continueRun()`. `AgentRuntimeImpl` composes the
  coordinator with an explicit typed port and delegates every continuation to
  it. The coordinator owns no independent state store or authority.
- `runtime.ts` decreased from 10,280 to 9,506 lines. The extraction also moved
  the shared Tool execution types into the loop module.
- Keep turn sequencing, Context and model request behavior, full-batch Tool
  validation, approval decisions, event order, failure policy, and all existing
  state mutations unchanged. This is extraction only.
- Keep Ledger ownership, control mutexes, terminal writes, workspace authority,
  Tool execution implementation, recovery, and public Runtime commands owned by
  `AgentRuntimeImpl`; the loop calls those through bound ports.
- The coordinator must have no independent persistence, workspace, approval,
  or retry authority. It may only use the same Runtime callbacks and façades
  used before extraction.

## Invariants

- The canonical Event Ledger remains the source of Run facts. Appended event
  types, ordering, idempotency keys, and projection/replay meaning do not change.
- User input/cancellation, approval timing, Tool batch atomic authorization,
  Run locking, and terminal-state checks retain their current order.
- Tool effects still pass through the Runtime policy, approval, action WAL, and
  workspace boundaries. No direct external side effect is introduced.
- A Runtime failure still fails closed through the same terminal event path.

## Acceptance criteria

- [x] `runtime.ts` delegates turn continuation to `AgentLoopCoordinator` and
      loses 774 lines; the typed port lists the coordinator dependencies.
- [x] Core focused/integration tests, CLI vertical E2E, and Ledger replay pass.
      The CLI scenario confirms the workspace stays unchanged while approval is
      pending, applies the approved patch, and returns the same replay timeline.
- [x] Existing canonical event ordering, approval boundary, cancellation, and
      unknown-side-effect behavior remain covered by the Core and CLI suites.
- [x] Current Core documentation describes the responsibility boundary.

## Evidence

- Implementation: `packages/core/src/domains/runtime/agent-loop.ts` and the
  bound Runtime port in `packages/core/src/domains/runtime/runtime.ts`.
- Focused coverage: `packages/core/src/domains/runtime/runtime-feature-drivers.test.ts`
  keeps the extracted loop on generic feature contributions; the full Core
  suite also covers approval, steering/cancellation, recovery, and Ledger
  behavior in the existing Runtime suites.
- Vertical and replay scenarios: `apps/cli/src/e2e.test.ts` and
  `evals/replay/time-travel.eval.ts`.
- Tests: Core unit suite passed (44 files, 416 tests); CLI vertical E2E passed
  (4 tests); `evals/replay/time-travel.eval.ts` passed (1 test).
- Verification: workspace `pnpm typecheck`; `pnpm test:engineering` (47 Node
  tests, 8 Vitest tests); boundary, invariant, package README, V2 docs, module
  graph, generated baseline, and `git diff --check` gates passed.
- Existing eval metric files (8) and `latest.json` were backed up before the
  replay eval and restored; directory comparisons confirmed identical content.
- Documentation: `packages/core/README.md`, `docs/modules/02-Agent-Runtime.md`,
  the P2 implementation roadmap, and generated module graph/current baseline.

## Migration and rollback

Move the existing loop body without rewriting its decisions, inject the
existing Runtime operations as ports, then compare the narrow Core, CLI, and
Ledger replay evidence. Rollback restores the prior private method body and
removes the coordinator composition; no persisted data or public contract
changes are required.

## Deferred

- Moving Tool execution, policy implementation, approval workflows, Action WAL,
  recovery, or public Run commands out of `runtime.ts`.
- Changing event schemas, tool scheduling, prompt composition, or model
  behavior.
- Adding new retry, checkpoint, recording, or refresh behavior.
