---
id: 2026-10-03-current-workbench-recovery
title: Recoverable owner connections and a complete conversation workbench
status: implemented
language: en
owners: [host, desktop, workbench]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/host, packages/contracts, packages/sdk, packages/workbench, apps/desktop, apps/cli]
supersedes: []
---

# Recoverable owner connections and a complete conversation workbench

## Problem
The installed Desktop retained stale authority after external owner restart, while settings described a connection failure as unsupported functionality. A real Web journey also reproduced the same gateway with a rotated bearer: its next explicit file save was rejected before admission. The composer differed between views, model choice was global, and the native icon contained repeated cropped backgrounds. The retained failed attempts distinguish product defects from harness mistakes.

## Current implementation
[The shared supervisor](../../../packages/host/src/local-connection-supervisor.ts) rebinds owner identity and generation, bounds recovery, preserves explicit stop and never resumes interrupted tasks. Desktop activation probes the owner; CLI shares this supervisor. A fresh, explicit application launch can repair a deliberately stopped owner once; activation or reopening a window in the existing Main process preserves the stop intent. [HTTP authority](../../../packages/sdk/src/index.ts) uses one bounded bootstrap request before an explicit live mutation, then dispatches once. Late authority transitions cannot replace Replay credentials. A closed authentication rejection is distinguishable from an unknown dispatched outcome through the fixed Main/preload bridge.

[Conversation control](../../../packages/host/src/conversation-control.ts) persists saved connections and Session next-run options, retaining legacy credential references. Model, credential version and policy are frozen at admission. Local Full eligibility is consented separately from the workspace-write new-session default and cannot exceed an administrator ceiling. Removing or clearing a connection does not invalidate admitted tasks; new tasks require a usable credential. Plan mode reaches the Runtime's write restrictions. Per-model image-input declarations persist with the connection and freeze at admission; undeclared models fail closed, and a text connection test does not certify image support.

[Files and feedback](../../../packages/host/src/project-files-feedback.ts) provide bounded project listings, UTF-8 reads, validated image previews and hash-conditioned saves with exact approval, workspace coordination, durable receipts and reconciliation. Feedback binds the actual public answer and stays local. [The editor](../../../packages/workbench/src/components/ProjectFiles.tsx) preserves unaccepted intents for explicit retry, queries unknown outcomes, and retains a successful save receipt if its later read fails. [The shared workbench](../../../packages/workbench/src/App.tsx) uses one composer, with Add/Permissions/Plan on the left and Model/Submit on the right, and an on-demand Files/Changes/Terminal/Preview/Artifacts panel. Change cards require actual applied receipts rather than previews; history inspection is read-only.

Project file context is a versioned project-relative selection, separate from the user task and image/PDF staging. Host admission rechecks policy, path and hash and freezes bounded UTF-8 snapshots. Core accepts them only through its trusted dispatch, writes scoped redacted `project_file_context` Artifacts and supplies untrusted observations and manifest provenance. Plain chat has no project file selection. Explicit recovery reads the admitted Artifact rather than rereading a changed workspace file. Client-provided content never becomes trusted context.

[B Current](../../../docs/brand/current.svg) is the sole production vector. Fixed resvg rendering derives transparent marks and a single warm native board, complete ICNS and multi-size ICO. Build and installed inventories separately identify delivered bytes. Legacy package names, schema identifiers and original ledgers remain compatible technical identifiers; public branding is Outlive Agent.

A successful first startup and a privately validated same-process owner replacement must not spend the repeated-crash budget. Failed startup and actual replacement processes remain bounded; a planned replacement never erases earlier crash charges. This boundary is independently testable and is not asserted as the unproven cause of the retained native021 timeout.

## Invariants and boundaries
The Host owns business state and one Runtime writer. No private reasoning, secret, editor content or image bytes enter public receipt metadata. Reconnect, detail expansion and historical inspection do not execute tasks. Replay cannot bootstrap live authority or write. An unknown dispatched write is reconciled, never automatically repeated. File descriptors remain pinned to authorized inodes, but an external writer can race the final hash check; this is not an atomic filesystem transaction. Existing UTF-8 files are bounded to one MiB. Native Windows behavior and model-service quality require their own evidence.

## Migration and rollback
Legacy single-provider data becomes the default saved connection; old directories and events are preserved. Model edits use revisions and versioned credentials; active leases retain their admitted versions. Application replacement leaves the profile outside the bundle and retains a recoverable prior bundle. Different live product builds cannot share an owner; an idle explicit stop precedes replacement. Runtime crash recovery restores facts and marks interrupted Runs without executing them.

## Verification
[The current report](../../../docs/validation/current-workbench-recovery/README.md) retains full build/types/unit/engineering/evaluation logs, negative authority and file fixtures, actual owner-process restart/crash/stop tests, independent external-state oracles and GUI attempt records. The final8 clean build/type checks and 1,571 unit tests passed. Web attempt024 and the actual final8 DMG-installed Desktop attempt025 passed all three window sizes in light/dark themes, respectively 9 and 11 actual journeys and 4,314/4,429 independent checks. A separate packaged smoke passed 13 assertions without external Node/pnpm. The default installed application auto-started and loaded permissions, memory and model settings; Finder and App Information showed the complete B Current icon. Dock was not observable through the enabled CUA surface and remains unverified. Historical failed attempts and their limits remain unchanged; Native021 recovery timeout has no proven cause. Actual OS sleep/wake, Windows native behavior and clean-machine distribution remain unverified.

## Deferred release conditions
Signing/notarization, clean macOS/Windows installation and upgrade, native Windows UI/PTY/icon checks and independent non-maintainer acceptance remain release conditions. Loopback-provider fixtures do not establish paid-provider quality, account access or cost.
