---
id: 2026-10-05-desktop-quit-lifetime
title: Confirm window departure before detaching the Desktop client
status: proposed
owners: [desktop, sdk]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [APP-105, HOST-087]
supersedes: []
---

# Confirm window departure before detaching the Desktop client

[中文](2026-10-05-desktop-quit-lifetime.zh.md)

## Current evidence

The real Source Electron PID 47891 remained alive after native Quit while its private sockets had disappeared; the independent fixture Host 23666 remained healthy. The original failure cause is not established. A real private UDS idle SSE abort completed normally, and a plain actual Main quit exited normally. These results reject a blanket claim that every pending SSE abort hangs.

Two independently reproduced defects require the bounded correction: returning a real private SSE iterator after an event leaves its response open; and an actual Main renderer `beforeunload` veto leaves a window alive after `before-quit` has already detached the client. The latter reproduces with the same guard used by unsaved project-file editing, but the reported original session had no file edit; it must not be called the proven original cause. Preserve the negative logs and the initial invalid top-level-await oracle separately.

## Decision

Detach client resources asynchronously at `will-quit`, after windows accept departure, rather than `before-quit`. After resources settle, schedule final `app.quit` with `setImmediate` so the native quit transaction has unwound; same-turn promise re-entry was independently observed being ignored. Track requested/finalized departure to prevent activation or notification navigation from recreating a window during actual shutdown. A native unsaved-edit warning offers Keep editing or Discard and quit; only explicit discard bypasses the renderer veto. Cancelling retains the same renderer and authenticated client. Ordinary window close while the Tray exists hides that same window, preserving drafts; it does not quit or stop the Host.

SDK SSE readers actively cancel their response on abort or iterator return, remove the abort listener and release the reader lock after cancellation. The private transport/Run authority is unchanged. Closing a client or stream never calls Run cancellation or `host.stop`. No timeout, recovery budget, public protocol, permission ceiling or persistence format is broadened.

## Verification and recovery

Use real UDS HTTP SSE sockets and actual Electron/Main window events, not only abort-aware mocks. Prove idle cancellation, iterator-return response release, clean quit, explicit dirty cancellation with a connected retained client, explicit discard quit and background Host survival. Record raw failure and passing commands. Native original-failure reproduction remains a separate gate. This Note stays proposed/unreviewed until the owning documentation and evidence agree; it is not final installed or Windows native acceptance.

## Scoped verification

[Raw failures and passing evidence](../../../docs/validation/desktop-quit/README.md): real UDS SSE return negative; actual dirty-veto and same-turn native Quit negative; SDK 55, private SSE/supervisor 15 and Desktop 77 tests passed. Actual Source Main plain, dirty Cancel (connection retained) and dirty Discard exited 0 with the QA Host surviving; fixed dialog choices are fixture responses, not human OS-dialog validation. SDK/Desktop types and targeted builds passed. Host types awaited the concurrent Core delivery-review declaration build. Original PID 47891 was cleaned up with authorized SIGTERM; its precise cause remains unknown. Joint installed/native Quit acceptance is separate.
