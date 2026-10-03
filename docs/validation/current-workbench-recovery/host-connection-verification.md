# Host connection recovery verification

Verified on macOS arm64 on 2026-10-03 against the current source tree and the targeted Host build. Host/Main/SDK source was frozen at 20:20 local time; the explicit CLI migration/outcome follow-up below was frozen at 20:38. The installed default-profile App and its owner were not restarted, stopped or changed for these checks.

## Behavior and authority

- [LocalHostConnectionSupervisor](../../../packages/host/src/local-connection-supervisor.ts) observes the private owner identity and probes readiness. An external restart binds a new owner nonce and increments the public connection generation. Only validated loopback gateway ports, the selected profile and the installed build identity are reused. The public [connection schema](../../../packages/contracts/src/host-connection.ts) excludes the private bearer, socket path and profile paths.
- A crashed owner is recovered through the existing private launch and owner lease, with bounded handshake/probe timeouts, a bounded retry budget and backoff. Recovered Runs stay interrupted until an explicit resume. Rapidly flapping owners do not reset the recovery budget on each successful handshake; a stable connection or explicit repair resets it.
- [Persistent stop intent](../../../packages/host/src/local-owner-intent.ts) distinguishes explicit Host stop from process failure. Ordinary clients and automatic recovery honor the marker. Explicit Start/Repair waits for a stopping owner to leave before clearing it. OS termination does not create an explicit stop intent.
- [Main](../../../apps/desktop/src/main.ts) refreshes on application activation and exposes a schema-validated connection snapshot. Each rebind closes old renderer feed handles. Stream packets carry the owner generation. The [Desktop SDK](../../../apps/desktop/src/desktop-sdk.ts) propagates connection failure separately from the backend capability inventory.
- Reads pending across replacement are rejected as stale. Mutations are dispatched once; loss of the receipt becomes `host_write_outcome_unknown`. [SDK HTTP recovery](../../../packages/sdk/src/index.ts) retries authenticated GET/HEAD reads only. A write retry requires an explicit caller action using its original command identity and reconciliation semantics.
- Replay retains its old read-only authority after an owner replacement. It does not bootstrap a new live owner until explicit replay exit. [The CLI facade](../../../packages/host/src/local-connection-client.ts) uses the same supervisor and preserves durable stream sequence while resetting volatile stream cursors on replacement.
- Main/preload use fixed operations for saved model connections, Session options, local permission grant, project file reads/CAS saves/reconciliation and answer feedback. The clipboard operation is write-only, bounded and returns only a receipt for the explicit write. No generic IPC invocation or clipboard read API is exposed.
- A changed local permission grant remains durable and pending while any Run, workspace claim, terminal, owned preview or mutation is active. The idle check requests the existing safe restart; it does not cancel work or automatically execute recovered Runs. This timer's installed GUI journey remains part of the parent acceptance work.

## Commands and captured results

The following commands were executed after the final source changes. Result excerpts below were captured from tool output; full raw stdout was not retained for this narrow pass. The parent run will retain the final full-build/test logs separately.

| Command | Result |
| --- | --- |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host build` | exit 0 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop-host build` | exit 0 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host --filter @tracegraph/sdk --filter @tracegraph/cli --filter @tracegraph/desktop typecheck` | four workspaces, exit 0 |
| `env -u NODE_OPTIONS pnpm exec vitest run packages/host/src/local-connection-supervisor.test.ts packages/host/src/local-connection-client.test.ts packages/sdk/src/index.test.ts` | 3 files, 55 tests passed, 928 ms |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop test:unit` | 8 files, 37 tests passed, 967 ms |
| `env -u NODE_OPTIONS pnpm exec vitest run packages/host/src/local-connection-owner.e2e.test.ts` | 1 file, 2 tests passed, 3.36 s |
| Scoped `git diff --check` for the changed Host/SDK/Main/CLI/packaging files | exit 0 |

The [real private-owner tests](../../../packages/host/src/local-connection-owner.e2e.test.ts) import `../dist`, start separate Node workers in temporary profiles, and use the real authenticated private channel:

1. A second client changes a shared setting and requests canonical `host.restart`. The supervisor sees a different nonce with the same profile, reads the persisted setting, and reads actual available permission/Memory capabilities. Explicit stop leaves a persistent marker and removes discovery; a newly created client stays stopped. Explicit repair starts a replacement owner.
2. Two supervisors initially share the same worker. A local provider holds the first model request. `SIGKILL` terminates that separate worker. Both clients rebind to exactly the same replacement PID, the recovered Run is `interrupted`, and provider call count remains one. This proves no automatic task reexecution.

Cleanup detaches clients, explicitly stops each fixture owner, asserts discovery removal, closes the local provider, and removes temporary profile directories. A read-only process listing after the final pass found no matching fixture-owner processes.

The deterministic tests additionally exercise lost-write single dispatch, replay retention, build mismatch, late old-generation reads, a bounded flapping-owner budget, migration monitor suspension, durable/volatile stream cursor behavior, stale stream generations, Main application activation, fixed bridge authority and transport/capability separation. The SDK suite retains GET read refresh and Replay boundary assertions while replacing old expectations of automatic mutation retry with explicit caller retry using the original request.

## Validation boundary

