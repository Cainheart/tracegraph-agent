---
id: 2026-10-05-data-104-visual-evidence-retention
status: implemented
date: 2026-10-05
language: en
---

# DATA-104: scoped visual evidence retention

[中文](2026-10-05-data-104-visual-evidence-retention.zh.md)

## Decision

Browser and Computer screenshots have a default local retention of 30 days, configurable from 1 to 365 days. The user may pin bounded individual observations. Only trusted capture controllers and their Runtime tool adapters register provenance. A screenshot can have a private capture copy and one or more exact scoped Run Artifact copies; cleanup covers those registered copies together. Generated media, attachments, accessibility text, DOM descriptions, Ledger events, messages and project files are outside this policy.

Use canonical SessionEvent command receipts through WorkbenchJournal, with a bounded private inventory as a verified projection. The same canonical Ledger carries an inventory-checkpoint stream with the projection hash/revision; restoring a pre-pin or pre-policy projection fails closed against newer facts. Retention configuration and pins use explicit command IDs and revision checks. Cleanup is a bounded explicit command; automatic hourly checks may submit the same kind of durable cleanup command only when enabled and expired entries exist. Every cleanup records exact evidence/Artifact IDs, verified hashes and deletion outcomes without pixel contents or absolute paths. Artifact metadata remains available after byte deletion.

## Safety and recovery

Delete only an exact registered PNG at a fixed private store location, after scope, metadata, hash, size, file identity, ownership and non-symlink checks. Never follow links or delete directories. Serialize registration, pin changes and cleanup. Bound inventory, pin count, batch size and private file reads. A projection marks pending cleanup before deletion. A crash or missing receipt stays unknown and blocks further deletion for that observation; read-only reconciliation observes remaining bytes and does not repeat effects. Replay cannot configure, pin or clean live evidence.

Legacy captures without trustworthy registered provenance are retained. Do not infer screenshot provenance from a PNG MIME type, arbitrary Artifact reference or filesystem scan. This additive slice does not promise secure erasure from backups, native OS screenshot permissions, Windows native acceptance or whole DATA-104 completion.

## Verification

- Actual expired byte deletion with original metadata and Ledger retained.
- Pinned, unexpired, unrelated image and project-file preservation.
- Same command retry/conflict, unknown receipts and read-only reconciliation.
- Cross-Run scope, malformed provenance, symlink/hardlink replacement and concurrent pin/cleanup denial.
- Shared authenticated HTTP/SDK/CLI/fixed Desktop routes and real settings integration.

## Verified slice and limits

[Current behavior and exact raw logs](../../../docs/validation/visual-evidence-retention/README.md) record Host three files/17 tests, CLI two files/29 tests, SDK two tests, Contracts one test and Evidence seven tests, plus five package type checks and architecture boundaries. Counts include existing CLI/Evidence cases. Actual isolated Chromium capture, private original + scoped Run byte deletion, pins, replay rejection, stale projection and optional LocalHost failure isolation are verified. Computer pixels use a deterministic native boundary, not an OS permission or mouse/keyboard claim.

A corrupt/stale visual projection disables only this optional service and garbage collection; ordinary Plan still completes. No automatic projection rollback or repair is implemented. The inventory is bounded to 10,000 observations/10,000 checkpoints, 500 pins, 16 copies, 100-item batches and 8 MiB private projection. Exhausted checkpoint capacity requires maintenance; no Ledger compaction is claimed. Node path-based unlink cannot atomically bind the final inode check: malicious same-user replacement during that final window remains outside the private-store threat boundary. Installed UI, Windows native acceptance and whole DATA-104 remain separately pending.

[Controller](../../../packages/host/src/visual-evidence-control.ts), [actual file/capture tests](../../../packages/host/src/visual-evidence-capture.test.ts), [optional shared owner tests](../../../packages/host/src/visual-evidence-local-host.test.ts), and [actual HTTP/CLI test](../../../apps/cli/src/visual-evidence-http.test.ts) provide reproducible evidence. No default profile, real credential or paid model was used.
