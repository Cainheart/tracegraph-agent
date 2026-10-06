---
id: 2026-10-05-data-104-local-profile-public-search
status: implemented
date: 2026-10-05
language: en
---

# DATA-104: local profile and bounded public Ledger queries

## Context

The [approved product workbench plan](../proposed/2026-10-05-complete-product-workbench.md) requires personal local data, a daily usage view and public conversation search. Existing usage totals and title-only session queries do not provide that workflow. Private provider reasoning and complete Tool bodies are never search content.

## Decision

Keep the shared personal profile in private local configuration, with optimistic revision, explicit command ID and canonical SessionEvent command receipts. Restrict avatars to initials and preset colors. Profile text is bounded and sanitized before storage; no model request consumes it. A receipt lost after the local file changed remains unknown, with read-only reconciliation rather than automatic rewriting.

Derive usage and public search directly from the existing Runtime Event Ledger and Session inventory. Reuse the canonical hash-chain parser with bounded file reads. Bound every query page, retained scan state, result count, event count and date range; expose partial, skipped and continuation facts instead of pretending a limited page covers the whole profile. Continuation cursors are opaque, short-lived and query-bound. No persistent full-text index or second business event protocol is introduced.

Search allowlists only Session titles, project labels, canonical Run tasks/completed answers and public relative file references. It returns exact project/Session/Run/Event/turn locators where available. Filter time, status and archive state; never copy provider scratchpads, volatile answer text, raw Tool output or private Artifact bytes. Usage groups valid reported Ledger tokens by UTC day; missing reports and missing costs remain unknown, not zero cost.

## Scope and compatibility

Host exposes typed methods consumed by SDK, CLI and the fixed Desktop bridge. Existing profiles, sessions and ledgers remain compatible. Existing replay authority rejects these profile-wide routes; queries require live local read authority. Queries do not create Runs, execute tools or make paid requests. UI, full native acceptance and broader DATA-104 obligations are separate validation steps.

## Validation

Require real private-file profile CAS and restart persistence, command conflict and lost receipt reconciliation; actual Ledger usage totals and daily buckets; missing usage/cost and corrupted/oversized streams; bounded cursors and scope; public title/task/answer/path matches with exact locators; archive/time/status filters; private reasoning/Tool payload non-matches and zero model dispatch.

## Verified implementation

The verified scope is the local controller/transport slice; DATA-104 as a whole remains partial. The [current behavior and exact final logs](../../../docs/validation/data-104/README.md) distinguish focused checks from installed GUI and user acceptance. Implementation: [contracts](../../../packages/contracts/src/personal-data.ts), [Host controller](../../../packages/host/src/personal-data-control.ts), [fixed routes](../../../packages/host/src/personal-data-routes.ts), [SDK](../../../packages/sdk/src/index.ts), [CLI](../../../apps/cli/src/workbench-command.ts).

[Actual file/Ledger tests](../../../packages/host/src/personal-data-control.test.ts) cover private persistence, CAS, unknown receipts, public search exclusion and bounded daily usage. [Bounded evidence reads](../../../packages/evidence/src/event-ledger.ts) retain the existing hash-chain parser. Final Contracts/Host/Evidence/SDK/CLI focused suites pass 4/10/7/3/25 tests respectively; these counts include existing tests. No default profile or paid endpoint was used.
