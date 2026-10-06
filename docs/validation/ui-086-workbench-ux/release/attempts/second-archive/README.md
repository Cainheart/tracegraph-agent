# UX-086 corrected immutable Preview acceptance

该历史归档已于 2026-10-06 清理；本目录保留哈希和验收回执，原 `_tmp_release` 路径不再存在。

Status: superseded after installed LIVE validation and before Preview observation. Fresh Linux/macOS installation, CLI/private Host smoke, DEMO-080/081/082 and the actual archived Main/Node worker/Seatbelt test oracle passed. Root subsequently found a Chinese placeholder locale omission and will freeze a third corrected archive; these second-hash receipts remain preserved, and do not close the final Preview acceptance.

## Artifact and participant

- Corrected archive: `_tmp_release/2026-10-03-ux086-node-preview/outlive-agent-0.1.0-alpha.0-preview.tar.gz`.
- SHA256: `f2de296dd96af6c07a3a884019be850679c409d4b98c46ea0e9778c0764f6c27`.
- Participant: maintainer workspace Agent simulation, not an independent external user.
- [First archive](../first-archive/README.md) remains preserved. It was superseded before native observation after a real source Desktop journey exposed an Electron-versus-Node executable composition defect. Success for that archive was not transferred here.
- Machine receipts: [report.json](report.json), [scope.json](scope.json), [proof-integrity.json](proof-integrity.json).

## Fresh installations

Linux used official cached `node:22.19.0-bookworm-slim`, image ID `sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`, with exact pnpm 11.19.0. [docker-command.json](linux/docker-command.json) is the exact argv; [install.sh](linux/install.sh) contains all commands. `--init --rm` mounted only this archive read-only and the new Linux evidence directory writable. No source checkout, host dependencies, user data or credentials were mounted. The archive checksum was verified before a fresh extraction and frozen install. The Linux container was removed; see [cleanup.json](linux/cleanup.json).

macOS used a newly created extraction directory, exact pnpm 11.19.0 and supported Node 24.21.0 on the existing maintainer Mac. This is not a clean machine. [install-path.txt](macos/install-path.txt) records the new path; [environment.json](macos/environment.json) records platform boundaries. [install-runner.py](macos/install-runner.py) ran these exact commands from the extraction with `NODE_OPTIONS` absent:

```bash
node scripts/preview-install.mjs --desktop
node scripts/preview-smoke.mjs
node demos/proofs.mjs --output <new-evidence-directory>/proofs
```

All command exits were 0. Linux used `preview-install.mjs` without the Desktop runtime option. The two smoke reports verify archive inventory, archive-local package resolution, CLI HTTP query and typed private Host protocol v2 identity, with Host children absent. Native Electron 44.5.1 is installed; [installed-electron.json](macos/installed-electron.json) records the exact archive-local executable.

## Retained Runtime proofs

[Linux report](linux/proofs/report.json) and [macOS report](macos/proofs/report.json) passed all three proofs. 75 files in each proof bundle were independently rechecked against their `SHA256SUMS`.

| Proof | Actual oracle |
| --- | --- |
| DEMO-080 | Child SIGKILL after filesystem apply before applied receipt; recovery yields exactly one applied and verified event; repeated reconciliation changes neither file hash nor event count; child absent. |
| DEMO-081 | Recall, correction, consent/Capsule digests, superseded/revoked exclusion, rejected revoked export and warning about retained external copies. |
| DEMO-082 | Leader, descendant and process group absent after cancellation; one model dispatch; no pending inputs or active subagents; canonical cancellation receipt retained. |

These use offline scripted decisions with synthetic public content and real Runtime/files/processes. They do not evaluate remote Provider quality.

## Native installed validation

The separate [installed-live.mjs](../../harness/installed-live.mjs) helper imported only archive-local built Main/core/Host. It seeded fresh private userData and a fully synthetic disposable prepared TypeScript fixture through the archive core factory, supplied a synthetic loopback HTTP model, and ran one `run_test` through the actual installed Main and fixed IPC. The external oracle file records the real supported Node executable, test PID, two assertions and computed result. Typed Host ready identity, actual private worker command, unchanged workspace-write Seatbelt mode, compiled Main/preload hashes, actual native sandbox/context-isolation preferences, canonical projection/test Artifact/ledger and owned process absence are required. Its uniquely staged synthetic credential is deleted before success.

The second-hash LIVE process was closed and its Main/worker/test PIDs were absent. Native Preview was held and never launched because a later Chinese placeholder correction required a third immutable archive. That final hash has separate native Preview observation receipts.

## Failures, reruns and unclaimed milestones

This archive has no installation, smoke or proof failure/rerun. Installed LIVE passed after three retained harness preparation/observation failures: source-stripped fixture assumptions and Electron44 getLastWebPreferences omitting preload. These attempts started no test; actual supported Node worker and security flags were captured in the third. The final corrected harness passed the same immutable artifact with all native Main/private Host/test PIDs absent, synthetic credential deleted and temporary fixture/userData removed. See report failures/reruns and macos/attempts. Native Preview was held and never launched. The earlier source journey failure and first frozen artifact receipts are preserved separately, not hidden by these passing checks. A harness-only viewport visibility assumption was corrected; real Web visibility checks passed without a source change or archive replacement.

No signing/notarization, public npm/deployment, independent non-maintainer installation, remote Provider quality or bare-metal Linux acceptance is claimed. The current roadmap keeps the independent-user P8 milestone separate from authorized REL-084 simulation.

The third archive supersedes only the Chinese `Ask anything…` placeholder mapping and rebuilt SDK/renderer artifacts. No business logic change is inferred from this locale correction; its exact new hash still requires fresh installation validation.

These second-archive files originally lived under `release/attempts/final-archive/` and were moved into `release/attempts/second-archive/` when the third artifact became necessary. Historical invocation paths deliberately retain their original values.
