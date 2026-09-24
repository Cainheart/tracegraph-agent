---
name: outlive-code-review-en
description: Review TraceGraph or Outlive code, PRs, or architecture implementation for evidence, authority, recovery, compatibility, and test strength; English workflow.
---

# Code review

This is a read-only review, not authorization to merge or modify a PR. Follow the [repository rules](../../../AGENTS.md). The Chinese equivalent is [outlive-code-review-zh](../outlive-code-review-zh/SKILL.md).

1. Establish the exact base/head and worktree state. Read the full diff, key callers, [current module docs](../../../docs/modules/), and relevant [Agent Notes](../../notes/README.md). V2 target docs are not evidence of current implementation.
2. Trace each boundary actually touched: which event or store owns truth; whether model-visible facts have evidence; whether tool side effects have Command, Receipt, Observation, and unknown/reconcile handling; whether another entry can bypass approval, credentials, sandbox, or workspace authority; whether cancellation, retry, and recovery are bounded; and whether protocol/storage upgrades preserve compatibility.
3. Check whether tests prove the regression through externally observable outcomes, especially failure, crash, concurrency, cancellation, and negative controls. For a new interface, inspect real consumers and cleanup. Compare reported checks with [pre-push verification](../outlive-pre-push-en/SKILL.md), but a green gate does not prove semantic correctness.
4. Report only locatable issues: file and line, trigger, impact, evidence, and priority. Separate blockers, suggestions, and questions. If no issues are found, state the review scope and residual risk; do not invent defects.

Review itself makes no writes. Relevant read-only or reversible diagnostics are fine; do not mutate user files, external services, or release state merely to demonstrate a concern.
