---
id: 2026-10-03-ux-086-conversation-workbench
title: Conversation-centered Workbench and Desktop commands
status: implemented
language: en
owners: [workbench, desktop]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/workbench, packages/api, packages/sdk, apps/web, apps/desktop, apps/desktop-host]
supersedes: []
---

# Agent Note: Conversation-centered Workbench and Desktop commands

## Problem

UX-086 requires a visibly revised shared workbench and working Desktop routes. DESK-065 extracted the existing Web UI; extraction did not deliver the new interaction design.

## Previous state

[App](../../../packages/workbench/src/App.tsx) opened the trajectory by default. [Desktop adapter](../../../apps/desktop/src/desktop-sdk.ts) exposed a limited command slice. Approval, Todo and Artifact operations were unavailable through that adapter.

## Decision

The shared shell opens a conversation, anchors its composer, keeps project/session navigation visible, and exposes activity, changes and details as explicit contextual views. Pinned sessions are a disposable local view preference. Layout at 1024x768 retains the usable workspace. Model effort labels are readable, and saved theme preferences remain valid.

The reference is observable generic interaction described in [official features](https://learn.chatgpt.com/docs/features) and [official engineering workflow](https://developers.openai.com/blog/mastering-codex-remote-for-engineering). Layout choices are Outlive design judgments. Local Codex CUA inspection was denied; no restriction was bypassed and no private application data or brand assets were copied. The [journey map](../../../docs/validation/ui-086-workbench-ux/reference-and-journeys.md) records the mapping and limits.

[RunInteractionController](../../../packages/api/src/run-interaction-controller.ts) resolves a canonical Run's registered project, authorizes the request and verifies response identity before using the existing Runtime approval, plan, input, Todo and Artifact ports. Desktop consumes this controller through closed, schema-validated Main/preload/private Host messages. Web retains its existing Runtime ingress. Protocol v2 remains unchanged: its existing 16 positional fixtures remain and 14 new fixtures are appended. Explicit session resume returns the same receipt for an exact in-process retry.

Desktop plain chat has a Host-managed isolated workspace with filesystem/tool capabilities disabled. Supported routes now cover chat, session rename/delete/resume, patch and plan decisions, Todo read/write, input, cancel/stop and Artifact reads. Failed operations remain visible. Live projections poll every 500 ms; Preview stays labelled and uses deterministic synthetic data without Host/model startup.

Desktop Main resolves an independent Node executable in its trusted composition layer, canonicalizes its absolute realpath, and probes the supported version, non-Electron runtime and executable identity using a minimal environment. It explicitly forks the private Host with that validated executable and no inherited exec arguments. Missing or unsupported Node returns typed setup_unavailable. This avoids using Electron's process executable for sandboxed Node tests; the environment allowlist and Seatbelt scopes stay unchanged.

## Alternatives considered

A CSS-only reskin leaves command and journey gaps. A separate Desktop UI duplicates presentation state and conflicts with the shared Workbench boundary.

## Invariants and boundaries

Renderer isolation, fixed IPC, closed schemas, permission/approval authority and Memory/export consent remain enforced. No generic renderer invoke, filesystem access, new Desktop network listener, client-authored canonical event or private model reasoning display is introduced. Public plans and actual tool receipts supply progress.

Attachments, transient model streaming, replay/rollback and optional Team/extension settings are still unavailable through the Desktop bridge. Cloud execution, account sync, collaboration, signing and auto-update are outside UX-086. No complete Codex feature parity is claimed.

## Migration and rollback

No persisted format migration is required. Preserve ledger, sessions and saved view preferences. Roll back shared presentation and additive Desktop messages together, then rebuild matching Main/preload/Host artifacts. Do not automatically replay side effects.

## Acceptance criteria

- [x] Web/Desktop live journeys and schema/authority negative tests.
- [x] Empty, loading, unavailable, failure, cancellation and session recovery cases.
- [x] Stateful evidence at 1440x900, 1280x800 and 1024x768.
- [x] Owning docs, roadmap, fresh release evidence and this paired Note synchronized.

## Risks and remaining evidence

The model fixture is synthetic; Runtime, clients, Hosts, ledger, file/test oracles and process recovery execute real code. This proves engineering behavior, not provider quality. Maintainer Agent installation simulation does not satisfy independent external-user evidence or signed public release.

## Evidence

- [Validation report](../../../docs/validation/ui-086-workbench-ux/README.md).
- [Journey receipts](../../../docs/validation/ui-086-workbench-ux/evidence/report.json).
- [Fresh install evidence](../../../docs/validation/ui-086-workbench-ux/release/README.md).
- [Workbench journey tests](../../../packages/workbench/src/ux-086-journey.test.tsx).
- [Interaction boundary tests](../../../packages/api/src/run-interaction-controller.test.ts).
- [Real private Host journeys](../../../apps/desktop-host/src/desktop-journey.test.ts).
