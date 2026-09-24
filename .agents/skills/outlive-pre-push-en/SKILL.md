---
name: outlive-pre-push-en
description: Select and run the smallest credible checks for an actual TraceGraph or Outlive diff before a push, review handoff, or claim that validation passed; English workflow.
---

# Pre-push verification

This skill selects, runs, and reports checks. It does not authorize committing, pushing, rewriting history, or bypassing a failed gate. Read the [repository rules](../../../AGENTS.md) first. The Chinese equivalent is [outlive-pre-push-zh](../outlive-pre-push-zh/SKILL.md). Run commands from the repository root.

## Identify the change

1. Run git status --short --branch and git diff --check; inspect staged, unstaged, and untracked changes. For a remote review, verify the real base before inspecting the full diff against it. Do not guess the base or overwrite someone else's work.
2. Classify behavior, protocol, storage, tooling, docs, and tests changes; identify owners, consumers, and failure paths. Source, tests, and [module docs](../../../docs/modules/) describe current behavior; the [V2 charter](../../../docs/outlive-agent-v2.md) is still a proposal.

## Select gates

Start with the narrowest check that could disprove this change; broaden only across affected boundaries:

- Package behavior: run the owning package's test/typecheck first. Rebuild after contracts or generated declarations change, then run pnpm typecheck and adjacent consumer tests.
- Repository scripts: run their owning script tests; pnpm test:engineering covers engineering scripts.
- Docs and Notes: use the existing docs eval and manually check changed local links, frontmatter, V2 manifest, and roadmap. See [doc sync](../outlive-doc-sync-en/SKILL.md).
- Dependency or lockfile: run pnpm verify:lockfile. A security audit requires network access and is not an offline result.
- Broad runtime changes: expand proportionally to pnpm test, pnpm evals, or pnpm test:e2e; E2E may require services and credentials.
- Release artifact changes: use [release check](../outlive-release-check-en/SKILL.md). release:bundle writes files and is not a default read-only gate.

Do not run the whole suite merely because a push is planned, and do not repeat an already passing command without cause. Record exact commands, pass/fail/not-run state, and scope; verify the selected test count, since zero selected tests is not evidence. On failure, stop the ready-to-push claim and report the blocker. Never silently update a baseline or bypass a gate.

## Output

Report change scope, selected gates and rationale, each command's result, and uncovered risks. If a separate user request authorizes pushing, verify remote CI afterward; local success is not remote success.
