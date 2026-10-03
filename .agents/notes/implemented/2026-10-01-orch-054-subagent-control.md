---
id: 2026-10-01-orch-054-subagent-control
title: Keep bounded subagent control and loss recovery in the root ledger
status: implemented
owners: [subagent-team, runtime]
created: 2026-10-01
last_reviewed: 2026-10-02
affects: [runtime, contracts, events, team, recovery]
supersedes: []
language: en
---

# Agent Note: Keep bounded subagent control and loss recovery in the root ledger

## Problem

Delegated Runs need a bounded Host-owned authority, visible capacity and status,
durable parent-to-child messages, budget receipts, and deterministic recovery.
Copying child timelines into the root or relaunching opaque child work after a
Host restart would create duplicate or ambiguous evidence.

## Current state

G-07 defines a trusted `SubagentRegistry`, independent child Run/Session/Ledger,
frozen delegation limits, step/token budgets, direct-child controls, and
hash-linked terminal receipts. G-08 stores Team roster, task, mailbox,
heartbeat, and loss facts in the coordinator Run's canonical Event Ledger.
The Runtime module guide documents these boundaries in [Subagent orchestration
and Team](../../../docs/modules/02-Agent-Runtime.md).

## Implemented decision

- The Host-owned registry resolves provider, role prompt/version/hash,
  allowlist, and budget ceiling. Model input selects only a profile name,
  bounded task packet, context scope, and requested budget.
- A fair process-local permit pool gates every child launch before its durable
  `subagent.started` fact. The Run freezes the parallelism/depth limits. The
  regression test submits three children at a limit of one and proves only one
  child enters execution at a time while all three complete.
- Follow-up correction (2026-10-02): terminal receipt recording is awaited
  before the permit is released. Returning its Promise without `await` ran the
  `finally` block early, allowing the next `subagent.started` to precede the
  prior terminal receipt even when provider calls themselves were serialized.
  The regression now checks both provider peak concurrency and root-ledger
  start/terminal ordering.
- The parent Event Ledger records the exact parent/child Run and Session link,
  resolved profile and budget, initial/direct `parent_agent` messages, and one
  terminal result with usage plus the child terminal Event id/hash. It does not
  copy the child timeline.
- `listSubagents`, `sendSubagentMessage`, and `interruptSubagent` are scoped to
  direct children. Terminal children reject new messages. Parent cancellation
  closes its active child before writing the parent terminal.
- Team facts, including `team.member_lost` and any task reopen, live in that
  same root Event Ledger. A loss or restart never reassigns a task or repeats a
  child model request. Recovery closes nonterminal child/descendant Runs and
  records the hash-linked parent receipt before the parent can resume or become
  terminal; an already-terminal child is reconciled from its canonical ledger.

## Alternatives considered

- Copying full child event timelines into the parent was rejected because the
  child Run Ledger is already canonical and duplication could diverge.
- Restarting nonterminal model work after a Host crash was rejected because
  the Runtime cannot prove that an interrupted provider request had no effect.

## Invariants and boundaries

- The root Run Event Ledger is the canonical evidence for delegation,
  messages, Team loss, and child terminal proof; child execution details remain
  in the child Run Ledger.
- Effective tools and budgets cannot exceed trusted Host profile, parent
  policy, or frozen Run limits.
- Capacity permits are process-local. On restart the Runtime first reconciles
  all inherited active links, so it does not treat stale permits as live work.
- This is local coordination, not a cross-host distributed scheduler.

## Migration and rollback

No persisted format or Event type changes are introduced by ORCH-054; the
existing strict G-07/G-08 Event schemas and empty legacy projections remain
compatible. The added capacity regression test and roadmap note can be reverted
without a data migration. Disabling the subagent/team features continues to
follow their existing Runtime feature gates.

## Acceptance criteria

- [x] Capacity is bounded and status can be reconstructed from root evidence.
- [x] Direct messages, frozen budgets, and child terminal proofs are durable.
- [x] Team member loss and recovery are represented in the root Run ledger.
- [x] Child and parent cancellation/restart recovery closes the lineage without
      silently replaying opaque model work.
- [x] Contracts, focused Runtime tests, and current module/roadmap docs agree.

## Evidence

- Implementation: [`subagent.ts`](../../../packages/core/src/domains/subagent/subagent.ts),
  [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts),
  [`team.ts`](../../../packages/core/src/domains/team/team.ts),
  [`subagent.ts` contracts](../../../packages/contracts/src/subagent.ts), and
  [`team.ts` contracts](../../../packages/contracts/src/team.ts).
- Tests: [`runtime.subagent.test.ts`](../../../packages/core/src/domains/runtime/runtime.subagent.test.ts),
  [`runtime.team.test.ts`](../../../packages/core/src/domains/runtime/runtime.team.test.ts),
  [`team.test.ts`](../../../packages/core/src/domains/team/team.test.ts),
  [`subagent-g07.test.ts`](../../../packages/contracts/src/subagent-g07.test.ts),
  and [`team-g08.test.ts`](../../../packages/contracts/src/team-g08.test.ts).
- Verification: focused Runtime suites passed (3 files / 32 tests); focused
  G-07/G-08 contract suites passed (2 files / 25 tests); Contracts and Core
  test typechecks passed. The corrected capacity regression and the full Core
  suite also passed on 2026-10-02 (56 files / 457 tests).
- Documentation: [`02-Agent-Runtime.md`](../../../docs/modules/02-Agent-Runtime.md)
  and the [implementation roadmap](../../../docs/outlive-agent-v2/09-implementation-roadmap/README.md).

## Deferred

Cross-host worker scheduling, a nonblocking durable worker handle, automatic
task reassignment after member loss, and replaying interrupted provider work.
