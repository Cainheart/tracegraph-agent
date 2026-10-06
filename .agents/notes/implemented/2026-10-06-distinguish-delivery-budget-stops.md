---
id: 2026-10-06-distinguish-delivery-budget-stops
title: Distinguish Run budget stops from Goal budget stops
status: implemented
language: en
owners: [runtime]
created: 2026-10-06
last_reviewed: 2026-10-06
affects: [runtime-events, run-projection, workbench]
supersedes: []
---

# Agent Note: Distinguish Run budget stops from Goal budget stops

[中文](2026-10-06-distinguish-delivery-budget-stops.zh.md)

## Problem

The screenshot showed a normal project Run stopping with “Goal budget stopped.” At that time, ordinary Runs received a 200,000-token aggregate reservation, a 15-minute lease, and a 12-turn limit. The `213K / 226K` display was the model context-window reading, not accumulated Run usage. The stop was enforced before another model request; the displayed owner and cause were misleading.

## Decision

Ordinary chat and project Runs no longer have aggregate token, elapsed-time, or fixed-turn ceilings. Requests use the selected model's confirmed context and output capabilities. Context is compressed near 80% pressure. Temporary model request failures use at most five bounded retries. Goal budgets remain explicit user-set limits. No-progress protection, per-operation timeouts, permission approval, cancellation, and unknown-side-effect reconciliation remain in force.

## Compatibility

Finite shared-budget recovery remains available to Goals and explicitly budgeted compatibility fixtures. Historical Runs retain their original Ledger facts and readable diagnosis; opening or reconnecting a Run never resubmits work. Retries apply only to a model request before a tool operation is dispatched and cannot replay a tool call or write.

## Invariants

- The Event Ledger remains the source of truth. A stop reason belongs to its Run and turn; an earlier failed turn cannot override a later successful answer.
- Public progress contains validated user-visible stages and actual receipts. Private reasoning, context construction, and token estimates stay out of the public projection.
- A known result may be retried only within the bounded model-request policy. An unknown write is reconciled against its receipt and disk effect before any user-directed continuation.
- Context-window usage and aggregate Run budgeting are distinct measurements.

## Migration and rollback

No Ledger migration is needed. Existing terminal records remain unchanged and are projected according to their recorded Run and budget owner. Reverting the new ordinary-Run policy would restore the premature aggregate stops; explicit Goal limits and compatibility fixtures remain independently testable.

## Verification

- [x] Ordinary project Runs can continue beyond the former 200,000-token, 15-minute, and 12-turn defaults.
- [x] Context pressure invokes compression; temporary model request failures stop after five retries.
- [x] Goal budget stops remain enforced; no-progress protection and operation timeouts remain active.
- [x] Tool calls and unknown writes are not replayed by model-request retries.
- [x] The installed macOS arm64 app runs from the user install path and the Host reports the same Product Build ID as the packaged runtime manifest.
- [ ] Windows native install and UI acceptance remain pending user verification.
- [ ] Developer ID signing and notarization remain pending valid release credentials.

## Evidence

- Implementation: [`runtime.ts`](../../../packages/core/src/domains/runtime/runtime.ts), [`retry-policy.ts`](../../../packages/core/src/domains/runtime/retry-policy.ts), [`runtime-service.ts`](../../../packages/core/src/domains/context/runtime-service.ts), [`ChatProcess.tsx`](../../../packages/workbench/src/components/ChatProcess.tsx)
- Tests: [`runtime.shared-budget.test.ts`](../../../packages/core/src/domains/runtime/runtime.shared-budget.test.ts), [`retry-policy.test.ts`](../../../packages/core/src/domains/runtime/retry-policy.test.ts), [`delivery-recovery-safety.test.ts`](../../../packages/core/src/domains/runtime/delivery-recovery-safety.test.ts)
- macOS install, Profile preservation, cleanup, package checks, and external release dependencies: [rebuild acceptance record](../../../docs/validation/desktop-install-2026-10-06-rebuild/README.md)
- Prior stop diagnosis and historical finite-lease evidence: [Run stop investigation](../../../docs/validation/runtime-budget-stop-2026-10-06.md)
