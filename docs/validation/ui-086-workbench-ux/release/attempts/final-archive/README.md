# UX-086 final immutable Preview acceptance

The final archive passed fresh macOS installation, smoke, three Runtime proofs, actual installed LIVE Main/Node-worker/Seatbelt test, native Preview observation, change-review capture and process cleanup. Linux fresh install and smoke passed; DEMO-080 initially failed closed while reading an active session, then all three proofs passed in one entirely fresh container rerun. The first failure remains preserved and its cause is unlocated. Report status is `passed_on_recorded_retry_with_retained_unlocated_failure`.

## Frozen artifact and participant

- Archive: `_tmp_release/2026-10-03-ux086-final-preview/outlive-agent-0.1.0-alpha.0-preview.tar.gz`.
- SHA256: `41622f1719467850475d583115357d21ba0aa69e8469f27ab8b1e6cf0140298a`, independently checked before and after all acceptance steps.
- Participant: maintainer workspace Agent simulation; no independent non-maintainer participated.
- Machine receipts: [report.json](report.json), [scope.json](scope.json), [cleanup.json](cleanup.json), [proof-integrity.json](proof-integrity.json).
- [First archive](../first-archive/README.md) and [second archive](../second-archive/README.md) remain preserved with their original hashes and failure/supersession boundaries. Earlier successes were not transferred to this hash.
- [artifact-delta.json](artifact-delta.json) compares second/final immutable inventories. Main, preload, Node resolver, Host worker/process launcher, Core Runtime and Desktop CSS hashes are unchanged. Shared changed paths are the SDK locale catalog and renderer index outputs; renderer JavaScript chunk names changed with the rebuilt locale dependency. The final correction adds the Chinese `Ask anything…` placeholder mapping.

## Fresh Linux installation and bounded rerun

Official cached `node:22.19.0-bookworm-slim` image ID: `sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`. Node 22.19.0 and exact pnpm 11.19.0 were installed in both new containers.

[Initial argv](linux/docker-command.json) and [initial script](linux/install.sh) use `docker run --init --rm` with exactly two bind mounts: the immutable archive read-only at `/artifact/outlive.tar.gz`, and the new evidence directory writable at `/evidence`. No source checkout, host dependencies, user-data directory or credentials were mounted. The complete [retry argv](linux/attempts/retry-2/docker-command.json) and [retry script](linux/attempts/retry-2/install.sh) repeat all steps in a separate fresh container/extraction, with the same isolation and hash.

From each fresh extraction:

```bash
node scripts/preview-install.mjs
node scripts/preview-smoke.mjs
node demos/proofs.mjs --output /evidence/proofs
```

Initial installation and [smoke](linux/preview-smoke.json) passed. The first proof command exited 1 before its intended recovery crash injection: `SessionPathSafetyError: session file changed while opening` from `packages/session/dist/session-store.js:474`. Full worker and parent stacks are retained in [linux/proofs.log](linux/proofs.log). This is an observed fail-closed session read, not an attributed environment failure. Core was not changed and the cause is not located.

One fresh rerun passed installation, [smoke](linux/attempts/retry-2/preview-smoke.json) and [all three proofs](linux/attempts/retry-2/proofs/report.json), with exit 0. No further retry was run. Both containers were removed; see [initial cleanup](linux/cleanup.json) and [retry cleanup](linux/attempts/retry-2/cleanup.json). Linux did not run the native Desktop GUI.

## Fresh macOS installation

A new extraction and full frozen dependency install ran on the existing maintainer Mac: macOS 26.5 arm64, supported Node 24.21.0, exact pnpm 11.19.0. This is not a clean machine. [install-path.txt](macos/install-path.txt) records the independent new directory; [environment.json](macos/environment.json) records scope. [install-runner.py](macos/install-runner.py) ran from that extraction with `NODE_OPTIONS` absent:

```bash
node scripts/preview-install.mjs --desktop
node scripts/preview-smoke.mjs
node demos/proofs.mjs --output <new-macos-evidence-directory>/proofs
```

All exits were 0. [Smoke](macos/preview-smoke-report.json) verifies checksum inventory, archive-local package resolution, CLI HTTP query and typed private Desktop Host protocol v2 identity. The private Host exited and was absent. Native Electron 44.5.1 is installed; [installed-electron.json](macos/installed-electron.json) records its exact archive-local executable.

