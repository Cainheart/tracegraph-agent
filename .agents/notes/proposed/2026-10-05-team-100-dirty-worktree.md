---
id: 2026-10-05-team-100-dirty-worktree
title: Trusted writable child workspace with an authorized dirty baseline
status: proposed
owners: [host, runtime, contracts]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [TEAM-100]
supersedes: []
---

# Trusted writable child workspace with an authorized dirty baseline

[中文](2026-10-05-team-100-dirty-worktree.zh.md)

## Decision and scope

The optional trusted Runtime child-workspace resolver is separate from the Agent Loop. The existing readonly default role is unchanged. Standard Host composition publishes the closed compiled `readonly` and `isolated-coder` catalog; trusted explicit profile selection remains available for compatibility. The model selects a published role name/task/budget, never workspace paths, credentials, tools or permission authority. Plan and readonly parents explicitly reject writable roles. A write-capable child requires this resolver. Its workspace capabilities and effective policy may only narrow the admitted parent, and its shared Goal request budget remains inherited.

Host creates a private detached Git worktree from a stable authorized baseline: verified HEAD, source index digest and bounded regular tracked/untracked worktree bytes. Creation never stages, stashes, resets, cleans or checks out source files, and never merges results. Reads obey the parent's frozen read policy. Private paths, symlinks, hard links, submodules, conflicted index, unsupported Git state, oversized files/tree and concurrent source drift fail closed. Ignored dependency/build files are not a baseline and are not copied; required dependencies must be explicitly installed in the isolated workspace in a later supported capability. This first slice supports existing-HEAD ordinary Git repositories only.

Model-facing spawn schemas enumerate only the trusted compiled role names; an empty catalog remains safe and the executor rejects unknown names. `isolated-coder` supports only exposed patch/test tools and discovered, hash-bound existing project commands. Each child forks its own immutable model configuration/capability/credential lease from the parent snapshot. A child terminal releases only that child lease; rotating the saved connection cannot retire the old credential until every admitted parent/child using it settles.

The canonical Host command journal owns preparation receipts and unknown outcomes. Safe baseline identifiers/hashes are frozen into parent delegation and child creation/recovery provenance. No file contents, absolute paths or credentials are emitted into public receipts. Host retains a private manifest mapping the generated binding to its root. A separate child-workspace lease uses the existing child permit ceiling without reacquiring the parent's write lease or consuming a blocking root-Run slot. The lease releases after a durable child terminal; generated worktrees remain for human review, including failed preparation after any side effect. No automatic cleanup or merge is added.

Writable child recovery fails closed in this slice, preserving the isolated root/diff for review instead of silently restoring into the parent's workspace. Parent ledger reconciliation continues to use child terminal facts. Manual role configuration, nonblocking multi-round orchestration, model-role registry, merge/CAS workflows, reviewer/UI validation agents and the relationship graph are outside this slice; it is not full TEAM-100 completion.

## Verification requirements

Tests must compare the actual source HEAD/index/file tree before and after creation and child writes, including staged, unstaged and untracked bytes. Two child roots must differ and share the frozen budget without source writes. Negative oracles cover read policy/parent capability ceiling, source drift, missing resolver, symlink/hardlink/private/oversize/conflict/unsupported state, failed preparation retention and command idempotency. No default profile or native computer input is used. Current documentation must distinguish this trusted composition backend from a generally available three-client Team product.


## Current evidence and deferred scope

The backend slice is verified in [current module 16](../../../docs/modules/16-Agent-Team.md) and the [TEAM-100 actual-state report](../../../docs/validation/team-100/backend-slice.md). Contracts 20, Core 31 and Host 22 focused tests passed in the current working tree. The real parent/two-child provider fixture first proved early credential deletion, then passed with independent immutable model leases; raw failing/passing receipts are retained. Native Git/Seatbelt child patch/project-command oracles ran on macOS. No actual GUI, final installer, native Windows or full TEAM-100 product closure is implied.

The Note remains proposed until final joint build/current documentation and the explicitly scoped roadmap closure are reviewed; its bilingual pairing is mechanically registered as unreviewed. Generated worktrees and private baselines remain retained by product policy; fixture cleanup is separate test ownership.
