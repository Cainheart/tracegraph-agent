# Browser authorization and shutdown lifetime

[中文](README.zh.md)

This is a verified BROW-101 lifecycle repair, not whole-browser or native-platform acceptance. Checks use isolated temporary profiles, local HTTP servers and the development Chromium runtime. No default profile, live credential, paid model, physical mouse or keyboard is involved.

## Behavior and receipts

The controller fences new and queued admission after close. Trusted human confirmation receives an AbortSignal; close settles its wrapper even if a callback ignores cancellation. A late positive result cannot persist a grant. A browser arriving after close is closed without creating a context. Close is idempotent and waits for admitted work; a failed browser close yields `browser_cleanup_failed` rather than success. Production launch is bounded to 15 seconds and confirmation to 30 seconds. The trusted construction-only launcher is not a transport or model option.

Work uses the existing WorkbenchJournal and unchanged grant/receipt contracts. A queued command rejected before admission has no receipt. An admitted, cancelled confirmation has a failed receipt. A real navigation interrupted after its external request retains `browser_effect_unknown` and requires inspection. Restart keeps durable grants and receipts, creates no tab, and makes no repeated request. Cleanup cannot prove a dispatched external effect was rolled back.

## Evidence

| Check | Scope |
| --- | --- |
| [Pre-fix pending grant](pending-grant-before-fix.log) | Failed negative: close returned, then late approval produced a valid persisted grant |
| [After-fix focused case](pending-grant-after-fix.log) | Pending confirmation fenced before the complete suite was added |
| [Final Browser tests](focused-browser-final.log) | Three files, nine tests; real DOM/server effects and interrupted navigation, canonical takeover retries, deterministic late-launch/cleanup negatives, existing Runtime integrity and a mocked native prompt process boundary |
| [Final Host types](host-typecheck-after-team-fix.log) | Current Host source passes |
| [Earlier Host types](host-typecheck-final.log) | Failed on the unrelated Team policy API field; retained and fixed by that slice's owner |

The prompt test proves signal forwarding without starting a native permission dialog. Late-launch tests use an explicit trusted fake Browser; they prove concurrency invariants, not OS process cleanup quality. Real Chromium tests separately close their browser, servers and isolated profile in `finally`. Counts include existing tests, not nine new tests. No full build or installed native acceptance was run for this receipt.

## Reproduction and boundaries

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/browser-control.test.ts src/browser-runtime.test.ts src/browser-grant-prompt.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/host typecheck
```

Implementation is in [BrowserControl](../../../packages/host/src/browser-control.ts), [trusted prompt](../../../packages/host/src/browser-grant-prompt.ts) and the [paired implemented Note](../../../.agents/notes/implemented/2026-10-05-browser-grant-lifetime.md). Full BROW-101, selected Chrome integration, native input handover and independent macOS/Windows acceptance remain separate work. This repair does not broaden browser authority or replay access.
