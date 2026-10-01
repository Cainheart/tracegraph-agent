---
id: 2026-10-01-mem-044-experience-case-extractor
title: Define bounded, evidence-backed Experience Case candidates
status: implemented
owners: [experience, contracts, core]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [experience-case-contract, experience-case-extractor]
supersedes: []
---

# Agent Note: Define bounded, evidence-backed Experience Case candidates

## Problem

MEM-043 can project one settled Run into a bounded Episode and optionally derive review-gated Memory candidates. The repository describes Experience Cases as reusable, conditional knowledge, but has no executable Case contract or extractor boundary. A Case must preserve what was observed, when a pattern applies, what verification supports its outcome, and which counterexamples limit reuse.

## Current state

- `MemoryEpisode` and its extraction input provide a canonical source digest plus exact event evidence references.
- The implementation provides a strict Experience Case contract, an explicit optional ModelAdapter extractor capability, and a Core candidate validator. Experience persistence, review commands, retrieval, Runtime scheduling, and injection are not implemented.

## Decision

- Add strict contracts for a versioned Experience Case, a bounded extractor input/result, and structured situation, action, outcome, verification, applicability, and counterexample data.
- Implement a Core validator that consumes one canonical MEM-043 Episode and untrusted extractor output. It resolves every cited sequence only against rows actually sent to the extractor and rechecks those references against the canonical Run stream.
- Materialize output only as a deterministic `candidate` projection with stable identity, source Episode/digest, and `status: candidate`. The extractor cannot set identity, version, validation state, authority, executable commands, or reuse policy.
- Represent outcome as `success | failure | partial | unknown`. A non-unknown outcome requires at least one evidence-backed verification reference; uncertainty remains explicit rather than inferred from model confidence.
- Reuse MEM-043's bounded/redacted Episode input builder. The ModelAdapter exposes an optional explicit Provider-backed extraction method; this task does not schedule that method from Runtime. Do not add a physical package, persistent Experience aggregate, review lifecycle, retrieval, Runtime injection, or UI.

## Invariants and boundaries

- A Case is a reusable suggestion, never an executable workflow or proof of future success.
- Situation, action, outcome, verification, applicability, counterexample, and overall evidence references must resolve to exact events from the source Episode; sequence references cannot repeat within a field.
- Each Case remains a candidate; this slice cannot validate, activate, or inject it into model context.
- Unknown outcomes are representable. Model confidence cannot upgrade an unverified outcome.

## Acceptance criteria

- [x] Contracts express success, failure, partial, and unknown outcomes plus structured applicability and counterexamples with bounded fields.
- [x] Core builds deterministic candidate projections from an Episode and strict untrusted extractor output.
- [x] Invalid, duplicated, or out-of-input evidence references fail closed; unsupported non-unknown outcomes are rejected.
- [x] Tests and Experience/Memory docs describe the implemented contract and clearly defer storage, review, retrieval, and Runtime scheduling/use.

## Evidence

- Contract: `packages/contracts/src/experience-case.ts`; public export: `packages/contracts/src/index.ts`.
- Core projector and explicit extractor seam: `packages/core/src/domains/experience/experience-case.ts`; public export: `packages/core/src/index.ts`.
- Optional OpenAI-compatible and Anthropic ModelAdapter implementations: `packages/core/src/domains/model/model-provider.ts`.
- Tests: `packages/contracts/src/experience-case.test.ts`, `packages/core/src/domains/experience/experience-case.test.ts`, and ModelAdapter protocol cases in `packages/core/src/domains/model/model-provider.test.ts`.
- Current contract and deferred boundaries: `docs/outlive-agent-v2/04-memory-and-experience/README.md`, `docs/outlive-agent-v2/04-memory-and-experience/03-experience-learning.md`, and `docs/outlive-agent-v2/09-implementation-roadmap/README.md`.
- Verification: `pnpm --filter @tracegraph/contracts build`; Contracts unit tests (156 passed); Core unit tests (411 passed) and typecheck; `pnpm test:engineering` (48 Node tests and 8 Vitest tests); `pnpm verify:boundaries` (18 packages, 34 workspace dependencies, 1,592 imports); `pnpm verify:package-readmes`; `pnpm graph:modules` and `pnpm graph:modules:check`; `pnpm verify:v2-docs` (11 docs, 62 roadmap tasks); and `git diff --check` all passed.

## Migration and rollback

No stored data changes. The new contracts and validator are additive. Rollback removes only this unpersisted projection seam and must not touch MEM-043 Episode or Memory records.

## Risks and open questions

- Scope dimensions and retrieval weights require separate calibration. This slice stores explicit bounded applicability rules but does not score matches.
- Experience Case persistence and review lifecycle need a later task before candidates can be reused.
