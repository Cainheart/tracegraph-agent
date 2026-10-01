---
id: 2026-10-01-mem-049-v2-memory-recall-runtime
title: V2 Memory recall Runtime consumer
status: implemented
owners: [memory-runtime, memory-governance]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [memory-recall, runtime-context, provenance]
supersedes: []
---

# Agent Note: V2 Memory recall Runtime consumer

## Problem

MEM-045 provides a fail-closed eligibility decision and MEM-046 provides the V2 control projection, but the G-21 Runtime still consumes its optional V1 retriever directly. Evaluation cannot claim V2 behavior until an explicitly enabled consumer checks the latest lifecycle, feedback, conflict, scope, validity, trust, consent, and model-use policy before ranking or Context construction.

## Implemented state

- Runtime has a Host-selected `v2MemoryRecallEnabled` option that defaults off and leaves G-21 V1 recall separate.
- Each opted-in turn builds the owner-scoped control snapshot, runs `evaluateMemoryRecallEligibility`, and ranks only exact eligible Memory id/version records.
- Store, Ledger, projection, and eligibility failures produce an empty V2 Memory contribution without an unfiltered V1 fallback.
- Context/MemoryUse provenance carries the exact version and evidence references through the Runtime handoff boundary.

## Implementation

### Target

Add a Host-selected, default-off V2 recall switch. When enabled, a turn obtains one complete scoped V2 control snapshot, evaluates the eligibility gate, ranks only the exact eligible id/version rows, and passes only those rows to Context with canonical retrieval attribution. Ledger, payload-store, projection, or gate errors fail closed to an empty Memory contribution and never fall back to an unfiltered result. Keep the G-21 V1 path independent when V2 is not enabled.

Expose retrieved/selected/handoff facts only at their actual lifecycle points. Context and Ledger provenance establish what was made available and handed to the adapter; they do not prove that a Provider relied on it.

### Deferred

- Turning V2 recall on by default or silently migrating G-21 records.
- Semantic contradiction inference, learned ranking, and model self-reports as authorization evidence.
- Provider/model causal attribution beyond explicit Runtime handoff.

## Invariants and boundaries

- Every turn re-reads current V2 projections and checks owner/project/run scope, lifecycle, feedback, conflicts, validity, source trust, consent, sensitivity, and `allowModelUse` before ranking.
- Any incomplete/corrupt snapshot prevents V2 content from entering Context.
- Candidate, revoked, disputed, expired, out-of-scope, or feedback-blocked records never enter the ranking pool.
- This task introduces no automatic side effect and no default-on policy.

## Migration and rollback

The new Runtime option defaults off, preserving existing behavior. Hosts can enable it explicitly after supplying the V2 store. Rollback is to turn the option off; no stored records are rewritten.

## Acceptance criteria

- [x] Explicit-on V2 Runtime reads pass through the eligibility gate before retrieval and preserve id/version/evidence provenance.
- [x] Gate/store/Ledger failures fail closed with no legacy or ungated fallback.
- [x] Default-off, policy/scope negatives, exact-version provenance, and real Context handoff have focused Runtime tests.

## Evidence

- Implementation: `packages/core/src/domains/memory/memory-v2-recall.ts`, `packages/core/src/domains/runtime/runtime.ts`, and the Context handoff in `packages/core/src/domains/runtime/agent-loop.ts`.
- Focused behavior evidence: `packages/core/src/domains/runtime/runtime.memory-experience-recall.test.ts` covers default-off, exact-version Memory handoff, fail-closed store behavior, and no V1 fallback.
- Verification: Contracts 156/156, Evidence 5/5, Context 28/28, and Core 426/426 unit tests passed; root typecheck and repository gates are recorded with MEM-048 completion evidence.
