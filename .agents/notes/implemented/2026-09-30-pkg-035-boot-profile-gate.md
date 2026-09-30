---
id: 2026-09-30-pkg-035-boot-profile-gate
title: Keep Boot/Profile resolution inside the CLI composition root until its contract stabilizes
status: implemented
owners: [composition, cli]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [cli-boot, resolved-profile, package-topology]
supersedes: []
---

# Agent Note: Keep Boot/Profile resolution inside the CLI composition root until its contract stabilizes

## Problem

PKG-035 names `packages/boot` as a candidate output but explicitly requires a package-promotion gate. The current repository has one application composition root in `apps/cli/src/index.ts`; Web consumes the Host/SDK and does not assemble providers, and Desktop is not present. The V2 Profile/Bundle resolver and wire shape remain target design rather than current behavior.

## Current state

- CLI resolves feature-specific configuration in `apps/cli/src/*-config.ts` and assembles Core, Host, Session, MCP, LSP, Retrieval, Telemetry, CodeGraph, and trusted subagents from `apps/cli/src/index.ts`.
- The existing `subagent` profiles are a Host-owned delegation catalog, not application Profiles or Bundles.
- No shared Boot/Profile loader API or profile files are consumed by a second application. Future Web/Desktop entrypoints do not count as consumers.

## Proposal

Do not create a physical `@tracegraph/boot` package in PKG-035. The generic Profile boundary is not stable and currently has one real application consumer, so the hard package-promotion gate is not met. Keep a small CLI-internal profile definition and resolver under `apps/cli/src/profiles/` and `apps/cli/src/boot/`.

The resolver will produce a deterministic, read-only `tracegraph.resolved-cli-profile.v1` descriptor from the safe startup selections already resolved by CLI. It will provide JSON dump and SHA-256 fingerprint helpers. This fingerprint covers only the explicitly listed non-secret projection; it is not a full composition digest, authorization proof, persisted Run manifest, or input to Runtime policy.

The profile projection excludes credential values/references, model base URLs, filesystem paths, process commands/arguments/environment, remote endpoint URLs, raw prompts, extension errors, stderr, and timestamps. It may include validated public identifiers, modes, limits, protocol/model labels, and existing prompt hashes. No startup policy or provider behavior changes.

Reconsider a physical package only after a reusable stable contract exists and it has two independent real consumers or a separately documented hard-isolation reason, plus package-root contract tests.

## Alternatives considered

- Promote `@tracegraph/boot` now based on planned Web/Desktop consumers: rejected because planned consumers are not evidence and the shared profile contract is still proposed.
- Move the complete CLI `runServer` function into a package: rejected because it mixes CLI-only flags, local paths, credential resolution, platform services, and delivery behavior, and would freeze an unstable app-composition API.
- Reuse the subagent profile catalog as an application Profile: rejected because it is a distinct Host-owned delegation contract.

## Invariants and boundaries

- `apps/cli` remains the sole owner of current application assembly; feature configuration and authority remain with their existing owners.
- The resolved profile is an informational safe projection. It cannot grant permissions, instantiate providers, alter Runtime settings, or claim to bind every secret or local process detail.
- Dump and digest are deterministic for equal included inputs; semantic list order is preserved.
- No package inventory or dependency-policy exception is added for Boot.

## Migration and rollback

Add the internal profile descriptor/resolver and focused tests, map already-resolved CLI startup inputs into its allowlisted fields, and update current CLI/module/roadmap documentation. Rollback removes the two internal profile files, their call site and tests, and restores the previous documentation; no persisted data or package manifest changes are needed.

## Acceptance criteria

- [x] The physical package gate is explicitly adjudicated without counting planned consumers; no package is created while the profile boundary is unstable.
- [x] The current CLI profile is built from resolved startup values and supports deterministic JSON dump and SHA-256 digest.
- [x] Profile tests prove stable output, changed safe inputs change the digest, ordered selections stay ordered, and secrets/paths/commands are excluded.
- [x] Existing CLI Runtime composition behavior is unchanged; typecheck, focused CLI tests, CLI E2E, boundary, docs, and generated-file checks pass.
- [x] The current CLI module documentation and roadmap distinguish this shipped descriptor from the proposed cross-application Profile/Bundle system.

## Risks and open questions

- This descriptor intentionally is not a complete identity for opaque subprocess configuration or live remote provider catalogs. A future `composition_digest` contract must explicitly classify sensitive fields before claiming exact composition identity.
- A second application consumer may motivate a shared package later, but package extraction still needs a stable schema, negative boundary tests, and rollback evidence.

## Evidence

- Implementation: no physical `@tracegraph/boot` package was created; the package gate failed on the unstable cross-app Profile contract and the single current app consumer. `apps/cli/src/profiles/cli.ts` defines `tracegraph.cli@1`; `apps/cli/src/boot/profile.ts` builds an immutable allowlisted projection, deterministic JSON dump, and verified SHA-256 digest. The CLI Runtime reads max turns, sandbox mode, and rollback policy from that resolved snapshot. Current behavior docs and the roadmap record that the broader Profile/Bundle system remains target-state.
- Tests: the profile contract file passed (5 tests); CLI unit suite passed (14 files, 62 tests); CLI E2E passed (4 tests); documentation consistency eval passed (6 checks).
- Verification: workspace `pnpm typecheck` passed; `pnpm test:engineering` passed (48 Node tests and 8 coverage-gate tests); boundary check passed (18 packages, 34 workspace dependencies, 1,442 import references, zero legacy findings); package README, V2 docs (11 documents/62 tasks), lockfile (19 manifests), module graph freshness, current-baseline freshness, and `git diff --check` passed.
