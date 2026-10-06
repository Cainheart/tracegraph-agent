---
id: 2026-10-05-delivery-human-continuation
title: Human continuation of an interrupted finite software Run
status: implemented
owners: [runtime, host]
created: 2026-10-05
last_reviewed: 2026-10-05
language: en
affects: [FLOW-097, GOAL-099, TEAM-100]
supersedes: []
---

# Agent Note: Human continuation of an interrupted finite software Run

[中文](2026-10-05-delivery-human-continuation.zh.md)

## Current state and accepted implementation phase

The user authorized manual continuation within the original finite software budget. Before this phase ordinary software recovery rejected `delivery_resume_requires_review`, and the reviewer received only a task prefix and the last ten command references. This implemented phase replaces those gaps without automatic task replay, new spending authority or changed credentials.

## Implemented decision

An explicit existing Session resume command may restore the same interrupted ordinary Run only after canonical scope, authorization, extension/Skill generation, model/credential identity, settled model reservations, action reconciliation, source hashes and delivery policy have been verified. Canonical trusted workspace root digest/kind/capabilities must also match; alternate roots, aliases and expanded flags fail closed. A trusted Host resolver binds the same admitted model configuration; a changed or missing binding rejects before dispatch. Budget reconstruction retains the same identity, ceilings, all charged tokens, elapsed time, failure counters and review rounds. Lost reservations or unknown effects block continuation. Goal-backed work remains owned by its approved Goal lease and ordinary Session resume cannot manufacture a replacement.

No old tool call, pending write or reviewer is automatically replayed. Existing patch approval is reissued under its existing hash fence; running work resumes at a fresh model observation boundary only after explicit human resume. Later canonical verified patches may explicitly invalidate older verification only with full-range WAL/current-SHA binding; fresh validation and review are required. External changes, unknown writes or missing bindings reject without dispatch. Completed or failed terminal Runs cannot be revived.

Review receives an immutable, scoped requirement packet with the complete redacted initial task, public conversation context and consumed human guidance, exact canonical verification references, and trusted approved Goal conditions when applicable. The compiled readonly child must actually read every packet byte through scoped `read_artifact` receipts and retain all pages untruncated with positive tokens in its exact final model Context Manifest before its structured verdict is accepted. The packet has an explicit finite size/window boundary; oversized requirements fail visibly instead of being silently truncated. These receipt checks prove evidence access, not model understanding, semantic completeness or real paid-provider quality.

## Truth, safety and verification

Use existing Run Budget checkpoints, SessionEvents, scoped Artifact store, session leases, policy guards and child Runtime. No parallel orchestration or event log. Unknown writes, changed policy/credentials, stale verification, exhausted/held/unknown budget, missing packets, incomplete reads and replay must produce zero new external dispatch. Real temporary project/API fixtures must prove retained budget and actual disk/build/test effects across a human continuation. Existing failure evidence remains historical. The full product and Windows/paid-model quality claims remain outside this scoped implementation.

## Verified evidence

The [scope report](../../../docs/validation/delivery-human-continuation/README.md) records four Core files / 56 tests, two Host files / nine tests, real SIGKILL/new-owner and HTTP resume/approval proofs, and an independent 656-check canonical byte/budget/packet verifier. Deterministic protocol fixtures prove actual build/test and zero-dispatch negatives, not paid-model quality, arbitrary generated-file inventory or full product completion.

## Rollback

Disable the trusted software-delivery option to retain legacy embeddings. Never erase canonical budget, review or unknown-effect receipts. Old delivery Runs without verifiable model/workspace recovery identities remain unavailable for continuation.
