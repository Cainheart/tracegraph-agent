---
id: 2026-10-03-unified-local-workbench
title: One local Host, shared settings and complete delivery surfaces
status: implemented
language: en
owners: [host, sdk, desktop, cli, workbench]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/host, packages/api, packages/contracts, packages/sdk, packages/workbench, apps/cli, apps/desktop, apps/desktop-host]
supersedes: []
---

# Agent Note: Unified local workbench

## Problem and current state

The user approved the complete local-workbench plan on 2026-10-03. Before this change, Web and Desktop created different Runtime/configuration owners. Desktop's SDK omitted optional operations, and CLI commands could not close an approval-driven workflow. The previous UX-086 evidence records a narrower interface and is retained as history.

## Accepted target

One authenticated local Host owns a versioned profile, Runtime, configuration, credentials, project registry, Sessions and background resources. Desktop Main and CLI connect through a private local channel; the loopback Web gateway reaches the same owner. Closing a client does not cancel a Run or stop the Host. Explicit Host stop owns resource shutdown; startup at login is not installed by default.

Share controller semantics and safe capability/settings projections across surfaces. Keep fixed, schema-validated Desktop methods and renderer isolation. Configuration saving and a bounded provider connection test are different outcomes. Existing operations, artifacts, public streams, tools and settings must be usable through equivalent UI/CLI workflows.

The shared conversation hides redundant settings, pinning and run navigation, shows one public statement and one actual operation, and expands history only on request. No private reasoning is displayed. Settings expose source, scope, limits and effective time.

Add local Git/worktrees, Host-owned PTYs, controlled preview services, archive/search/notifications and durable schedules. Session writes are serialized; canonical-workspace writes are coordinated across Runs and resources. Schedule occurrences use durable identities, skip missed/overlapping triggers and never silently replay a side effect after recovery.

## Invariants and boundaries

- Ledger and business receipts remain authoritative. Connection success, process exit and saved credentials do not prove business success.
- Host holds authority and secrets; renderers receive bounded safe projections and scoped IDs. No arbitrary renderer filesystem or generic privileged RPC is added.
- Preserve permission ceilings, exact approvals, Memory consent and default-disabled Recall. Recovered state never automatically grants execution authority.
- Use existing packages and public exports. Register changed dependency directions in architecture-policy.yaml.
- New configuration applies at its declared boundary; each Run retains its resolved model and credential lease until the Run terminates.

## Migration and rollback

Inventory and preview legacy sources, back them up, stop old writers, then atomically commit a shared profile. Preserve source directories and original ledger identities. Do not concatenate incompatible Sessions or automatically grant newly imported paths. Conflicts remain inspectable and require a source selection. A failed migration leaves the previous profile usable; rollback retains new evidence rather than rewriting old facts.

## Acceptance criteria

- [x] Concurrent client launches discover exactly one authenticated Host owner.
- [x] Web/Desktop/CLI configuration and complete task workflows share canonical state and outcomes.
- [x] Desktop/CLI parity, public subscriptions and setting failures are verified through real transports.
- [x] Client closure, parallel-workspace admission, Host recovery and schedule deduplication are tested.
- [x] Terminal/preview/Git resource lifetime and permission failures have external-state oracles.
- [x] Three viewport sizes, current module docs, roadmap and rebuilt archive agree with verified behavior.

## Evidence

Implemented and verified for HOST-087, PAR-088, CLI-089, SET-090, DEV-091, RUN-092 and UX-086 second acceptance. See [acceptance report](../../../docs/validation/unified-local-workbench/README.md), [capability matrix](../../../docs/validation/unified-local-workbench/capability-matrix.md), and [machine receipt](../../../docs/validation/unified-local-workbench/evidence/acceptance.json). All 1,367 unit tests, 32 offline evaluations and five recorded snapshots passed. Latest Web has 102 verified screenshots; the fresh installed Electron has 134 screenshots and 21 real journeys, with 22 CLI commands and successful cleanup. Frozen unsigned archive SHA-256: `33147dfea9230ad877627946d5117bd1eb96bc27289435528bd60b067f87c615`. Prior failed attempts remain failed. Synthetic provider responses are declared; actual files/processes/receipts are verified. Signed distribution, independent external-user acceptance and non-macOS GUI remain outside this local evidence. System notifications require an attached authorized client; canonical notification facts remain available after reconnection.
