---
id: 2026-10-05-flow-team-delivery-review
title: Finite-budget independent review before software delivery
status: implemented
owners: [runtime, host]
created: 2026-10-05
last_reviewed: 2026-10-05
language: en
affects: [FLOW-097, GOAL-099, TEAM-100]
supersedes: []
---

# Agent Note: Finite-budget independent review before software delivery

[中文](2026-10-05-flow-team-delivery-review.zh.md)

## Current state and accepted implementation phase

The user authorized complete software delivery and independent bounded review. The existing canonical child Runs, trusted role resolver, readonly Tool ceilings and shared Goal request reservations now carry a scoped delivery-review workflow. The production Host enables its finite policy; compatible Core embeddings omit it. A software finish with verified patch/command scope is checked before committing `run.completed`.

The accepted implementation phase is one real temporary software requirement, external file/build/test effects, a separate readonly reviewer, a repair, and a second review. Deterministic providers prove the controlled protocol and Runtime effects; they do not establish real paid model coding or review quality. Whole FLOW/TEAM and native UI acceptance remain separate.

## Implemented boundary

A trusted Runtime delivery-review option selects a compiled independent readonly role. Root execute Runs with verified patch paths or successful verification-command scope pass a canonical child review before successful completion. Plan answers, chats without workspace effects, child Runs and dedicated media operations are excluded. Review never grants permission and never merges, commits or pushes Git results.

A closed structured review result is accepted only from the actual child terminal and its hash-linked parent receipt. A blocking finding becomes a durable parent Observation so the existing loop can repair and retest. Rounds are finite. Reviewer failure, malformed result, budget exhaustion, cancellation or unknown side effects cannot become delivery success. Review runs outside the parent control lock; finalization rechecks queued input and terminal facts under that lock.

The root owner accepted the finite default: production Host enables two review rounds and ordinary software Runs use 200,000 tokens and 15 minutes; legacy Core embeddings omit the option. Internal turn ceilings become canonical phase checkpoints under the same aggregate lease. Every applied patch requires a fresh successful verification receipt; two missing attempts stop delivery. A separate generic failure-continuation seam may admit at most three known POSIX-quiescent verification failures, only with settled nonzero exit receipts and no timeout, abort or truncation. The model may inspect and repair through normal gates; the Runtime never reruns a failed command. Repeating the same command without new canonical read or source-change evidence is rejected. Windows, children and legacy mode retain fail-closed behavior.

The whole tree uses the admitted Goal lease, or a Runtime-owned finite token/time lease for ordinary software Runs. Reservations precede provider dispatch and include review, repair and retry. Unsupported adapters fail before dispatch when this mode is enabled. Restart does not manufacture a new budget or automatically repeat review or writes.

## Truth sources, safety and compatibility

- Reuse the current AgentLoop, SubagentRegistry, canonical SessionEvents and scoped Artifacts; do not create a second orchestration loop or log.
- Reviewer tools and workspace authority are readonly and intersect the admitted parent ceiling. Repository text, test output and model findings remain untrusted evidence.
- The reviewer has an independent child Run/Session and provider lease. Only public requirements and canonical effect references are shared; private reasoning is never used as review evidence.
- Additive structured Decision fields preserve legacy reads; free-text answers never substitute for a review result.
- Goal `run.completed` still means awaiting final user acceptance, never automatic satisfaction of done conditions.
- The accepted defaults are wired in Host. Disabled mode preserves existing embeddings; it cannot claim automatic review. Plan approval persists the same no-background-extraction fact so later billing cannot escape the admitted lease.

## Verification and rollback

The controlled software fixture changes real source, builds the module, receives a real blocked review, adds a regression that actually exits nonzero, repairs source, rebuilds/tests successfully and passes a second independent review. Negative cases cover unsupported budget bindings, false/prose review, read/write denial, external changes, missing/unknown/timeout verification, repeat guards, cancellation, phase/no-progress continuity, shared Goal charging, replay and rejected automatic ordinary delivery resume. Disabling the trusted option restores the previous finish behavior without deleting review, budget or unresolved receipts. No paid credential or default profile is used.

## Evidence

The [scoped report](../../../docs/validation/delivery-review/README.md) links actual command Artifacts, delivered source/build bytes, three canonical Runs and 15 real local HTTP requests. The independent read-only evidence validator passed 692 checks. Core focused checks passed 88 tests in eight files; Goal passed 17, production Host admission two, fixture/recovery 30 and contracts six. Earlier failed/interim receipts are retained. The owning code seams are [Runtime](../../../packages/core/src/domains/runtime/runtime.ts), [delivery review](../../../packages/core/src/domains/runtime/delivery-review.ts), [child roles](../../../packages/core/src/domains/subagent/subagent.ts) and [shared budget](../../../packages/core/src/domains/runtime/shared-run-budget.ts).

## Remaining scope

Implementation applies to this verified backend slice, not complete FLOW/TEAM/Goal acceptance. The required review inventory covers verified patch paths and command manifests, not arbitrary script-generated files; that full inventory remains pending. A fresh passing test is a real execution receipt, not proof of test coverage. Required reads are bounded and policy-checked; their before/after hashes are not atomic protection against same-user filesystem tampering. Real paid coding/review quality, Windows known-failure quiescence, complete UI review controls and final user acceptance were not verified. Goal completion remains a distinct user decision.
