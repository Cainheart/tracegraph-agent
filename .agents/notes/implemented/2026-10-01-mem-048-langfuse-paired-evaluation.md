---
id: 2026-10-01-mem-048-langfuse-paired-evaluation
title: Memory and Experience paired evaluation protocol
status: implemented
owners: [langfuse-integration, memory, experience]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [external-evaluation, memory-quality, experience-quality, privacy]
supersedes: []
---

# Agent Note: Memory and Experience paired evaluation

## Problem

The roadmap requires independent paired Memory and Experience reports with benefits, harms, confidence intervals, and traceable dataset/run evidence. MEM-048 also depended on a V2 Memory eligibility consumer, a validated Experience lifecycle/retrieval consumer, and an available Langfuse environment. No quality result may be inferred from deterministic tests alone.

## Implemented prerequisites

- MEM-049 connects the V2 eligibility gate to an explicitly enabled Runtime consumer; the switch defaults off and G-21 V1 stays independent. See [MEM-049 Note](2026-10-01-mem-049-v2-memory-recall-runtime.md).
- MEM-050 provides owner-scoped Experience lifecycle persistence/replay and validated-only Runtime retrieval with scope/applicability/counterexample checks and Context provenance. See [MEM-050 Note](2026-10-01-mem-050-experience-lifecycle-consumer.md).
- A loopback-only self-hosted Langfuse 4.48.0 project and local Ollama `qwen3:4b` were provisioned. Only reviewed synthetic fixtures were evaluated; no user, production, or repository content was sent to a hosted service.

## Decision and implementation

Run Memory and Experience as separate paired studies, each with the same frozen 48-item dataset in its control/treatment arms. The only intended difference is the corresponding Runtime recall switch. Use `verified_task_completion_rate` with exact-token expected outputs as the primary metric. Retain item-level traces/scores, run-level scores, paired differences, harm checks, latency, and a task-family-stratified 95% paired bootstrap with 10,000 resamples. Langfuse remains outside local CI and does not replace deterministic security gates.

The first local synthetic pilot finished on 2026-10-01 with all four runs at 48/48 items:

| Lane | Dataset | Control run | Treatment run | Paired result |
|---|---|---|---|---|
| Memory | `mem048-memory-synthetic-holdout-20261001062250-6305985b`, SHA-256 `d69a25841c97678bf69c1431969574a3c2ec3358a41744784270b5c73289da22` | [2342a18248967a5b](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5dnui005vp406dv91i9kh/runs/2342a18248967a5b) | [306fe8d467b6d916](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5dnui005vp406dv91i9kh/runs/306fe8d467b6d916) | 24 wins / 24 ties / 0 losses; +50.0 pp; 95% CI `[+50.0, +50.0] pp`; 0 treatment regressions |
| Experience | `mem048-experience-synthetic-holdout-20261001062250-6305985b`, SHA-256 `729941b54f0756fc3734f5ca52e444167a9c03b4a9c79cd54fc1456018c3a3a1` | [d0986e3d146f1199](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5do64007ap406a3nmph4q/runs/d0986e3d146f1199) | [8872fbd2051218e4](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5do64007ap406a3nmph4q/runs/8872fbd2051218e4) | 32 wins / 16 ties / 0 losses; +66.7 pp; 95% CI `[+66.7, +66.7] pp`; 0 treatment regressions |

Langfuse v4's dataset read API did not return a version field. The report therefore records `version: null` and pins the exact inputs by dataset name, frozen SHA-256, item count, and Langfuse run references rather than inventing a timestamp version. The final case IDs (`mem-101..148` and `exp-101..148`) were not used in earlier Runtime diagnostics; the preceding completed run that overlapped `mem-001/002` is preserved but excluded. V3 Scores API read-back verified one aggregate score and 48 item scores per arm; aggregate scores were Memory `0.5/1.0` and Experience `0.3333/1.0`. One treatment trace per lane was queried and resolved to a stored observation. The full report includes every pair, score/trace ID, model/configuration digest, and verification record.

The model was local Ollama `qwen3:4b`, digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`, Ollama `0.35.0`, temperature `0`, seed `20261001`; the structured answer schema and evaluator are versioned in the report. Mean latency was Memory `380.7/425.0 ms` and Experience `393.4/462.9 ms` (control/treatment). Cost is unavailable from local Ollama.

## Interpretation and deferred work

Status is `completed / exploratory-inconclusive`: the synthetic pilot demonstrates that both paired consumers, Langfuse datasets/runs, trace ingestion, scores, and report computation are connected. It does not establish quality on independently collected real-world tasks, general benefit, release thresholds, or general no-harm. There was one sample per task item; outcomes were deterministic within task families, so both stratified bootstrap intervals collapse to point intervals. Follow-up real-distribution validation belongs to EVAL-074 and requires its own approved, minimized dataset and preregistered plan. A Memory × Experience interaction study remains deferred.

## Invariants and rollback

- Langfuse scores do not prove privacy, authorization, scope isolation, revocation, deletion, injection, or side-effect safety; local deterministic gates own those claims.
- No raw user/session data, production Memory, repository source, credential, or stable identifier is sent to a hosted service by this study.
- Invalid runs are retained with reasons and excluded from metrics; a corrected study uses new dataset/run IDs rather than rewriting historical Langfuse records.
- Langfuse outages or missing authorization do not block local tests or CI.

## Acceptance criteria

- [x] Paired arms, primary metric, harm categories, privacy rules, and report fields are specified.
- [x] V2 Memory eligibility and validated Experience consumers are implemented and locally verified.
- [x] Both 48-item paired reports include dataset digests, model/config/evaluator versions, benefits, harms, confidence intervals, and Langfuse dataset/run refs.
- [x] Langfuse run-level and item-level scores and representative traces were read back from the local instance.
- [x] External evaluation remains independent from local CI and safety gates.

## Evidence

- Full local report (mode `0600`): `/Users/cain/.local/share/tracegraph-mem048-langfuse/reports/mem048-20261001062250-6305985b.json`.
- Invalid/excluded run ledger (mode `0600`): `/Users/cain/.local/share/tracegraph-mem048-langfuse/reports/invalid-attempt-20261001.json`; invalid ingestion attempts, a one-item historical-version mistake, and the diagnostic-overlapping completed pilot are excluded from metrics.
- Local implementation and engineering checks: root typecheck, focused Contracts/Evidence/Context/Core suites, Runtime tests, `pnpm test:engineering`, boundary/docs/package-readme/module-graph checks, and `git diff --check`.
