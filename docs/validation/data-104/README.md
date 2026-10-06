# DATA-104: local profile, daily usage and public search slice

This receipt covers the bounded Host/SDK/CLI slice verified on 2026-10-05. DATA-104 remains partial until its full client workflows and final user acceptance pass. These checks use temporary private profiles and real canonical Ledger/Session files. They make no paid request, read no default credentials and establish no paid-provider quality or billing claim.

## Current behavior

Personal data is a private local configuration file with revision CAS, an explicit command ID and canonical `workbench.command_requested/completed/failed` receipts. The initial display name is `Local user`; avatars use initials and one of six preset colors. A successful command persists a bounded, sanitized display name and biography, revision and command identity. These fields never become model input. Retrying the exact completed command returns its original receipt; another intent using its ID is rejected. A stale revision is a durable failed command.

If the file changed but its successful receipt is missing, inspection returns `unknown` and an independently observed profile. That observation does not establish success and cannot authorize automatic rewriting. Inspection neither runs the command nor writes a receipt. A proven command-ID or revision conflict remains a rejected command rather than being relabelled as an uncertain write.

Usage reads actual `model.request_started` and valid `model.usage_reported` facts from current registered project/session Run streams. Tokens are grouped by UTC event day; Run status counts use canonical projection. It includes explicit missing usage counts and only provider-reported currencies/amounts. Missing cost remains `unknown`, partial cost remains `partial`, and no estimate substitutes for absent data. The daily view covers 1–366 UTC days. An initial page reads at most 25 Runs; continued pages return cumulative totals, so clients replace the snapshot rather than summing repeated totals.

Public search matches only current Session titles, registered project labels, canonical Run tasks, completed outcomes and selected relative file references. Results contain exact project, Session, Run, Event/sequence and available turn locators. Failed outcomes, volatile answers, private provider reasoning, full Tool payloads and private Artifact bytes are excluded. Search supports project, Session, time, canonical status and archive filters. Results follow the bounded inventory scan, rather than claiming global relevance order. Continued search pages append their hits.

Both query surfaces reuse the existing hash-chain parser. They read at most 1 MiB and 5,000 events per Run, 25 Runs per page, 5,000 Runs per query and four retained query cursors. Cursors are opaque, query-bound, expire after 60 seconds and are lost on Host restart. Global queries with more than 1,000 registered projects are refused; explicit project queries remain available. Linked, corrupt, oversized or unsafe numeric streams are rejected or skipped with explicit incomplete evidence. Query pages expose scanned/skipped counts, an inventory-complete flag, a ceiling flag and a continuation cursor. There is no persistent full-text index or new business-event protocol.

All five routes require live local authority. Existing replay authority remains restricted to its selected Run prefix and rejects these profile-wide routes, including queries. This slice does not broaden replay access. Queries never create a Run, dispatch a tool or call a provider.

## Reproducible checks

| Final check | Actual oracle |
| --- | --- |
| [Contracts](focused-contracts-final.log): 1 file, 4 tests | Closed CAS DTO, bounded calendar/range/query, private selector exclusion and no false successful receipt |
| [Host](focused-host-final.log): 1 file, 10 tests | Actual 0600 file, restart persistence, ID/revision conflicts, lost receipt inspection without rewriting, real Ledger UTC totals, missing cost/usage, public exact locators, archive/time/status/scope, pagination and unsafe files/numbers |
| [Evidence](focused-evidence-final.log): 1 file, 7 tests | Existing public evidence contract plus bounded read hash integrity, byte/event limits, symlink/hardlink and invalid UTF-8 refusals |
| [SDK](focused-sdk-final.log): 1 file, 3 tests | Fixed route and command binding, no mutation retry, exact search scope and UTC range, rejection of private response fields |
| [CLI](focused-cli-final.log): 1 file, 25 tests | Existing shared CLI suite plus local profile/query delivery, unknown receipt exit 3, failed/missing exit 1, completed exit 0, and distinct Goal/command receipt IDs |
| [Host types](host-typecheck-final.log), [Evidence types](evidence-typecheck-final.log), [SDK types](sdk-typecheck-final.log), [CLI types](cli-typecheck-final.log) | Current source and typed public boundaries |

Counts refer to those named final suites, including their existing tests; they are not a count of new tests or independent runs. [The unavailable-dist attempt](focused-host-dist-unavailable.log) records a failed check during a concurrent build which had removed the Core package entry. It is retained and does not count as product evidence. The first local test iteration also exposed the now-fixed conflict classification and a fixture timestamp mistake: canonical Ledger timestamps come from its injected clock, not an arbitrary proposal field.

From the repository root:

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts exec vitest run src/personal-data.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/personal-data-control.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/evidence exec vitest run src/public-api.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/sdk exec vitest run src/personal-data.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/cli exec vitest run src/workbench-command.test.ts
```

The public methods are `getPersonalProfile`, `updatePersonalProfile`, `getPersonalProfileCommandReceipt`, `queryPersonalUsage` and `searchPublicSessions`. CLI entrypoints are `profile get|set|receipt`, `usage daily` and `search sessions`. Capability operations are `personal.read`, `personal.write`, `personal.reconcile`, `usage.daily` and `search.public`.

## Integration audit correction

A separate actual Computer controller/CLI check demonstrated that a native-boundary interruption after a real fixture disk effect can produce a completed journal callback with an `unknown` effect result. The [pre-fix check](cli-computer-receipt-before-fix.log) proved a false exit 0. The [final check](cli-computer-receipt-final.log) passes 2 CLI files/26 tests and preserves exit 3 for that unknown result, while intentional Goal pause receipts remain exit 0. [CLI types](cli-computer-receipt-typecheck-final.log) pass. The native backend is a declared deterministic seam; this is actual file/receipt evidence, not an operating-system mouse or keyboard acceptance claim. Inspection neither repeated the effect nor changed its external bytes.

## Remaining scope

This is a verified controller/transport slice. The named tests do not prove the installed GUI, whole-profile completeness beyond the declared ceilings, globally ranked search, complex avatar uploads or provider billing accuracy. The matching UI and fixed Desktop adapter are integrated separately and require their own actual client evidence. A search result opens an exact historical Run for inspection; it does not resume a task or grant execution authority.
