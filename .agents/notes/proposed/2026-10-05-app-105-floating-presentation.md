---
id: 2026-10-05-app-105-floating-presentation
title: Floating presentation of the same Desktop conversation
status: proposed
language: en
owners: [desktop]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [APP-105, apps/desktop]
supersedes: []
---

# Floating Desktop presentation

[中文](2026-10-05-app-105-floating-presentation.zh.md)

## Decision and current boundary

The tray and the native Window menu can switch the existing trusted window between its normal bounds and a smaller floating presentation. They can separately opt into always-on-top. Resize the same window without reloading its renderer, creating another client, or issuing a business command. This retains the current conversation, drafts, unsaved files and subscriptions; the shared Host remains their owner. The two native menu entries use fixed Main-owned identifiers and reflect the same controller state.

## Authority and failure behavior

Only fixed Main menu actions change native window bounds. Clamp saved bounds to a current display and keep close/restore accessible. No application-control grant, screenshot capture, credential access, Host start/stop, or task submission follows a presentation change. Always-on-top defaults off and is an explicit local window preference for the current application lifetime. A separate second renderer and contextual global screenshot attachment remain pending; this slice does not claim them.

## Validation and rollback

Main/controller tests verify one window without another renderer load, canonical command, or subscriber replacement, bounds restoration and independent pin state. On macOS the actual source Desktop Window menu was used to switch a disposable Profile to 880×700 and back to its normal 1440×920 bounds. An unsent draft remained present after the presentation switch. Retained screenshots and the actual shared-profile corroboration are in the [incremental report](../../../docs/validation/app-105/backend-slice.md). This source-window evidence does not prove packaged installation, native always-on-top stacking, notification delivery or Windows behavior. Rollback removes the two menu actions without altering Profile, conversations or Ledger. The wider APP-105 target remains incomplete.
