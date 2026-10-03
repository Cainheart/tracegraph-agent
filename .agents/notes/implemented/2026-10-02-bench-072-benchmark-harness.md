---
id: 2026-10-02-bench-072-benchmark-harness
title: Outlive Benchmark harness and run reports
status: implemented
owners: [benchmarks]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [BENCH-072, BENCH-073]
supersedes: []
---

# Agent Note: Outlive Benchmark harness and run reports

## Problem

BENCH-072 requires a reproducible harness that records raw samples, fixed budgets, and machine metadata. Existing offline performance evals cover a small deterministic gate, but do not provide a reusable cross-path report format for the upcoming BENCH-073 user-path baselines.

## Current state

The Benchmark target is documented in `docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/02-benchmark-system.md`. Existing `evals/perf/` remains a separate G16 regression eval. At BENCH-072 delivery, the generic runner was ready for the then-upcoming user-path scenarios. Those scenarios and reviewed ceilings are now implemented under BENCH-073; see `.agents/notes/implemented/2026-10-02-bench-073-user-path-baselines.md`.

## Decision

The dependency-free Node runner under `benchmarks/support/` accepts a strict JSON scenario manifest. It performs one correctness command before measurement, then runs fixed warmups and measured samples in fresh subprocesses, each with a private temporary home/temp root. It enforces the manifest's source-controlled wall-time P95 budget and writes a bounded JSON report containing raw results, summary statistics, config digest, Git state, and non-identifying machine/runtime metadata. Child Node processes receive the repository offline guard and a sanitized credential environment. Reports go only to ignored `_tmp_benchmarks/` storage.

### Target

- Keep scenario definitions and budgets reviewable in the repository.
- Make correctness failure stop measurement and produce a failed report.
- Keep warmup and measured samples distinguishable and use one fresh process/private temp root per invocation.
- Preserve raw samples, correctness result, summary, budget outcome, commit/dirty state, and machine/runtime metadata in a bounded artifact.
- Do not execute performance scenarios as part of ordinary `pnpm test`; pure harness contract tests run in `test:engineering`. Do not create BENCH-073 path baselines in this task.

### Deferred

- The first eight user-path scenarios, calibrated budgets, and trend/regression baselines belong to BENCH-073.
- Process-tree RSS/CPU measurement adapters and CI runner-class calibration require scenario-specific evidence and remain future work.
- Public benchmark dashboards and network/model measurements remain out of scope.

## Alternatives considered

- Reusing only the G16 Vitest eval: it has fixed representative metrics and a different report/baseline lifecycle, so it cannot serve as the reusable path harness.
- Adding timing assertions to root unit tests: scheduler-sensitive measurements would make correctness CI noisy and would not retain reviewable raw artifacts.

## Invariants and boundaries

- Node subprocesses use the offline guard for standard fetch/TCP/TLS/UDP/DNS APIs; credential-like and proxy environment variables are removed, `HOME`/temp locations are private, and inherited `NODE_OPTIONS` is replaced with the guard import.
- The runner uses no shell, rejects out-of-repository working directories, bounds arguments, sample counts, timeouts, and report size; stdout/stderr are discarded, not retained.
- Correctness is a prerequisite; a failed correctness command cannot yield a valid performance result.
- Budgets come only from the checked scenario manifest; environment variables cannot silently relax them.
- Reports avoid hostnames, usernames, absolute paths, command output, and environment values.
- Benchmark code measures existing product entrypoints and does not duplicate product algorithms.

## Migration and rollback

This task adds a new tooling surface and no product data or baseline changes. Rollback removes `benchmarks/`, the root benchmark script/test registration, and the BENCH-072 Note/documentation update. Existing G16 evals remain untouched.

## Acceptance criteria

- [x] Strict scenario manifests provide fixed correctness, warmup/sample counts, command timeout, and budget.
- [x] The harness writes a bounded machine-readable report with raw samples, summary, budget, machine/runtime metadata, and source config digest.
- [x] Tests prove isolation/cleanup, offline and credential guard behavior, correctness fail-closed behavior, budget failure, timeout, and report creation.
- [x] The quality module and roadmap describe what shipped and what is deferred; no BENCH-073 baselines are claimed.

## Risks and open questions

Initial budgets will be calibrated with BENCH-073. Wall time and host metadata are available in v1; process-tree resource metrics need a portable, independently validated adapter before they can be treated as measurements. The offline guard is not an OS sandbox, so reviewed scenarios must not spawn network-capable non-Node clients and must direct writes into the provided temp root.

## Evidence

- Implementation: `benchmarks/support/runner.mjs`, `benchmarks/support/offline-guard.mjs`, `benchmarks/AGENTS.md`, root `benchmark` script.
- Tests: `benchmarks/support/runner.test.mjs` (7 contract tests).
- Verification: `pnpm test:engineering` (55 Node tests and 8 Vitest tests), `pnpm verify:boundaries`, `pnpm verify:v2-docs`, `pnpm verify:package-readmes`, `pnpm benchmark -- --help`, and `git diff --check` passed.