This report proves source, targeted built Host artifacts and isolated macOS Node-owner behavior. It does not claim that the already installed App contains these changes. The parent run must rebuild the product and verify external CLI restart, draft/view retention, connection status, explicit stop, crash recovery and the new fixed operations through the real installed Main/preload/renderer. Windows native lifecycle, signing/notarization and independent non-maintainer acceptance remain unverified until separate evidence exists. No test raises an administrator ceiling, retries a lost mutation automatically or resumes a recovered Run automatically.

## CLI compatibility follow-up

The documentation/source audit found that a connect-only supervisor returns a typed missing-owner error instead of the raw errno expected by explicit offline migration. The CLI now allows only `HostConnectionError` with `state:offline`, `generation:0` and `code:host_recovery_exhausted` into that existing offline migration path. The migration itself still acquires exclusive profile/root leases. Stop, Replay, incompatible build, invalid profile, a previously bound generation and administrator restriction remain rejected. This does not clear a stop intent or start an owner.

The same narrow audit found that a file CAS conflict receipt fell through the CLI exit-code classifier. `status:conflict` now returns exit 1. The new test verifies a single dispatch with the original command/body/expected SHA and preserves the actual conflict receipt for reconciliation. The Host file-controller tests separately exercise unchanged external bytes after a CAS conflict.

Final follow-up commands: `pnpm --filter @tracegraph/cli build` and `typecheck` both exit 0; `pnpm exec vitest run apps/cli/src/workbench-command.test.ts` passed all 19 tests. These were process-scoped `env -u NODE_OPTIONS` invocations; captured result excerpts are retained here, without claiming raw stdout files. Scoped `git diff --check` passed. Current module 09/11 and the existing operation matrix were updated; a read-only relative-link check passed 50 links across those three files, and `pnpm verify:v2-docs` passed 74 roadmap tasks. No historical evidence was rewritten.

## Evidence-driven Web mutation preflight fix

The retained [attempt005 Web failure](attempt005-web/report.json) showed an external CLI restart on the same HTTP gateway and preserved composer/editor drafts, followed by the first explicit file Save receiving `401 capability_invalid`. Its canonical file journal showed no post-restart save admission. Unlike Desktop Main, the Web SDK does not expose native owner status; the prior Workbench wait checked enabled controls rather than a fresh browser bearer. This establishes a stale HTTP capability cause, not a proven out-of-order bootstrap-response cause.

SDK clients that establish live authority through bootstrap now perform a bounded read-only GET bootstrap before an authenticated mutation and then dispatch the mutation exactly once. Public bootstrap, GET auth refresh and mutation preflight share the same flight. An authority-generation check prevents delayed live bootstrap from overwriting Replay or allowing a superseded write. Token-injected clients that have not bootstrapped preserve their existing fixed-authority compatibility.

Known preflight rejection is separate from an unknown dispatched outcome. Only the closed Host auth rejection codes receive authoritative rejected metadata; ordinary network/proxy/provider errors retain uncertainty. Supervisor/Main/preload preserve only the safe rejection fields across Electron. No POST/PATCH/DELETE is automatically repeated. The preflight message is user-actionable and contains no provider URL, path or bearer.

Source froze at 21:12 local time. Final raw test logs are [SDK preflight, 53 passed](checks/sdk-mutation-preflight-final.log), [Host rejection, 9 passed](checks/host-admission-rejection.log) and [Desktop rejection, 38 passed](checks/desktop-admission-rejection-final.log). SDK/Host/Desktop typechecks and scoped whitespace checks passed. Tests include first file Save after replacement without an intervening GET, an injected asynchronous abort honoring the fixed 10-second bootstrap signal with zero POSTs, a rejected POST submitted once, explicit-bootstrap/preflight sharing, Replay authority transitions, and safe IPC metadata. The final actual Web/Desktop journey and installer must use rebuilt artifacts before this fix can be reported installed.

Two Host tests that timed out in the broader concurrent run passed unchanged in a dedicated `--maxWorkers=1` repeat: six tests across recovery policy and real PTY job-control, [raw log](checks/host-timeout-repeat.log). The original PTY timeout was waiting for suspended state after Ctrl-Z, not process cleanup. No timeout was increased, and this repeat does not establish concurrency load as the original cause or erase the retained failure.

## Fresh application start after an explicit stop

The approved stop boundary distinguishes a new user application launch after fully quitting from activation or window recreation in an existing Main. Source inspection found that initial Main only called the preserving supervisor `initialize()`, so a previous explicit stop also blocked the new user launch. The narrow [Main fix](../../../apps/desktop/src/main.ts) marks only initial `app.whenReady` and explicit native Start as trusted start intents. After initialization, only a safe `stopped` snapshot requests one `repair()`; other failures do not trigger this exception. Activation and existing-process window recreation still only refresh/recreate the window. Shared supervisor and ordinary CLI stop semantics are unchanged, and starting the owner does not resubmit a historical task.

Source froze at 22:03 local time. The complete Desktop suite passed 44 tests across 8 files, including six new lifecycle cases: fresh stopped launch repairs once, a later stop persists through activation/window recreation, profile/upgrade/replay initial failures each do not repair, and retained Replay stays read-only even through explicit Start. [Raw unit stdout](checks/desktop-fresh-launch-lifecycle.log) and [typecheck stdout](checks/desktop-fresh-launch-types.log) are retained; both commands exited 0. These are Main lifecycle tests with isolated doubles, not an installed GUI claim. Final7 must contain rebuilt Main and obtain its own actual launch/stop/recovery acceptance; earlier artifact results remain separate.
