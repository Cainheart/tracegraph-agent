---
id: 2026-10-05-goal-099-shared-budget
status: implemented
date: 2026-10-05
language: en
---

# GOAL-099: durable approval and shared request admission

## Context

This slice follows the [product workbench plan](../proposed/2026-10-05-complete-product-workbench.md). A Goal must state user-observable done conditions and at least one finite time or token ceiling. A completed Run is evidence for review, not final Goal acceptance. Existing child budgets cannot enforce an aggregate ceiling across parent requests, provider retries, repairs, summaries, and children.

## Decision

Use canonical SessionEvent Ledger streams for versioned Goal proposals, commands, Run links and shared budget checkpoints. Approval binds one exact Goal revision. Starting or resuming is a separate human command. Recovery never autonomously reissues model requests or unknown writes. Explicit final acceptance alone marks the Goal completed.

Pass one trusted Core request-budget seam at Run admission and inherit it unchanged in child Runs. Before each actual provider HTTP dispatch, reserve a conservative text input bound and an enforced output limit, durably record the reservation, and apply the remaining time deadline. Settled validated usage can release unused reservation; absent or uncertain usage consumes the full reservation and blocks further dispatch pending review. Time and tokens are independent ceilings. Adapter types without this boundary fail closed for budgeted work. A timer fences dispatch and aborts active work rather than merely updating a later UI counter. Budgeted Goal Runs disable optional background derivation so it cannot incur untracked requests.

## Scope and compatibility

Goal input contains no credentials, arbitrary runtime policy, or unvalidated workspace paths. Host admission reuses current ConversationControl, registered project admission, permission snapshots, workspace coordinator and immutable model leases. Pause settles active Runs; new process recovery requires human resume with remaining budget. The first slice starts one approved execution Run and keeps its canonical results for final acceptance; an independent scheduling/cycle engine and external paid-provider billing quality remain separate obligations. Money is not an enforced ceiling until trustworthy pricing can be resolved.

The first accepted Run binds its canonical Session to the Goal snapshot. Human continuation reuses the Session and bounded public tasks/results from only its linked, scope-verified Runs. Private reasoning, raw Tool/Artifact bodies and volatile answer snapshots do not become history. A lost binding receipt after Run acceptance remains unknown. Scoped command and creation reconciliation are read-only and dispatch no work; failed or unknown creation cannot assert a Goal locator. Budgeted Goals exclude uncalibrated image input and external image generation rather than inventing their costs.

## Validation

Require exact approval revision, command idempotency/conflicts, no Run before approval, finite budget validation, pre-dispatch zero-provider rejection, concurrent child reservation, actual provider repair/retry and timeout, usage absent/unknown, restart conservation, pause/resume, canonical Run failure and final user acceptance. No synthetic counter or HTTP 200 may establish Goal success.

The verified implementation slice passed final focused Core checks (9 files / 108 tests), Host continuation checks (16 tests), contracts (2 files / 8 tests), and Core/Host typechecks. Actual local HTTP tests include parent/child requests, provider output ceilings, repair, summary, deadline, unknown use and same-Session public-history continuation. Actual uncertain disk effects remain blocked without retry. See [the scoped evidence](../../../docs/validation/goal-099/README.md). This Note marks the verified source/controller slice implemented; GOAL-099 and FLOW-097 as complete product tasks remain partial pending client, autonomous progression and final acceptance.
