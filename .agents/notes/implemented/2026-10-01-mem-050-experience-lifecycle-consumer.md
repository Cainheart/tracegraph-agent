---
id: 2026-10-01-mem-050-experience-lifecycle-consumer
title: Experience lifecycle and Runtime recall consumer
status: implemented
owners: [experience, memory-runtime]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [experience-governance, runtime-context, provenance]
supersedes: []
---

# Agent Note: Experience lifecycle and Runtime recall consumer

## Problem

MEM-044 projects evidence-backed Experience candidates but intentionally excludes persistence, review, retrieval, and injection. MEM-048 cannot compare Experience off/on until candidates have a canonical review path and the Runtime can hand only currently validated, applicable Cases to the model with distinct provenance.

## Implemented state

- Experience Case candidates have a separate owner-scoped persistence and append-only lifecycle aggregate in the canonical Evidence Ledger.
- Runtime explicitly reviews/validates, disputes, resolves, or retires cases through CAS/idempotent lifecycle commands and deterministic replay.
- Recall reads current validated projections, checks project scope, explicit task applicability, and counterexamples, and fails closed on corrupt/unavailable state.
- Runtime injection defaults off and uses a distinct `experience` Context section, token partition, and Case/version/evidence provenance; Memory events remain separate.

## Implementation

### Target

Persist immutable Experience candidate seeds in an owner-scoped local store and append review/validate, dispute, resolve, and retire facts to the canonical Evidence Ledger's separate Experience aggregate namespace. Replay verifies identity, sequence, status transitions, idempotency, and hash chain. Retrieval reads the latest projection, admits only explicitly validated Cases, checks owner/project scope and case applicability/counterexamples against explicit task facts, and returns nothing on unavailable or corrupt state. Runtime injection is default-off, uses a distinct `experience` Context section and Case/version/source/evidence attribution, and presents patterns as suggestions only.

### Deferred

- Automatic execution of Case actions, treating a model's claim as success, and automatic approval of candidates.
- Cross-owner/global sharing, case editing in place, semantic inference for missing task facts, and unsupervised applicability learning.
- Reusing MemoryUse, Memory lifecycle, or Memory retrieval attribution to represent Experience.

## Invariants and boundaries

- Candidate seeds are immutable; review state is event-sourced and CAS/idempotency checked.
- Only an explicit user review may validate a candidate. Dispute and retirement immediately stop recall.
- Unknown or absent applicability facts do not count as a match; a matching counterexample blocks a Case.
- Context records retrieved, selected, and adapter handoff separately; none alone proves reuse success.
- Runtime retrieval/injection stays off unless the Host opts in.

## Migration and rollback

The owner-scoped store is additive. Existing candidates remain review-only until explicitly persisted/reviewed. Default-off means rollback is to disable the Runtime option; retain append-only history.

## Acceptance criteria

- [x] Candidate persistence, CAS review transitions, idempotent replay, and tamper/corruption rejection use a separate canonical Ledger aggregate.
- [x] Recall requires validated status plus exact owner/project applicability and counterexample checks.
- [x] Runtime Context and Ledger distinguish Experience Case/version/evidence and actual adapter handoff.
- [x] Default-off, review/replay, scope, dispute/retire, applicability, and actual Context handoff have focused Runtime tests.

## Evidence

- Implementation: `packages/contracts/src/experience-lifecycle.ts`, `packages/core/src/domains/experience/experience-lifecycle.ts`, `packages/evidence/src/event-ledger.ts`, `packages/core/src/domains/runtime/runtime.ts`, and the separate Context section in `packages/context/src/context.ts`.
- Focused behavior evidence: `packages/core/src/domains/experience/experience-lifecycle.test.ts` and `packages/core/src/domains/runtime/runtime.memory-experience-recall.test.ts` cover replay/lifecycle, validated-only recall, applicability/counterexamples, default-off, provenance, and actual Runtime handoff.
- Verification: Contracts 156/156, Evidence 5/5, Context 28/28, and Core 426/426 unit tests passed; root typecheck and repository gates are recorded with MEM-048 completion evidence.
