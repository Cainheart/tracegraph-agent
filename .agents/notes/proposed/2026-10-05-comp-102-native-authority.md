---
id: 2026-10-05-comp-102-native-authority
title: Scoped native computer authority and handback
status: proposed
owners: [host, contracts, desktop]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [COMP-102]
supersedes: []
---

# Scoped native computer authority and handback

[中文](2026-10-05-comp-102-native-authority.zh.md)

## Decision

Native computer control is separate from filesystem permission. The Host owns a typed controller and private compiled OS helper. macOS uses actual Accessibility, window-only ScreenCaptureKit capture and Quartz input; Windows has a UIA/Win32 helper source and separately reported native acceptance. Host status must report missing helper, OS permission, input observation or locked session accurately. Codex CUA and QA automation are never the product backend.

Only a trusted human interaction seam may grant once/always authority to an explicitly selected application. A model action cannot create or approve a grant. Persistent grants bind application identity, not a reused PID; each operation rechecks PID/window identity and OS state. A single global input lease is required for actions. External input, lock, revoked grant or unavailable monitoring pauses/invalidates dispatch immediately; resumption requires the human seam. Replay cannot acquire authority or mutate.

The helper protocol is closed and bounded, uses no shell, and accepts no arbitrary executable or AppleScript. Input targets only the granted foreground window; it cannot click global menus or a newly focused foreign window. Observe/capture results distinguish AX facts from pixels, retain a canonical command receipt and bounded Artifact, and never claim an action succeeded merely because an input event was posted. Interrupted writes remain unknown and are not retried automatically.

Trusted human input confirmation explicitly includes bringing the exact granted application/window to the foreground. Composition may call the private backend `focusTarget` only after that confirmation. It is absent from HTTP/SDK/tool commands. Validation before confirmation checks identity without requiring foreground; validation after confirmation and every input requires the exact foreground target. A failed focus, foreign-window change or denied confirmation never starts an input lease.

Outlive control/authorization windows and OS permission settings are excluded native targets. Granting these would let model-generated clicks approve their own authority; a filesystem or ordinary application grant must never bypass trusted human authorization. The helper enforces the same exclusion independently of the controller.

## Scope and acceptance

First slice: real status/application enumeration, AX observation/window capture, grant/revocation, exclusive lease/manual handback and safe bounded action dispatch. Tests prove no self-grant, competing lease, revocation, external input/lock pause, identity mismatch, cancellation and receipt reconciliation. Native macOS evidence and Windows source/build/native acceptance are separate. Packaging, UI picker, operation tools and both-platform end-to-end acceptance are required before COMP-102 can be complete.

## Recovery and boundaries

Persist grants and canonical receipts privately, but do not recover active input leases. Host restart requires a new human-acquired lease; no historical input is replayed. The helper does not promise containment of an already fully privileged external program, hardware input during an indivisible event or detached third-party automation. A full-access filesystem preset never substitutes for Accessibility/Screen Capture/input-monitoring consent.
