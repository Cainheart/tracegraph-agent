---
id: 2026-09-30-mem-045-memory-conflict-feedback
title: Add deterministic Memory conflict, validity, and use-feedback governance
status: implemented
owners: [memory, contracts, evidence]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [memory-recall, memory-feedback, evidence-ledger, memory-governance]
supersedes: []
---

# Agent Note: Add deterministic Memory conflict, validity, and use-feedback governance

## Problem

MEM-041 established review-driven V2 lifecycle state and MEM-042 established exact-version Context provenance plus Run-scoped MemoryUse. They did not provide a reusable V2 recall gate for unresolved conflicts and elapsed validity, or a durable way to capture whether a response-backed Memory use was helpful, irrelevant, incorrect, or stale. The G-21 V1 Runtime remains the canonical production path and must not be switched as a side effect.

## Current state

- Contracts export strict content-free conflict, recall-gate, and versioned feedback schemas.
- Core exports deterministic conflict detection, V2 recall eligibility, feedback recording/replay, and review dismissal APIs.
- Evidence persists feedback in the existing canonical Ledger under a separate owner + Memory ID + immutable-version namespace. It uses sequence CAS, idempotency, a hash chain, and durable replace.
- Feedback requires an exact V2 Memory schema/version/content digest present in a Run `MemoryUse` that reached `response`, with matching Run, use ID, and ContextManifest. One user may submit at most one feedback value for that MemoryUse/version; same-value retries are idempotent.
- None of these APIs are wired into G-21 `remember()`/`recall()`, Runtime auto-recall, a V2 canonical record store, or a client UI.
- The actor contract checks a user-shaped identity only; authentication and owner authorization belong to the eventual trusted command caller and are not provided by this API.

## Decision

Detect conflict only where records share an owner, a non-empty explicit `normalizedKey`, an overlapping scope and validity interval, and different SHA-256 digests of their claim. Normalize the key with Unicode NFKC, trimming, case-folding, and whitespace collapse. Do not infer semantic conflicts. Conflict groups are deterministic derived views with only IDs, versions, statuses, and a key digest; they do not emit a lifecycle conflict event or change record status. The V2 eligibility gate blocks all participants in every unresolved group.

The V2 eligibility gate also blocks non-active records, records outside owner/request scope, records not yet valid or whose `validUntil <= now`, and records disallowed by model-use consent, sensitivity, or source trust. The gate accepts a complete single-owner V2 snapshot with at most one current version per Memory ID. It is a pure API and does not change the existing G-21 V1 retrieval behavior.

Store feedback as a separate content-free Memory aggregate stream because feedback is a durable governance fact about one immutable Memory version, while MemoryUse itself is Run-scoped. `helpful` and `irrelevant` only increment replayable counts; they do not change truth, confidence, or ranking. `incorrect` and `stale` open a review requirement and block that version in the V2 eligibility gate until a reviewer appends a dismissal. Dismissal closes that review gate only; correction, supersession, revocation, and deletion belong to later control-plane commands.

## Alternatives

- Semantic/model-assisted conflict detection: rejected because it creates unreviewed inference at a safety gate; conflicts require an explicit key and deterministic evidence.
- Persist `memory.conflict.detected` or mutate lifecycle status in this task: deferred because conflict is derived from a caller-supplied snapshot and resolution needs a user-visible control plane.
- Store feedback in Run MemoryUse events: rejected because the feedback is a longer-lived governance fact, not a transition in the request-hand-off state machine.
- Let feedback directly tune truth/confidence or retrieval ranking: rejected because a single subjective outcome does not establish correctness or causality.
- Switch G-21 Runtime to V2: deferred until a canonical V2 store and control surface are separately reviewed.

## Invariants

- No semantic conflict is inferred without `normalizedKey`; disjoint scopes may coexist.
- No expired/future-valid, non-active, out-of-scope, untrusted, non-consented, or model-use-disabled V2 record becomes eligible.
- All participants of an unresolved overlapping conflict are blocked; no last-write-wins selection occurs.
- Feedback is bound to an exact V2 schema/version/content digest and a response-backed MemoryUse/ContextManifest; one user cannot inflate the count by replaying the same MemoryUse under new idempotency keys.
- Incorrect/stale feedback remains a recall block until an append-only dismissal; dismissal does not rewrite claim or provenance.
- Feedback facts contain no Memory claim, Context body, adapter response, or free-form user text. Ledger replay rejects broken sequence, identity, idempotency, chain, and review transitions.
- G-21 V1 storage, Runtime recall, and Run `SessionEvent` schema/sequence remain unchanged.
- No caller may treat the actor schema as proof of authenticated owner consent; the composition/control plane must authorize before invoking the service.

## Migration and rollback

No data migration occurs. Feedback files are created only when an explicit Core caller records feedback. Rollback means stopping calls to the new APIs; committed Ledger facts remain append-only. Do not delete or rewrite feedback history as part of code rollback. No V1 records or Memory indexes are rewritten.

## Acceptance criteria

- [x] Deterministic explicit-key conflicts are derived and all unresolved participants fail the V2 recall gate.
- [x] Validity, status, owner/scope, governance, and source-trust filters fail closed.
- [x] Feedback ties the exact V2 schema/version/content digest to a response-backed MemoryUse and ContextManifest.
- [x] Helpful/irrelevant do not alter truth or ranking; incorrect/stale block until a recorded review dismissal.
- [x] Feedback replay validates append-only hash-chain facts and rejects repeated votes on the same MemoryUse/version by one user.
- [x] G-21 V1 Runtime remains unchanged and current/target docs describe the boundary.

## Evidence

- Contracts: `packages/contracts/src/memory-governance.ts` and its package-root export.
- Core: `packages/core/src/domains/memory/memory-governance.ts` and its package-root export.
- Evidence: `packages/evidence/src/event-ledger.ts` and its public API test.
- Focused tests: Contracts 12, Core Memory 22, Evidence public API 4 passed.
- Verification: `pnpm typecheck` passed all 18 buildable workspace projects and eval typecheck; `pnpm -r --if-present test:unit` passed 1,037 tests across 119 files; `pnpm test:engineering` passed 48 Node checks + 8 Vitest checks; implementation-consistency eval passed 6 checks. `verify:boundaries` passed (18 packages, 34 workspace dependencies, 1,493 imports, 0 legacy findings); package README gate passed (18); invariants passed across 207 source files; V2 docs passed (11 docs, 62 tasks); generated graph and current baseline checks passed; `git diff --check` passed.
- Current/target docs: module 08, Memory and Experience docs, migration baseline, package READMEs, and roadmap.
