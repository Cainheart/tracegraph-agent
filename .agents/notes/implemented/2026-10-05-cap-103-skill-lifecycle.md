---
id: 2026-10-05-cap-103-skill-lifecycle
title: Scoped local Skill management with canonical receipts
status: implemented
owners: [capabilities, host, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [CAP-103, packages/contracts, packages/core, packages/host, packages/sdk, packages/workbench, apps/cli, apps/desktop]
supersedes: []
---

# Agent Note: Scoped local Skill management with canonical receipts

[中文](2026-10-05-cap-103-skill-lifecycle.zh.md)

## Problem and initial state

The existing [SkillRegistry](../../../packages/core/src/domains/skill/skill.ts) validates and freezes local Markdown Skills. Projects override user definitions and allowed_tools only restricts existing Tool/Policy authority. The settings surface lists registered projects; it cannot manage the profile's global Skills without a project. It lacks file CRUD, bounded imports, scope-level enablement CAS and uncertain-write reconciliation.

## Accepted implementation scope

The human authorized the existing CAP-103 plan. Add typed list/read/validate/command/receipt methods over the shared Host. Global scope is only the selected private profile's fixed skills directory; project scope is only a registered workspace's fixed .tracegraph/skills directory. Browser/native file selection supplies explicitly selected UTF-8 SKILL.md content, bounded at 256 KiB. No endpoint accepts source paths, URLs, downloads, scripts or credential configuration.

Reuse the existing parser and scanner. Explicit content reads stay local; catalog/list and canonical receipts contain metadata and hashes, never Markdown body or profile paths. Create/import/edit bind the original file SHA; enablement, recoverable removal and restoration bind both file SHA and scope-state SHA. Removal writes a tombstone and retains the original local file. Tombstones persist across restart and external body edits do not restore the Skill. Removing or disabling a project override can reveal its enabled global definition. Project policy, immutable selected permission, exact ask approval and workspace coordination remain mandatory. No model or API settings can grant authority. Project definitions retain precedence; disabling a project override exposes an enabled global definition. Existing disabled_skills remains an additional restriction. New Runs resolve the latest enabled registry; admitted Runs keep their frozen definitions.

Command ID serialization precedes scope serialization, with a second intent digest check after requested-event append. Every mutation uses the canonical SessionEvent ledger: intent digest, policy digest, precise approval when needed, dispatch and receipt. A lost/partial write is unknown and cannot dispatch again; explicit receipt inspection can read current file/state hashes without treating observation as completion. No silent mutation retry. Scope state is bounded and checked before dispatch. The Runtime filters source enablement before same-name precedence, without introducing another loader.

## Alternatives and boundaries

A second Markdown loader and arbitrary host-file import were rejected because they duplicate validation or introduce path authority. Remote marketplaces, automatic downloads, executable bundled helpers and credential-bearing Skill archives are deferred. This slice covers one bounded SKILL.md, not arbitrary multi-file packages. Windows writes stay unavailable. Linux binds operations through a directory FD. macOS probes Darwin O_NOFOLLOW_ANY and uses it at the final file/parent open, with file/directory identity checks; unsupported kernels fail closed. This is not an atomic openat transaction or protection against every same-UID real-directory replacement race. Identity drift or post-dispatch uncertainty remains unknown.

## Migration and rollback

Retain existing @tracegraph wire/package scope and .tracegraph project layout. Shared selected profiles use their explicit skills root; standalone legacy scanner/CLI defaults remain compatible and are not silently imported. Add per-scope enablement state; missing state means enabled. Legacy global disabled_skills remains restrictive. Existing Skills stay readable without rewriting their contents. A rollback removes new management routes/UI while leaving existing Skill files and audit events intact.

## Acceptance criteria

- [x] Real disk global management without projects; project override and enablement timing.
- [x] Create/import/read/edit/remove/restore/validate with CAS, conflicts and exact scoped approval.
- [x] Symlink/hardlink/private escape, invalid UTF-8/size, read-only/deny and body-leak negative tests.
- [x] Unknown receipt/readback never repeats a write; transport/CLI/UI parity tests.
- [x] Current module and bilingual evidence distinguish this slice from complete CAP-103.

## Evidence

[Current evidence](../../../docs/validation/skill-management/README.md) links actual files and raw logs: Host controller 11, built Host/SDK HTTP 2, Core 4, SDK 2, CLI 28, shared Skills UI 7, and broader Workbench 314 tests at the Skills checkpoint. The final visual-retention/Help increment separately reports its updated Workbench count.

Actual HTTP acceptance includes global management without a project, exact ask approval, original-file CAS, restart-persistent tombstones, canonical receipts and a controlled model fixture proving an admitted task reads its old frozen Skill while the next task reads the updated version. Real disk negative tests include a private-body hardlink scanner defect before the fix, a final-open ancestor symlink attack leaving no private file (including an empty file), and concurrent conflicting command IDs across global/project scope producing only the first effect. Failed harness decision/cleanup attempts are preserved as fixture failures, not product passes.

[Module 17](../../../docs/modules/17-Skill系统.md) and the [bilingual user guide](../../../docs/user-guide/README.md#topic-skills) reflect this source-level slice. Fixed Desktop transport is implemented and separately tested; installed native GUI/Windows acceptance is pending, not inferred from callbacks. Full CAP-103 marketplace, signed distribution and multi-file installation remain outside this bounded implementation. No production, paid-provider quality or independent external-user claim.
