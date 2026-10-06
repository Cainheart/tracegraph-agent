---
id: 2026-10-05-cfg-098-inheritance-history
title: Configuration inheritance and safe settings history
status: proposed
owners: [host, contracts, sdk, cli]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [CFG-098]
supersedes: []
---

# Configuration inheritance and safe settings history

[中文](2026-10-05-cfg-098-inheritance-history.zh.md)

## Decision

Resolve new dispatch options in this order: explicit request, persisted session overrides, profile-owned project defaults, current global model/reasoning and permission defaults. Omission means inheritance; legacy complete session records remain explicit overrides. New sessions persist only explicitly supplied values. A CAS reset removes selected overrides without changing admitted Runs. Project defaults cannot exceed the immutable Host ceiling or bypass revoked consent and restriction-only project policy.

Use the existing canonical Workbench command journal for profile settings history. Record a safe initial checkpoint and each successful update/restore with revision, command and redacted settings; do not persist credentials or literal tool environment/argument values in history or command receipts. Restoring creates a new revision, requires the current revision, and retains current sections containing redacted historical fields. Credentials, consent and repository policy are outside settings restore authority. Original private settings remain the live configuration source; existing history is not rewritten. Unknown command outcomes remain unknown and are not redispatched.

## Scope and verification

This slice delivers global/project/session inheritance and profile settings history/restore through the authenticated Host, typed SDK, fixed Desktop bridge and CLI. Per-project/session history restore, client-specific appearance inheritance, safe-idle automatic restart of every setting and credential history remain outside this slice. Tests must prove precedence, omission, legacy preservation, CAS conflict, restart persistence, redaction, revoked/ceiling authority and immutable admitted model snapshots.

## Recovery

Additive contracts preserve old reads. Existing saved session options migrate in memory to explicit overrides and persist on the next write. History restore never replays a Run or changes its frozen model/policy. Keep original files and ledger records on rollback.
