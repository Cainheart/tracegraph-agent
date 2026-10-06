# Desktop client departure and private SSE lifetime

This is a scoped Source Desktop correction, not final installer, native Windows or complete APP-105 acceptance. The source implementation is [Main](../../../apps/desktop/src/main.ts), [SDK SSE reader](../../../packages/sdk/src/index.ts), [real private transport test](../../../packages/host/src/local-fetch.test.ts), [Main connection tests](../../../apps/desktop/src/main-connection.test.ts), and [native background tests](../../../apps/desktop/src/main-native-background.test.ts). The paired [decision](../../../.agents/notes/proposed/2026-10-05-desktop-quit-lifetime.md) remains proposed/unreviewed.

## Observed failures and boundaries

- Root observed own Source Electron PID 47891 surviving native Quit with UI disconnected, while own QA Host 23666 remained healthy. Its [native sample](checks/hung-main-native-sample.txt) and [pre-cleanup process observation](checks/original-pids-before-cleanup.log) are retained. The original cause was not conclusively isolated. No file edit had been made in that session; the dirty-file reproduction therefore cannot explain it as a proven fact.
- [Real private UDS SSE before-fix output](checks/private-sse-before-fix.log): an idle response abort passed; iterator return after a public event left the response/socket open (one failed/one passed). The test uses Node HTTP over a private socket, not a mock stream that automatically resolves on abort.
- [Actual Main clean quit before the change](checks/native-plain-before-fix.log) exited normally. [Actual Main dirty guard](checks/native-dirty-before-fix.log) vetoed window closure after the old `before-quit` handler had already detached the client. The child remained alive; only its diagnostic `app.exit(2)` cleaned it up.
- The first candidate moving detach to `will-quit` still exposed a native transaction race. [Actual phase diagnostics](checks/native-plain-diagnostic.log) show `supervisor.close` and `streams.closeAll` both finishing, but another `app.quit()` from the same promise turn was ignored and the process survived. The final call is now scheduled using `setImmediate`, after the current native quit transaction unwinds. This is a next-turn correction, not an increased timeout. It is consistent with the original symptom, but does not retrospectively prove PID 47891's exact cause.
- [An initial invalid oracle bootstrap](checks/native-fixture-top-level-await.log) awaited `app.whenReady` at top-level module evaluation and needed its fixture safety kill. The actual oracle was corrected to a non-blocking async function before interpreting product results. This is retained as a harness failure, not a product failure.

## Verified behavior

`before-quit` records departure intent only. `will-quit`, reached after windows accept closing, single-flights client detachment and advances final Quit to the next event-loop turn. An unsaved-edit veto offers Keep editing or Discard and quit; cancelling retains the same renderer and authenticated client. Ordinary close while a Tray exists hides the same renderer, preserving drafts and editing state. Activation and notification navigation cannot recreate a window during departure. The independent Host is never implicitly stopped.

The SDK reader actively cancels its response on abort or early iterator return, removes its abort listener, waits for reader cancellation and releases the lock. Buffered events are not emitted after abort. The stream/client detach paths do not acquire Run cancellation or Host-stop authority.

| Actual command / oracle | Result | Raw output |
| --- | --- | --- |
| `pnpm --filter @tracegraph/sdk exec vitest run src/index.test.ts --maxWorkers=1` | 55 passed | [SDK](checks/sdk-focused.log) |
| `pnpm --filter @tracegraph/host exec vitest run src/local-fetch.test.ts src/local-connection-supervisor.test.ts --maxWorkers=1` | 15 passed, including two real private SSE cases | [Host](checks/private-sse-after-fix.log) |
| `pnpm --filter @tracegraph/desktop test:unit` | 14 files / 77 passed | [Desktop](checks/desktop-unit.log) |
| SDK → Workbench → whole Desktop targeted builds, no clean | each exit 0 | [SDK](checks/sdk-build.log), [Workbench](checks/workbench-build.log), [Desktop](checks/desktop-build.log) |
| SDK / Desktop typecheck | each exit 0 | [SDK](checks/sdk-types.log), [Desktop](checks/desktop-types.log) |
| Actual Source Main plain Quit | exit 0, window closed, final native Quit reached | [plain](checks/native-plain-after-fix.log) |
| Actual Source Main dirty Cancel → clean Quit | retained window and fixed bridge `connected`, then exit 0 | [cancel](checks/native-dirty-cancel-after-fix.log) |
| Actual Source Main dirty Discard | explicit fixed confirmation choice, exit 0 | [discard](checks/native-dirty-discard-after-fix.log) |
| Owned background Host after all oracles and original-process cleanup | PID 23666 survived, HTTP health 200 | [process](checks/original-pids-after-cleanup.log), [health](checks/background-health.log) |
| Scoped `git diff --check` | exit 0 | [diff](checks/diff-check.log) |

All native oracles launch the real Source Main and renderer using a separate temporary Electron userData directory, attach to the existing owned QA profile, then remove only their own userData. They submit no Run, model request or Host stop. [Harness](native-quit-oracle.mjs) records actual Electron events and exit status. Dirty confirmation choices are supplied by a fixed dialog test fixture; this does **not** certify human native-dialog interaction. The parent independently checks expected event facts, connected cancellation and background-owner survival.

Host typecheck was attempted and [retains its failure](checks/host-types.log): concurrent delivery-review composition referenced an `AgentRuntimeOptions.deliveryReview` field not yet available in the built Core declaration. There was no error in the new private transport test. The root's later coordinated Core/Host build and typecheck are the final joint gate; this report does not rewrite that failed attempt as passed.

Only the already authorized hanging Source PID 47891 was terminated with SIGTERM for diagnostic cleanup. This did not stop the healthy Host or the user's installed application, and is not evidence of successful native Quit. Root's actual native Quit re-verification after the joint build and final installed/native-platform testing remain separate gates. No write, task, approval, history or automatic recovery budget is replayed or changed by this correction.
