---
id: 2026-10-05-complete-product-workbench
title: Real software delivery and governed computer workbench
status: proposed
owners: [host, runtime, workbench]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [FLOW-097, CFG-098, GOAL-099, TEAM-100, BROW-101, COMP-102, CAP-103, DATA-104, APP-105, HELP-106, UXD-096]
supersedes: []
---

# Agent Note: Real software delivery and governed computer workbench

[中文](2026-10-05-complete-product-workbench.zh.md)

## Problem and current state

The user approved the complete product implementation plan on 2026-10-05. Existing desktop recovery, model connections, file editing and developer resources remain current; they do not prove native computer control, remote MCP, persistent goals or complete development workflows. The Plan failure for direct answers without Todos is now repaired using explicit terminal intent. Scoped evidence covers configuration inheritance, goal budgets, isolated agents, remote MCP, browser control and personal queries. The incremental report distinguishes verified scope from remaining capability gaps; Windows native acceptance is still outstanding.

## Accepted target

Use one authenticated local Host/Profile/Runtime and the canonical Ledger. Add typed contracts and controllers for resolved configuration/history, finite-budget tasks/goals, scoped agents, browser/computer commands and capability management. Implement controllers and externally verifiable effects before declaring client controls available. Ordinary direct answers can finish in Plan; execution plans retain explicit Todo and approval checks. Configuration changes do not mutate admitted model snapshots; permission revocation blocks further dispatch.

Each capability is delivered as a vertical slice with failure, cancellation and recovery evidence. The user explicitly approved the page designs. Shared views and states now follow that approved design; each added capability still requires backend and actual-operation acceptance. Native computer control requires independent app grants, an input lease and manual handover after user input. DOM, accessibility and visual operations must be reported accurately. Unknown writes are reconciled before retry. Installers must bundle their own runtime, and native Windows/macOS evidence is required separately.

## Alternatives and deferred scope

Rejected: frontend-only controls, fake capability availability, treating cross-builds or external QA automation as product computer control, copying private Codex internals, and allowing file Full Access to imply computer authority. Office editing, voice, sketch tools, skill recording, pets, dedicated connectors and cloud work are deferred.

## Invariants and boundaries

- Apps remain composition roots; business behavior belongs to typed package seams/controllers.
- Ledger facts are append-only; receipt and external result determine success. Private reasoning is never public progress.
- Preserve package scopes and original user changes. No automatic commits, pushes, PRs or public publication.
- Budgets include children, retries and verification; background inference requires opt-in finite budgets.
- Replay is read-only. Restore/reconnect never redispatches historical side effects automatically.
- Mark implementation and native acceptance separately; historical validations keep their original scope.

## Migration and rollback

Retain old configuration and credential references; version new formats, preview conflicts and back up before migration. Additive contracts must preserve legacy reads/replay. Retain original events and use explicit terminal intent for new plan semantics. Rollback disables new operations and retains data and unresolved receipts rather than deleting history. Any irreversible change requires a concrete reviewable authorization path.

## Acceptance criteria

- [ ] Real development and UI verification on both native platforms.
- [ ] Direct Plan answer vs approved execution plan, negative authority cases and terminal consistency.
- [ ] Configuration inheritance/history, revocation, recovery and frozen running snapshots.
- [ ] Three clients use the same controllers and real receipts; drafts/editor state survive reconnect.
- [ ] Goals, agent budgets, isolated writes and human final acceptance.
- [ ] Browser/computer authorization, handover, lock-screen pause and evidence retention.
- [ ] Current docs, roadmap, capability matrix and installer evidence agree.

## Evidence and open acceptance

The design is user-approved. Implementation and tests are recorded in the [incremental delivery report](../../../docs/validation/product-workbench-2026-10-05/README.md) and [current capability matrix](../../../docs/validation/product-workbench-2026-10-05/capability-matrix.md). Whole-plan completion is pending. Signed distributions, clean native Windows/macOS upgrade and independent user acceptance cannot be inferred from local tests.

### Settings focus and initial connection correction

Actual installed-page observation exposed the underlying chat in the accessibility tree after editing a Skill. Source inspection confirmed that the settings dialog only covered the workbench, while its focus trap omitted disclosure summaries and did not recover escaped focus. The shared dialog now captures the original focus before making the workbench inert, includes visible native and explicit focus targets, contains escaped focus, and restores the original target after removing its own inert state. Closing settings preserves the conversation draft and category behavior; background navigation shortcuts do not act through the open dialog.

The initial client snapshot is `connecting`, not a confirmed installation failure. New-chat/project entry states and the composer now distinguish connecting/reconnecting from offline failure. Pending connection is a status without a repair command; an actual offline failure retains its error details and explicit repair action. No transport retry, task dispatch or authority semantics changed.

The four new negative fixtures failed before the change. The [final five-file UI regression](../../../docs/validation/product-workbench-2026-10-05/checks/settings-focus-connection-ui-final.log) passes 32 tests and [Workbench types](../../../docs/validation/product-workbench-2026-10-05/checks/settings-focus-connection-types-final.log) pass. The [before-fix output](../../../docs/validation/product-workbench-2026-10-05/checks/settings-focus-connection-before-fix.log) is retained. These are source-level DOM/keyboard fixtures; the rebuilt native accessibility tree and installed first-load behavior require fresh release observation.

In-app Start/Browser Help now points project selection to the sidebar and browser grants to Workspace tools → Browser → Browser permissions. Browser settings explicitly opens the existing panel through its fixed navigation callback; it does not request a grant, open a tab or dispatch an action. Headless takeover and the small default-model text test remain accurately limited. Two [before-fix navigation negatives](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-before-fix.log) are retained; [three-file Help/settings regression](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-ui-final.log) passes 18 tests, [shared locale](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-locale-final.log) passes 12 tests, and [Workbench types](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-types-final.log) and [SDK types](../../../docs/validation/product-workbench-2026-10-05/checks/browser-help-sdk-types-final.log) pass. No new browser authority or model request is introduced by navigation.
