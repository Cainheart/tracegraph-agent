# DATA-104: real scoped screenshot retention

[中文](README.zh.md)

The implemented slice retains newly registered Browser/Computer screenshots for 30 days by default, supports 1–365 days, automatic hourly cleanup, bounded individual pins and explicit cleanup/inspection. This does not complete DATA-104 or prove native OS screenshot permissions, installed UI acceptance or Windows native behavior.

A trusted capture registers its private original. The Browser/Computer tool adapter registers each exact Run Artifact copy after actual byte publication. Cleanup deletes the original and all registered copies of that observation; generated images, attachments, accessibility/DOM text, messages, project files, Artifact metadata and Ledger facts remain. A scoped Run cleanup cannot delete an observation shared by another Run. Unregistered legacy captures remain; no MIME-based filesystem scan guesses provenance.

Configuration and pins use command IDs/revision checks. Each bounded cleanup has a canonical WorkbenchJournal SessionEvent receipt. A canonical inventory checkpoint contains the projection hash/revision; restoring an old private projection cannot revert a later pin or TTL. An inconsistent or missing checkpoint disables this optional service while ordinary Host/Plan operation continues. It does not automatically roll back or repair the inventory. Partial deletion and lost receipts remain unknown. Inspection checks bytes without deleting or rewriting them; new cleanup does not retry an uncertain observation.

Bounds: 10,000 registered observations, 500 pins, 16 Run copies per observation, 100 results/cleanup candidates per explicit batch, 8 MiB projection, and 10,000 canonical inventory checkpoints/16 MiB checkpoint query ceiling. Exhausted capacity fails closed and needs maintenance; there is no automatic Ledger compaction. Browser originals are at most 8 MiB and Computer/Run PNG copies at most 16 MiB. Source/metadata/hash/length/ownership and non-symlink/hardlink file identity are checked. Node's path-based unlink is not an atomic conditional-inode deletion; a malicious same-user process replacing a file or parent path in the final validation/unlink window is outside this private-store threat boundary. Secure erasure from backups is not claimed.

## Product paths and clients

- [Contracts](../../../packages/contracts/src/visual-evidence.ts), [controller](../../../packages/host/src/visual-evidence-control.ts), [fixed HTTP routes](../../../packages/host/src/visual-evidence-routes.ts), [trusted byte deletion](../../../packages/evidence/src/artifact-store.ts).
- [Browser capture](../../../packages/host/src/browser-control.ts) / [tool adapter](../../../packages/host/src/browser-tools.ts); [Computer capture](../../../packages/host/src/computer-control.ts) / [tool adapter](../../../packages/host/src/computer-tools.ts).
- [SDK](../../../packages/sdk/src/index.ts), [CLI](../../../apps/cli/src/workbench-command.ts); the root integrates the fixed Desktop bridge and shared settings capability surface separately.

The six typed methods are `getVisualRetentionSettings`, `updateVisualRetentionSettings`, `listVisualEvidence`, `pinVisualEvidence`, `cleanupVisualEvidence` and `getVisualEvidenceCommandReceipt`. They return metadata/receipts, never pixels or absolute paths. Replay is denied by the authenticated gateway before controller admission. CLI examples:

```bash
outlive evidence settings --json
outlive evidence settings-set --input-file retention.json --command-id settings:retention
outlive evidence list --project-id PROJECT --run-id RUN --limit 50 --json
outlive evidence pin EVIDENCE --state pinned --expected-revision REVISION --command-id pin:observation
outlive evidence cleanup --project-id PROJECT --command-id cleanup:expired --json
outlive evidence receipt cleanup:expired --json
```

`retention.json` contains `expected_revision` and `values: {retention_days: 30, automatic_cleanup: true}`. An unknown cleanup or unknown command receipt exits 3, preserving the need for inspection.

## Focused verification

The exact final raw logs below are produced in this worktree; counts are scoped and include existing tests where named.

- [Host controller/capture/local owner checks](checks/host-final.log): actual byte deletion, pin/unexpired preservation, original + Run copies, unchanged metadata/AX text/project bytes, shared Run scope, links, receipt loss, CAS/restart, restored old projection, missing checkpoint, automatic durable cleanup. Actual isolated Chromium PNG capture is exercised; Computer capture uses a labelled deterministic native backend and real controller/Artifact/Ledger effects.
- [Actual HTTP/SDK/CLI checks](checks/cli-final.log): a real authenticated local HTTP Host, durable Runtime/Session and a deterministic direct-answer adapter; real CLI pin/settings/cleanup disk effects, pinned bytes preserved, exact Run Ledger unchanged, replay 403 with no cleanup receipt. The additional CLI command suite checks typed flags and unknown exit codes.
- [Contracts](checks/contracts-final.log), [SDK](checks/sdk-final.log), [Evidence](checks/evidence-final.log) and [type/boundary checks](checks/types-final.log).

The optional-service failure case uses an actual temporary LocalHost/UDS owner, a local deterministic HTTP provider and a restored stale or corrupt retention projection. The ordinary Plan Run completes, all six visual capabilities become unavailable, screenshot bytes remain and no cleanup command is created. It uses private-file dummy credentials only. No default profile, user credential, paid provider, OS mouse/keyboard action or installed GUI was used by these tests.

The first actual HTTP attempt caught missing JSON command headers in the new SDK methods; they now use the existing typed command transport. Independent source review identified stale projection rollback of newer pins/settings; the canonical checkpoint and actual restore-negative tests close that specific defect. Broader UI/installation acceptance is reported by its owning journey and is not inferred from these focused tests.