## Actual installed LIVE Main and sandbox test

The [installed-live helper](../../harness/installed-live.mjs) loads only archived compiled Main/core/Host from this new extraction. It creates a fully synthetic temporary TypeScript fixture before the Run, registers that real workspace through the archive Host, configures a synthetic loopback HTTP provider with a uniquely staged credential, and launches the installed native executable with fresh isolated userData. No source checkout imports or remote model are used.

[installed-live.json](macos/installed-live.json) records the actual installed Main/preload hashes, `file:` renderer URL, typed Host ready identity, real worker command, actual native preferences and isolated renderer bridge. The Host worker and sandboxed `run_test` execute real supported Node 24.21.0 at `/opt/homebrew/Cellar/node@24/24.21.0/bin/node`, rather than the Electron executable. The existing default `workspace-write` Seatbelt remains configured.

The real test process writes [installed-sandbox-oracle.json](macos/installed-sandbox-oracle.json): marker, actual executable/PID, two assertions and result 5. The [actual test Artifact](macos/installed-live-test-artifact.json) contains `2/2 fixture assertions passed`; [canonical completed projection](macos/installed-live-completed-projection.json) and the copied canonical session ledger/artifacts remain available. This final archive native LIVE check passed without a rerun.

Actual native preferences prove `sandbox=true`, `contextIsolation=true`, `nodeIntegration=false`, and `webSecurity=true`. The renderer has no `require` or `process` global and exposes the fixed bridge methods. Electron 44's `getLastWebPreferences` response omits the preload path; preload identity is established by the integrity-verified archived Main configuring the hashed preload and its functional isolated bridge. The earlier second-archive harness assumptions and retained failures are documented separately, not repeated or hidden in this run.

The native Main, private worker and test PIDs were all absent after close. The unique synthetic credential was deleted, and the temporary fixture/userData/bootstrap removed before recording success.

## Actual installed native Preview observation

After LIVE cleanup, the [installed-preview helper](../../harness/installed-preview.mjs) launched this exact installed executable and archived Main with `--preview`, in separate fresh userData. [gui-preview.json](macos/gui-preview.json) records native PID 79588, actual executable/Main/preload hashes, true frame URL, visible native window, security flags, isolated bridge, screenshots and process absence.

Root observed the visible native app with CUA accessibility state and a screenshot; [native-observation.json](macos/native-observation.json) confirms the Outlive Agent title, archive-local renderer URL ending in `?preview=1`, header Preview badge, deterministic-data marker, navigation, anchored composer and demo approval controls. Preview uses synthetic deterministic data and starts no Host or model.

- [Native conversation screenshot](macos/installed-preview-1440x900.png).
- [Native changes/review screenshot](macos/installed-preview-review-1440x900.png).

After that observation, the helper selected ready-for-review, captured the change review, and checked the actual 1440×900 layout: document width 1440, no read-only gate. Main PID 79588 was absent after close. A final `ps` check found no processes from any of the three owned installed archive paths; all owned containers were absent. The user's source Web services on 4310/4311 were not touched. Fresh installation directories are retained for reproducibility, with no owned running processes.

## Runtime proof oracles and limits

The successful [Linux retry proof report](linux/attempts/retry-2/proofs/report.json) and [macOS proof report](macos/proofs/report.json) passed DEMO-080/081/082. 75 files per bundle were independently checked against `SHA256SUMS`.

| Proof | Actual oracle |
| --- | --- |
| DEMO-080 | Actual child killed after filesystem apply before applied receipt; exactly one applied and verified event; repeated reconciliation changes neither file hash nor event count; child absent. |
| DEMO-081 | Recall, correction, consent/Capsule digests, superseded/revoked exclusion, rejected revoked export and warning about retained external copies. |
| DEMO-082 | Actual leader, descendant and process group absent; one model dispatch; no pending inputs or active subagents; canonical cancellation receipt retained. |

These proofs use offline scripted decisions and synthetic public content with real Runtime/files/processes. No remote Provider quality, signing/notarization, public npm/deployment, independent external-user installation or bare-metal Linux acceptance is claimed. The one unlocated Linux session read timing failure remains a limitation and is not treated as fixed by a passing rerun. Authorized REL-084 simulation and the P8 independent-user milestone remain separate.
