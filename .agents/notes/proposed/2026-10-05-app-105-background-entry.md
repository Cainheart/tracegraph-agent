---
id: 2026-10-05-app-105-background-entry
title: Native background entry, notifications and active-task sleep prevention
status: proposed
owners: [host, contracts, desktop]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [APP-105]
supersedes: []
---

# Native background entry, notifications and active-task sleep prevention

[中文](2026-10-05-app-105-background-entry.zh.md)

## Decision

Desktop Main owns a real menu-bar/Tray entry while the independent local Host remains the single Runtime owner. Closing a window retains Main/Tray on supported platforms. Explicit quit detaches Main and leaves Host tasks running. A distinct, concrete user-confirmed stop-background-and-quit action dispatches the existing canonical `host.stop` command; it never silently cancels work during ordinary quit.

The shared profile settings controller stores the opt-in `general.prevent_sleep_during_tasks` flag (absent means false). Main uses existing typed settings CAS/history routes; no renderer-facing OS power or arbitrary notification API is added. `prevent-app-suspension` is held only while an opted-in, canonical active Run exists, never for idle/queued/approval waiting, stopped/offline or replay authority. It does not disable locking or promise overriding lid-close/manual sleep or OS policy.

Native notifications consume existing canonical Host `resources.notifications`, with stable event ID deduplication, profile/owner replacement checks and per-status notification preferences. The initial read is a historical baseline, not new event delivery. Body text excludes task contents. A click is a read-only navigation intent: Main verifies the current live Run/project/session before forwarding a closed identifier payload to the packaged renderer. A click never resumes or executes a historical task, approves input or clears explicit stop intent.

## Acceptance and recovery

Tests cover canonical event deduplication, no initial history notifications, preference gating, replay/offline shutdown, active-only power lifetime, owner replacement, safe navigation and stop-vs-quit. Missing OS notification permission/support is reported as unavailable; an API `show()` is not proof of OS delivery. No default profile mutation or login/startup registration is included. Actual macOS Tray and notification delivery and Windows native acceptance are separate evidence. Floating windows, quick attach, shortcut registration, safe update and installer/platform journeys remain outside this slice.
