---
name: outlive-perf-eval-en
description: Run and interpret the existing G16 offline performance eval when TraceGraph or Outlive changes may affect Context, model calls, tool latency, or SSE first byte; English workflow.
---

# Offline performance eval

The repository has a [G16 fixture](../../../evals/perf/performance.eval.ts) and [baseline](../../../evals/baselines/performance.json), but not a full V2 benchmark harness. The Chinese equivalent is [outlive-perf-eval-zh](../outlive-perf-eval-zh/SKILL.md).

1. Specify the scenario, before/after revisions, machine/OS/Node version, and load. G16 Context token and model-call counts are deterministic constraints; tool P95 and SSE first byte are sensitive to local scheduling. A single noisy run is not a product performance conclusion.
2. From the repository root run pnpm build, then:

       pnpm exec vitest run --config vitest.evals.config.ts evals/perf/performance.eval.ts

   This is an offline fixture with no real model API spend. Inspect _tmp_evals/ for results worth retaining first: the run truncates existing metrics/*.json and updates ignored reports and metrics. Inspect measured values, thresholds, selected test count, and any correctness failure.
3. Before changing a threshold or recording a new baseline, explain the budget change and compare on the same environment; have the [baseline](../../../evals/baselines/performance.json) diff reviewed. TRACEGRAPH_EVAL_UPDATE=1 writes the baseline and must not be used simply to turn a failure green.
4. Report scenario, environment, before/after values, pass/fail, and noise limits. This covers the G16 representative path only; it proves nothing about V2 snapshots, desktop, or real-provider performance.
