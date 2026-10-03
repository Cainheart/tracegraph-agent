---
id: 2026-10-03-public-proofs-preview-artifacts
title: Executable public proofs and installable preview artifacts
status: implemented
owners: [release]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [DEMO-080, DEMO-081, DEMO-082, REL-083]
supersedes: []
---

# Executable public proofs and installable preview artifacts

## Problem and decision

Recorded-session fixtures prove deterministic semantics but do not prove real
process death, installed-package resolution, or descendant process cleanup.
Add offline executable demonstrations using production public package exports,
controlled model decisions, real files, child processes, and canonical ledgers.
Keep generated evidence outside source; fail without a success report whenever
an oracle fails. A repeated reconciliation must not replay a mutation.

## Boundaries

User-authored Memory candidates gain an optional `allow_export` consent flag,
defaulting to false. It applies only to the exact authored version, still
requires activation and all Capsule eligibility checks, and cannot bypass
project scope or secret-content restrictions. Corrections default to no export
consent and accept a fresh explicit opt-in for the corrected version; no old
consent is silently inherited. The public proof exports the active original and
the independently consented correction, then proves revoked exclusion and denied
later export. An exported
external copy cannot be remotely revoked. CLI and Workbench expose the opt-in.

The preview is a private, unsigned workspace distribution with pinned dependency
installation. Its tarball includes built outputs, manifests, lock/config,
instructions, limitations, checksums, and a dependency SBOM. It is not an npm
publication, notarized application, or production installer. A fresh-directory
install on a maintainer machine is explicitly not clean-machine verification
or the independent non-maintainer acceptance required by REL-084.

Workbench CSS exports point to built `dist` assets, copied during its build, so
the preview never depends on source-only exports. Release verification checks
Desktop main, preload and renderer entrypoints. Staging rechecks build hashes;
the installer refuses tampered bytes before any dependency command runs.
The inventory is closed: installation rejects every unlisted file/directory,
and installed smoke permits only real node_modules roots for declared packages.
pnpm lifecycle scripts and pnpmfile hooks are disabled. Archive creation excludes
macOS AppleDouble metadata rather than allowing unlisted files. A passed smoke
receipt is committed only after every Host/Runtime resource cleanup succeeds.

Desktop `--preview` skips Host launch and the Host user-data path entirely. The
Main-process startup test imports the real composition module with Electron
boundary doubles and proves no Host launch/data access in Preview, while normal
startup still launches the private Host. This corrects a discovered mismatch
between the documented synthetic Preview boundary and unconditional Host boot.

## Validation and rollback

Demonstrations must retain crash/restart/reconcile facts, Memory lineage and
request evidence, revoked recall exclusion, exported Capsule checksums, and
actual process/group absence after durable cancellation. Stage and smoke the
preview outside the checkout without source files or checkout node_modules.
Removing the tooling and temporary bundles rolls back this addition without
changing user data or runtime semantics.

## Evidence

- Implementation: [public proofs](../../../demos/proofs.mjs),
  [preview builder](../../../scripts/create-preview-release.mjs),
  [inventory verifier](../../../scripts/verify-preview-integrity.mjs),
  [installer](../../../scripts/preview-install.mjs), and
  [installed smoke](../../../scripts/preview-smoke.mjs).
- Consent: [contracts](../../../packages/contracts/src/memory-control.ts),
  [Memory control](../../../packages/core/src/domains/memory/memory-control.ts),
  [CLI](../../../apps/cli/src/memory-command.ts), and
  [Workbench](../../../packages/workbench/src/components/MemoryControlPanel.tsx).
- Tests: [release gates](../../../scripts/verify-release.test.mjs),
  [preview negatives](../../../scripts/create-preview-release.test.mjs), and
  [Memory consent tests](../../../packages/core/src/domains/memory/memory-control.test.ts).
  [Preview startup boundary](../../../apps/desktop/src/preview-startup.test.ts)
  verifies the real Main composition branch.
- Current-run verification: all three executable proofs passed with real
  process/WAL/Memory oracles; Memory control 7 tests and CLI 3 tests passed.
  Fresh archive installation with optional Electron and headless installed CLI /
  Desktop Host smoke passed on macOS arm64 / Node 24.21.0. Clean-environment and
  visible GUI evidence are recorded separately by the verifier; independent
  non-maintainer acceptance remains an external outcome, not implied here.
- Owning documentation: [release instructions](../../../docs/releases/README.md)
  and [engineering module](../../../docs/modules/13-工程化与发布.md).
