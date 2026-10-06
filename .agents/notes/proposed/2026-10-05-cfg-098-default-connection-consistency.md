---
id: 2026-10-05-cfg-098-default-connection-consistency
title: Default connection and effective option consistency
status: proposed
language: en
owners: [host, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [packages/contracts, packages/host, packages/sdk, packages/workbench, apps/desktop, apps/cli]
supersedes: []
---

# Agent Note: Default connection and effective option consistency

[中文](2026-10-05-cfg-098-default-connection-consistency.zh.md)

## Current gap

Saved services can be selected per conversation, but their global default has no public selection command. Project defaults can retain an incompatible model or reasoning effort when the service changes. The permission trigger presents a saved Full choice as Workspace access while the grant is pending or revoked. Several test-result labels lack Chinese translations.

## Accepted decision

Add an optional public `default_revision` and a persisted version defaulting to zero for older profiles. A non-empty default-selection command binds its canonical command ID, expected default revision and target connection revision. Only a saved writable connection with a credential can be selected; environment-managed connections remain read-only without preventing selection of ordinary saved connections. The same controller serves HTTP, SDK, fixed Desktop and CLI. Canonical Journal receipts, including failures and unknown outcomes, are read-only inspectable by the original ID; no automatic mutation retry. Existing task configuration and credential leases remain unchanged.

Project option controls normalize dependent model/effort choices when the service or model changes. Metadata distinguishes draft changes from saved source and effective values. The Host independently rejects unsupported reasoning efforts for the exact resolved service/model before policy or provider dispatch. It does not infer capabilities from model names or silently downgrade an explicit unsupported choice.

Full access labels separately describe saved selection, pending grant application and revocation. They never claim automatic Workspace fallback; users can explicitly select another preset. Wire enums and immutable policy ceilings remain unchanged. Translation changes are limited to actual result/credential/cost labels.

## Verification and recovery

Use real temporary profiles, canonical Journal and controlled loopback HTTP to verify CAS, conflicting intents, readonly targets, persistence/reopen, reasoning zero-dispatch rejection and task lease stability. Mounted UI negatives verify service/model/effort normalization, honest permission labels and explicit default selection/reconciliation. No user keys or paid provider requests are used. Existing frozen package proof is historical for this new slice; installation acceptance follows the parent's later build.

## Deferred boundary

This slice does not implement full settings inheritance, network proxy, Memory lifecycle, or capability inference. A lost response preserves the command ID and is inspected; the displayed current default alone is not evidence that that command completed.
