# UX-086 refreshed Preview installation evidence

Status: superseded before native archive GUI validation. CLI/Host installation and three Runtime proofs passed on Linux and macOS. A subsequent real source Desktop journey exposed a Node executable selection defect; the corrected product requires a second immutable archive and fresh installation evidence. The first archive GUI was held and never launched. These receipts do not close Preview acceptance.

## Frozen artifact and participant

- Archive: `_tmp_release/2026-10-03-ux086-preview/outlive-agent-0.1.0-alpha.0-preview.tar.gz`.
- SHA256: `584cabba81055cd973b1fabc0e70bb517477f69c50c93184cabcce8002dcc53a`.
- Participant: maintainer workspace Agent simulation; no independent non-maintainer participated.
- The archive is immutable during this check. Source checkout builds, source UI journeys and frozen archive installation evidence have separate receipts.
- Machine receipts and raw logs: [report.json](report.json), [scope.json](scope.json), [proof-integrity.json](proof-integrity.json).

## Fresh Linux installation

The exact invocation is [linux/docker-command.txt](linux/docker-command.txt); the complete script is [linux/install.sh](linux/install.sh). `docker run --init --rm` used official `node:22.19.0-bookworm-slim`, cached image ID `sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`.

Only two bind mounts existed: the frozen archive read-only at `/artifact/outlive.tar.gz`, and this new Linux evidence directory writable at `/evidence`. No source checkout, host `node_modules`, credentials or user-data directory was mounted.

The container verified the archive checksum, installed exact `pnpm@11.19.0`, extracted into a fresh `/tmp` directory, and ran:

```bash
node scripts/preview-install.mjs
node scripts/preview-smoke.mjs
node demos/proofs.mjs --output /evidence/proofs
```

All commands exited 0. Smoke verified the archive inventory, archive-local package resolution, CLI HTTP query and private Desktop Host protocol v2. The Desktop Host child exited and was absent. The container was removed; see [linux/cleanup.json](linux/cleanup.json). Linux did not run the native Desktop GUI.

## Fresh macOS installation

This is a fresh extraction and dependency installation on the existing maintainer Mac, not a clean machine. The exact temporary extraction is in [macos/install-path.txt](macos/install-path.txt). Environment: macOS 26.5 arm64, supported Node 24.21.0, exact pnpm 11.19.0. The archive was freshly extracted without borrowing the source checkout dependency tree.

From the extracted directory:

```bash
env -u NODE_OPTIONS node scripts/preview-install.mjs --desktop
env -u NODE_OPTIONS node scripts/preview-smoke.mjs
env -u NODE_OPTIONS node demos/proofs.mjs --output <new-macos-evidence-directory>/proofs
```

All commands exited 0. The install includes native Electron 44.5.1. [macos/installed-electron.json](macos/installed-electron.json) records the exact installed executable; [macos/preview-smoke-report.json](macos/preview-smoke-report.json) verifies archive-local package resolution, CLI query, private Desktop Host identity and process cleanup.

The unexecuted [macos/gui-preview.mjs](macos/gui-preview.mjs) helper was prepared to launch the installed executable and immutable archived compiled Main in `--preview` mode, with fresh isolated Electron userData. The external bootstrap sets only that userData path before importing the actual archived Main; it does not modify the archive or renderer. Native executable, Main/preload hashes, frame URL, actual BrowserWindow security preferences, screenshots and owned process cleanup will be recorded. This GUI has synthetic deterministic Preview data and starts no model or Host.

## Runtime proof oracles

Both platform [Linux proof report](linux/proofs/report.json) and [macOS proof report](macos/proofs/report.json) passed all three IDs. Each retained proof bundle has 75 files verified against its `SHA256SUMS`; [proof-integrity.json](proof-integrity.json) records the independent recheck.

| Proof | Observed oracle |
| --- | --- |
| DEMO-080 recovery | Actual child killed after applying before the applied receipt; one applied and verified receipt; unchanged file hash and zero new events on repeated reconciliation; child absent. |
| DEMO-081 Memory | Original recall, correction recall, exclusion of superseded/revoked entries, rejected revoked export, consent/Capsule digests and retained external-copy warning. |
| DEMO-082 cancellation | Actual leader, descendant and process group absent; one model dispatch; no pending inputs or active subagents; canonical cancellation receipt retained. |

These proofs use offline scripted decisions and synthetic public content with real Runtime/files/processes. They do not evaluate remote model quality.

## Failures, reruns and limits

No installation, smoke or proof failure/rerun has occurred on either platform. The native GUI observation was never executed because this first artifact was superseded before its scheduled launch. The source Desktop journey failure is recorded by the parent QA evidence, not as a fabricated installed-GUI run here. Frozen artifact evidence cannot validate a subsequent source change or a different archive hash.

No signing/notarization, public npm/deployment, independent external-user installation, provider quality or bare-metal Linux acceptance is claimed. The archive retains its frozen documentation; the current roadmap and final UX-086 evidence supersede any stale release-milestone wording separately.

These files originally lived directly under `release/` and were moved intact into `release/attempts/first-archive/` when the second archive became necessary. Recorded historical command output paths deliberately retain their original invocation.
