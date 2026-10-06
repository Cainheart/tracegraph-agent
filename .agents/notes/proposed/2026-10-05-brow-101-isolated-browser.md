---
id: 2026-10-05-brow-101-isolated-browser
title: Host-owned isolated browser with explicit origin grants
status: proposed
language: en
owners: [host, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [BROW-101, packages/contracts, packages/host]
supersedes: []
---

# Host-owned isolated browser

[中文](2026-10-05-brow-101-isolated-browser.zh.md)

## Current and target

Outlive has a local project preview but no product-owned DOM browser control.
External QA automation is not an Outlive capability. Add a separate Host controller
using a pinned Playwright/Chromium pair. Client commands and Runtime tools share
this controller; no arbitrary JS, browser profile copying or debug-port attachment.

Trusted user operations grant exact HTTP(S) origins, choose an isolated tab,
revoke, take over and return control. Model tools cannot grant authority or return
control after human takeover. Browser requests, redirects and popup targets are
checked against the selected origin set. A page snapshot produces bounded,
revision-scoped DOM references and viewport evidence; stale/detached references
are rejected. Password values never enter DOM metadata. Writes use command IDs
and canonical receipts. Lost dispatched outcomes stay unknown and are not replayed.

## Boundaries and deferred acceptance

First slice uses isolated headless Chromium and explicit client takeover; there is
no visible OS browser window whose physical input could be misclassified. Native
input monitoring and headed integration depend on COMP-102. Existing Chrome
selected-tab extension, proxy layers, installer browser staging, evidence retention
and complete three-surface controls remain BROW-101 acceptance work. Plan tools
may observe; click/fill/key/navigation remain effects under explicit user authority.
File Full Access does not grant browser authority. Restart never recreates tabs or
repeats commands.

## Alternatives, migration and recovery

Do not reuse the user's Chrome data directory or expose CDP endpoints. Persist
only explicit grants and evidence references; contexts are process-local. A crash
leaves original receipts and grants, with no context auto-resume. Old versions
ignore the separate browser grant store. Revocation closes the selected context
and blocks further actions, without claiming an already dispatched effect reverted.

## Acceptance

- [ ] Real browser/server DOM, input and external counter verification.
- [ ] Origin/resource/redirect denial, stale references and read-only replay.
- [ ] Trusted grants, takeover, revoke, close and restart without replay.
- [ ] Runtime Artifact publication, common transports and truthful UI.
- [ ] Bundled matched browsers and independent macOS/Windows native acceptance.

Protocol reference: [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype).
Evidence is recorded in the current product workbench validation directory.
