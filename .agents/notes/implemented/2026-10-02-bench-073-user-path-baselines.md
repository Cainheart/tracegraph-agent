---
id: 2026-10-02-bench-073-user-path-baselines
title: BENCH-073 User Path Baselines
status: implemented
owners: [benchmarks]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [BENCH-073]
supersedes: []
---

# Agent Note: BENCH-073 User Path Baselines

## Problem

BENCH-072 provides an offline process runner, but there were no checked-in,
repeatable performance scenarios covering the first eight Outlive user paths.
Without fixed fixtures, correctness oracles, reviewed budgets, and CI reports,
performance changes could not be compared consistently.

## Current State

The runner accepts strict scenario manifests and writes bounded wall-time
reports. BENCH-073 adds eight production-path scenarios, reviewed P95 ceilings,
and a dedicated CI job. The `evals/perf/` suite remains a separate G16 quality
gate. The first local calibration was macOS ARM64 / Node 24.21.0; the dedicated
CI class is Ubuntu 24.04 / Node 22.19.0, and its first hosted report remains to
be reviewed.

## Decision

The eight fixed offline scenarios invoke public production package entrypoints:
Runtime/Host readiness, durable Ledger append, completed Run replay, Context
compaction, governed Memory ranking, bounded file Tool execution, Runtime
cancellation to terminal quiescence, and interrupted Run recovery. Each has an
independent correctness command, one warmup, five measured samples, and a
reviewed wall-time P95 ceiling in its manifest. Initial observed local P95 and
ceiling pairs are documented in `benchmarks/README.md`. Synthetic state is
written only under the runner-provided temporary root.

The full suite is wired into a dedicated pinned Ubuntu 24.04 / Node 22.19 CI job
that uploads bounded reports, including reports from failed runs. Budget
changes remain explicit manifest edits subject to code review; there is no
automatic baseline rewrite command. The budget is a hard ceiling, not a
cross-commit trend comparison, and reports remain the raw evidence for later
calibration.

### Target

- All eight paths run through the existing fresh-process offline runner.
- Correctness assertions prove the expected path outcome before measurement.
- Fixed path ceilings fail CI when exceeded; machine and raw sample reports are
  retained as a CI artifact.
- Budget edits are visible in the reviewed scenario manifest diff.

### Deferred

- Process-tree RSS/CPU measurement remains outside runner v1.
- Cross-commit statistical baseline comparison and runner-class variance
  modeling remain future work; absolute ceilings do not report smaller changes
  that stay below the ceiling.
- External provider, network, and model-quality measurements remain outside
  this offline suite.

## Invariants and Boundaries

- Scenarios use built public package entrypoints; they do not copy product
  algorithms or depend on Langfuse.
- Scenario data and generated files remain under
  `TRACEGRAPH_BENCHMARK_TEMP_ROOT` and are deleted after each process.
- The runner discards command output and records only bounded result metadata.
- Correctness failure skips performance measurement.
- The existing G16 evaluation baseline and ordinary correctness test suite are
  unchanged.

## Acceptance

- [x] Eight versioned manifests cover cold start, Ledger, replay, Context,
  Memory, Tool, cancel, and recovery.
- [x] Every manifest passes its correctness command and has a fixed P95 budget.
- [x] Dedicated pinned CI is configured to run the complete suite and upload
  bounded reports.
- [x] A deliberately lowered budget fails the benchmark gate.
- [x] Current docs and the roadmap distinguish delivered ceilings from deferred
  statistical trend comparison and RSS/CPU measurement.

## Rollback

Remove the eight manifests, path scenarios, dedicated CI job, and BENCH-073
documentation/roadmap entry. BENCH-072 runner contracts and existing G16 evals
remain usable without this baseline suite.

## Evidence

- Implementation: `benchmarks/paths/scenario.mjs`, eight manifests under
  `benchmarks/scenarios/`, `benchmarks/support/runner.mjs`, and the
  `benchmarks` CI job in `.github/workflows/ci.yml`.
- Tests: `benchmarks/support/runner.test.mjs` proves correctness fail-closed,
  offline isolation, timeout handling, and that an artificially low budget
  fails.
- Verification: `pnpm benchmark:check` passed build plus all eight local path
  scenarios; `pnpm test:engineering` passed 55 Node tests and 8 Vitest tests;
  `pnpm verify:boundaries`, `pnpm verify:v2-docs`,
  `pnpm verify:package-readmes`, `pnpm graph:modules:check`, and
  `git diff --check` passed. The hosted Ubuntu CI job has not run in this task.

## Risks and Limitations

The initial P95 observations came from macOS ARM64 / Node 24.21.0, while CI is
pinned to Ubuntu 24.04 / Node 22.19.0. Review the first CI report before
tightening ceilings. A slowdown below a ceiling does not fail this gate; there
is no statistical cross-commit comparison. RSS/CPU measurement and external
provider paths remain deferred.
