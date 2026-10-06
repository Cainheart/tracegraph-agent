# GOAL-099: verified controller and aggregate request budget slice

This receipt covers the Core/Host controller slice implemented on 2026-10-05. GOAL-099 and FLOW-097 remain partial until the full client workflow, autonomous progression and final user acceptance are verified. The requests here use isolated local HTTP providers and temporary projects. They establish actual transport, process and persistence behavior, not paid-provider quality or billing accuracy.

## Current behavior

A Goal requires an objective, distinct user-visible done conditions and at least one finite token or time ceiling. Creating or approving a proposal dispatches no Run. Approval binds the exact proposal revision; starting and resuming require separate explicit commands. A successful canonical Run produces `awaiting_final_acceptance`. Only explicit acceptance of every current condition marks the Goal `completed`.

Goal snapshots, command facts, Run links and budget checkpoints use canonical SessionEvent Ledger streams. Command IDs are idempotent and conflict when reused for another intent. Read-only command reconciliation inspects an exact Goal command without synchronization, recovery or execution. Creation reconciliation inspects only `goal.create`; only a completed, valid and scoped snapshot yields a Goal locator. Failed, missing and unknown creation never assert a locator or replay an effect.

The first accepted Run binds its actual `session_id` into `execution_session_id`, even when the proposal omitted a conversation. Later approved execution and human resume reuse that Session. The continuation reads only this Goal's linked Run timelines, verifies project/Run/Session identity and selects canonical public tasks and completed outcomes; other terminal states remain explicitly unsuccessful. History is limited to the latest 40 Runs, 80 messages, 8,000 characters per message and 64,000 total characters. Raw Tool bodies, Artifacts, private provider reasoning and volatile answer snapshots are excluded. A lost binding receipt after Run acceptance remains unknown and blocks new execution.

One trusted `ModelRequestBudget` is inherited by the whole Goal Run tree. The model adapter persists a reservation before each actual initial, repair or summary HTTP request, including retried transport requests. It computes a conservative serialized text-input allowance, limits the actual provider output field and protects concurrent reservations. Validated usage settles the reservation; missing, malformed or uncertain usage consumes it in full and fences further dispatch. A transport-proven pre-dispatch cancellation refunds only a request that was never sent. A real deadline aborts active work and rejects later dispatch. Adapters without this seam and uncalibrated image-input budgeting fail before provider dispatch.

Pause aborts and settles the real Run. Human resume preserves consumed tokens/time and conservatively charged unknown requests; acknowledging unknown usage is explicit. Recovery conserves outstanding reservations, requires human continuation and never recreates an unknown launch or write. Goal Runs disable optional background model derivation. Unknown external process effects cannot be erased by revising a proposal or silently retried.

## Reproducible evidence

| Evidence | Actual oracle |
| --- | --- |
| [Latest Core check](focused-core-final.log): 9 files, 108 tests | Zero HTTP before budget admission; actual OpenAI/Anthropic output fields; separate repair and summary reservations; three parent/child HTTP requests sharing one budget; real deadline; persisted checkpoint failure; Plan and project process boundaries |
| [Latest Host continuation check](focused-host-continuation-final.log): 1 file, 16 tests | Exact approval/final acceptance; 0-dispatch/0-write reconciliation; unknown creation; canonical shared Session and public history on the second actual request; no private reasoning; foreign history rejected; lost mapping unknown; real pause/resume; actual uncertain disk write; recovered held tokens retained |
| [Latest contracts check](focused-contracts-continuation-final.log): 2 files, 8 tests | Finite ceilings, explicit conditions/revisions, rejected client runtime authority and impossible creation locators, Plan finish intent |
| [Core typecheck](core-typecheck-final.log), [Host typecheck](host-typecheck-final.log) | Current source type checks; no declaration-only completion claim |

The [pre-fix pause negative](pause-unknown-before-fix.log) demonstrated an actual disk effect whose receipt was lost during pause: the old Goal falsely remained resumable. The final test now reads the settled canonical Run and records blocked unknown effects; no retry is sent. The earlier logs in this directory are retained as intermediate checks. Counts above refer to the named final checks, rather than adding repeated tests together. The [FLOW-097 receipt](../flow-097/README.md) covers actual scoped Node/npm effects, cancellation, timeout, sandbox and unknown no-retry behavior. No test used default profiles, live credentials or a paid endpoint.

Run the focused checks from the repository:

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts exec vitest run src/goal.test.ts src/finish-intent.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/goal-controller.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/core exec vitest run src/domains/runtime/shared-run-budget.test.ts src/domains/model/model-budget.test.ts src/domains/runtime/runtime.shared-budget.test.ts src/domains/runtime/runtime.plan-mode.test.ts src/domains/runtime/run-state-machine.test.ts src/domains/runtime/runtime.subagent.test.ts src/domains/runtime/runtime.steering.test.ts src/domains/runtime/runtime.project-commands.test.ts src/domains/tools/project-commands.test.ts --maxWorkers=1
```

## Limits

This slice executes one approved Run at a time and supports explicit human continuation; it does not establish an independent autonomous cycle engine, automatic done-condition verification or installed native GUI acceptance. History is a bounded public result view, not a copy of all private execution state. Restart never grants automatic continuation.

The token ceiling governs reserved text-model dispatch and reported usage. An arbitrary compatible provider can report an overrun; that is recorded honestly and blocks further requests. A local abort cannot prove that a remote provider stopped billing. Money, external Tool service charges and uncalibrated image-input costs are not enforced ceilings. Local diagram/chart tools are allowed; external image generation is excluded from budgeted Goal tool authority. Time records active execution leases and conservative interrupted downtime, rather than time waiting for approval or an intentional human pause.
