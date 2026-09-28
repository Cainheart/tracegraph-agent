---
id: 2026-09-29-arch-013-progressive-boundary-governance
title: Apply package boundary rules through progressive governance states
status: implemented
owners: [architecture]
created: 2026-09-29
last_reviewed: 2026-09-29
affects: [package-boundaries, architecture-policy, ci]
supersedes: []
---

# Agent Note: Apply package boundary rules through progressive governance states

## Problem

The boundary gate currently blocks violations across the whole workspace. That
is appropriate for modules already migrated to the rules, but it makes a
gradual adoption path unavailable for existing packages. A report-only package
also needs an accountable migration handle so findings do not become ownerless.

## Current state

- [`architecture-policy.yaml`](../../../architecture-policy.yaml) lists every
  workspace package and its allowed/forbidden dependency edges.
- [`scripts/verify-boundaries.mjs`](../../../scripts/verify-boundaries.mjs)
  blocks undeclared/forbidden edges, deep imports, cross-package relative
  imports, package cycles, and source scanner failures uniformly.
- [`scripts/verify-boundaries.test.mjs`](../../../scripts/verify-boundaries.test.mjs)
  contains negative fixtures for reverse dependencies, deep imports, cycles,
  and CI wiring.

## Proposal

Use an explicit `governance` value on every workspace-package policy entry:

- **Target — `managed`:** all package-boundary violations are blocking.
- **Target — `legacy`:** boundary violations are returned and printed as
  warnings with the package's required non-empty `migration_owner`.
- Policy-format errors, missing package inventory, expired/malformed
  exceptions, and missing owners remain blocking regardless of governance
  state.
- Classify a package's source/import/dependency violation by the package that
  owns the violating source edge. A dependency cycle is reported for each
  participating package, so any managed participant blocks the cycle.
- Start with the low-dependency leaf packages `@tracegraph/contracts`,
  `@tracegraph/retrieval`, and `@tracegraph/telemetry` as managed pilots. Keep
  the remaining existing packages in legacy state with area-level migration
  owner handles. Promote packages individually after their boundaries are
  ready.
- Increment the policy schema version because governance becomes a required
  package field and legacy ownership changes validation.

**Deferred:** logical modules inside a workspace package, migration deadlines,
and a canonical owner registry. Current migration owner handles identify the
responsible package/service area; they do not claim a verified human roster.

## Alternatives considered

- Mark every current package managed immediately: rejected because the roadmap
  requires a gradual migration path and report-only treatment for legacy code.
- Silently treat packages without a governance value as legacy: rejected
  because omitted state would weaken the gate without an explicit migration
  owner.

## Invariants and boundaries

- The architecture policy remains the only machine-readable boundary source.
- Governance state changes violation severity; it does not change package
  inventory, allowed edges, exception validity, or migration promotion rules.
- Managed violations and policy/configuration defects continue to fail CI.
- Legacy findings are visible in CLI output and structured verifier results;
  they never count as a clean boundary report.

## Migration and rollback

Add a required governance state to all current package entries. Keep existing
packages report-only initially except the three managed leaf pilots. Promotion
to managed changes warning behavior to blocking without changing package
source or persisted data. Rollback is a policy/checker revert; no runtime data
or public protocol changes are involved.

## Acceptance criteria

- [x] A managed reverse edge, deep import, or cycle blocks verification.
- [x] A legacy reverse edge, deep import, or all-legacy cycle is reported with
      its migration owner and does not block verification.
- [x] Missing/invalid governance state or a missing legacy migration owner
      blocks verification.
- [x] CLI output and CI behavior match the structured result.
- [x] Owning docs and roadmap state are updated after verification.

## Risks and open questions

- Migration owner handles are validated as non-empty strings because no owner
  registry or `CODEOWNERS` file currently exists. A later governance task may
  bind them to a maintained team/owner registry.
- A legacy package can temporarily contain several boundary defects; warnings
  must stay visible and owners must promote packages as each boundary becomes
  ready.

## Evidence

- Implementation: [`architecture-policy.yaml`](../../../architecture-policy.yaml), [`scripts/verify-boundaries.mjs`](../../../scripts/verify-boundaries.mjs)
- Tests: [`scripts/verify-boundaries.test.mjs`](../../../scripts/verify-boundaries.test.mjs) covers managed blocking, legacy warnings with migration owners, all-legacy cycles, missing owners, invalid states, CLI output, and existing boundary negatives.
- Verification: `pnpm verify:boundaries` passed with 12 packages, 20 workspace dependencies, 1,259 import references, and zero current legacy findings; `pnpm test:engineering` passed (47 Node tests and 8 Vitest tests); `pnpm verify:v2-docs` passed (11 documents, 62 tasks); `git diff --check` passed.
