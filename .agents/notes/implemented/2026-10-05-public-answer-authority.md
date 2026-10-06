---
id: 2026-10-05-public-answer-authority
title: Durable task outcomes take precedence over answer drafts
status: implemented
owners: [workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [packages/workbench, packages/sdk/client/locale]
supersedes: []
---

# Agent Note: Durable task outcomes take precedence over answer drafts

[中文](2026-10-05-public-answer-authority.zh.md)

## Problem and current state

ChatTurn currently selects the last volatile answer_snapshot before its durable response, including after completion or failure. The same candidate can remain visible after its model.decision while delivery review and verification continue. Its progressive text cursor can also survive a terminal transition. This allows a rejected or stale success statement to look like the final answer.

## Accepted narrow scope

The parent authorized this presentation fix. Terminal and paused task states display only their durable response/status projection. A live answer is an explicitly unverified draft with no formal copy or feedback actions. A candidate is hidden once its model call has a canonical decision, failure or cancellation, or a newer canonical model request is present. Model operation identities are paired; surface cursors and ledger sequence numbers are not compared. With no model operation evidence, a compatible old Host can still display the public text as a draft. Private thinking remains excluded.

A live-to-terminal transition replaces the draft immediately; it does not animate a stale candidate to completion. Delivery reviews remain ordinary public facts, never an inferred success state. The existing TraceEvent projection preserves model call identity but not arbitrary delivery command data; settling the corresponding model call is sufficient to hide the first finish candidate before its delivery review.

The parent authorized a narrow follow-up after the independent UI audit: a completed, historical or ready-for-review projection without an outcome must use neutral missing-response text. A terminal event alone does not establish generated or verified results. The retained answer candidate cannot fill that gap. Controlled negative fixtures cover both languages and a real-shaped canonical completion without verification facts; installed acceptance remains separate.

## Alternatives and boundaries

Keeping a completed answer_snapshot as fallback was rejected because it is volatile and precedes delivery acceptance. Hiding all public streaming text was rejected because ordinary knowledge answers should remain readable while running. Runtime acceptance rules, model adapters, SDK transports and stored history are unchanged. No paid-model, installed GUI or full roadmap acceptance is inferred from component tests.

## Migration and rollback

No persisted schema or wire format changes. Previously retained surface payloads remain parseable but cannot override terminal results. Reverting this component restores the incorrect authority order and is not a safe product fallback.

## Acceptance criteria

- [x] Completed durable answer and failed durable error override conflicting answer snapshots.
- [x] A finish candidate disappears while delivery review/repair remains active; no formal answer actions are present.
- [x] Ordinary public streaming text remains visible as an unverified draft and becomes the durable result on completion.
- [x] A mounted live-to-terminal transition immediately displays the durable result, including with progressive painting enabled.
- [x] Missing outcomes use neutral text in both languages; a canonical terminal without verification evidence does not imply verified results.
- [x] Owning current module and bilingual verification evidence reflect the narrow source-level scope.

## Evidence

Implementation and verification are source-level complete. [Bilingual verification](../../../docs/validation/public-answer-authority/README.md) records 15 before-fix failures; final 3 files/29 tests, Workbench types and 11 locale tests passed. No provider/GUI request was used; installed acceptance remains separate. Source owner: [WorkbenchStates](../../../packages/workbench/src/components/WorkbenchStates.tsx); existing tests: [WorkbenchStates tests](../../../packages/workbench/src/components/WorkbenchStates.test.tsx).

The missing-outcome follow-up retains three actual before-fix failures. Two focused files / 28 tests and Workbench types passed after neutral copy replaced the unsupported verification claim. These counts supplement, rather than replace, the original receipt; no build or installed acceptance ran in this follow-up.
