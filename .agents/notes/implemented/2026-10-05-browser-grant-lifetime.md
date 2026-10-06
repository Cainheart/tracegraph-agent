---
id: 2026-10-05-browser-grant-lifetime
title: Browser authorization and launch lifetime fences
status: implemented
language: en
owners: [host]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [BROW-101, packages/host]
supersedes: []
---

# Browser authorization and launch lifetime

[中文](2026-10-05-browser-grant-lifetime.zh.md)

## Current problem and decision

Before this repair the isolated Browser controller closed only a browser that
had already launched. A pending trusted human confirmation could subsequently
persist a grant; a browser launch completing after close could create a new
context. A deterministic negative reproduced the late persisted grant.

The controller now passes a lifetime AbortSignal to trusted native confirmation,
rejects new and queued admission after close, and checks the lifetime again after
asynchronous confirmation and before browser context or evidence dispatch.
It tracks admitted work and settles it during idempotent close. A late launch
closes its browser without creating a context. Failed browser cleanup is an
explicit failure rather than ignored success. Production launch and human
confirmation retain bounded timeouts. An internal trusted launch seam is for
deterministic concurrency tests; clients cannot select a launcher or grant.

## Authority, compatibility and recovery

The HTTP contracts, grant format and canonical WorkbenchJournal receipts remain
unchanged. Closing does not erase receipts or claim dispatched page effects were
reverted. Writes admitted before close may settle their existing receipt; late
confirmation cannot admit new grants. Restart retains persisted authority but
never recreates browser contexts or replays interrupted writes. Existing trusted
confirmation callbacks may ignore the additional signal; the controller still
fences their late result. Native prompts should honor it to close their process.

## Acceptance and remaining scope

- [x] Pending human confirmation aborts; late approval creates no grant file.
- [x] Queued and new operations after close are rejected before admission.
- [x] Late launch is closed once without creating a context; cleanup failure is visible.
- [x] Existing real DOM effects, takeover retries and canonical receipts remain valid.

Implementation: [controller](../../../packages/host/src/browser-control.ts) and
[native prompt](../../../packages/host/src/browser-grant-prompt.ts). The
[controller tests](../../../packages/host/src/browser-control.test.ts), existing
Runtime integrity tests and a mocked prompt-process forwarding test pass nine
tests in three files. [Evidence](../../../docs/validation/browser-lifetime/README.md)
retains the failed pre-fix case and the final Host typecheck. Actual interrupted
Chromium navigation retains an unknown receipt and only one external HTTP request.

This is a lifecycle repair within the [isolated browser slice](../proposed/2026-10-05-brow-101-isolated-browser.md).
It does not complete BROW-101, prove native permission dialogs or selected Chrome
integration, or substitute for independent installed macOS/Windows acceptance.
