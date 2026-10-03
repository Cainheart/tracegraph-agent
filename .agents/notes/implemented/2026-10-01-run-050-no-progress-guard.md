---
id: 2026-10-01-run-050-no-progress-guard
title: Stop repeated Runtime tool loops when they produce no new evidence
status: implemented
owners: [runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [runtime, event-ledger]
supersedes: []
language: en
---

# Agent Note: Stop repeated Runtime tool loops when they produce no new evidence

## Problem

The current Agent Loop stops at its hard turn limit, but it does not identify a shorter loop in which the model repeats the same Tool calls and receives the same observations. This can spend several model turns without advancing the task.

## Current state

Before RUN-050, `AgentLoopCoordinator` relied on finish, existing failure, cancellation, or `maxTurns`. It now computes hash-only progress fingerprints after successful Tool turns and applies the Runtime policy before the next model request. The current behavior is documented in [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md).

## Implemented decision

The Runtime-owned, process-local progress tracker records hashed normalized Tool-call identities and normalized outcome evidence after each successful Tool turn. It also hashes workspace patch facts, LSP diagnostics, and Todo state when those signals are present. Raw arguments and Tool output are not copied into the progress fingerprint.

The default policy uses a four-turn window, requires at least three consecutive turns without novel normalized evidence, and requires at least half of calls in that window to repeat. These values are configurable through the trusted `AgentRuntimeOptions.noProgressPolicy` composition seam. A queued user message clears the no-progress window and evidence deduplication set; queued steering gets a safe point before a stop. User-approved Plan/Patch transitions also clear the window.

When the policy trips, the Run ends with `run.failed` and failure code `no_progress_detected`. Its summary explains that repeated Tool work produced no new evidence. Bounded terminal data records the active policy, recent-turn count, repeat ratio, and the latest hash-only ProgressFingerprint so the stop can be inspected without exposing raw arguments or output.

## Deferred

Adaptive policy learning, model reflection/escalation before stopping, CLI profile configuration, and reconstructing the transient window after a process restart remain deferred. The existing hard turn budget remains active in every configuration.

## Alternatives considered

- Stop on the first repeated Tool signature: rejected because a legitimate iteration may reread a source or retry after evidence changes.
- Keep only the hard turn budget: rejected because it allows a finite but unproductive loop to consume the full budget.

## Invariants and boundaries

- The guard runs after successful Tool outcomes and before another model turn; existing cancellation, error, approval, and side-effect settlement paths retain ownership.
- Novel normalized Tool outcome evidence resets the consecutive no-progress count. A call signature alone never stops a Run.
- The policy is trusted Runtime configuration; model output and client requests cannot tune it.
- Progress hashes are diagnostic fingerprints, not proof of business success or workspace correctness.

## Migration and rollback

The additive `run.failed` failure code uses the existing terminal Event envelope and does not change old Ledger parsing. Rollback consists of removing the loop guard and option while retaining historical terminal Events as ordinary failed Runs.

## Acceptance criteria

- [x] Identical repeated Tool work with unchanged outcomes stops with an inspectable `no_progress_detected` failure.
- [x] Distinct actions or changed outcomes continue without a false stop.
- [x] A user message resets the no-progress window.
- [x] The hard turn budget and existing failure/cancellation behavior remain unchanged.
- [x] Core runtime docs describe the shipped policy and limitations.

## Risks and open questions

Normalized evidence is intentionally conservative: changing result content can make equivalent outcomes look new, delaying a stop. The hard turn budget remains the final bound. The in-memory window resets after process restart; durable cross-restart detection can be evaluated separately if recovery scenarios require it.

## Evidence

- Implementation: [`agent-loop.ts`](../../../packages/core/src/domains/runtime/agent-loop.ts), [`no-progress-guard.ts`](../../../packages/core/src/domains/runtime/no-progress-guard.ts), and [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts)
- Tests: [`no-progress-guard.test.ts`](../../../packages/core/src/domains/runtime/no-progress-guard.test.ts) and [`runtime.steering.test.ts`](../../../packages/core/src/domains/runtime/runtime.steering.test.ts)
- Documentation: [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md) and [implementation roadmap](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md)
- Verification: `pnpm --filter @tracegraph/core build`; `pnpm --filter @tracegraph/core typecheck`; `pnpm --filter @tracegraph/core test:unit` (434 passed); `pnpm verify:v2-docs` (11 manifest documents, 64 roadmap tasks)
