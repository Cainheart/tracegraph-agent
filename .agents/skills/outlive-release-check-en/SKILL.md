---
name: outlive-release-check-en
description: Check existing release consistency and artifact boundaries when TraceGraph or Outlive versions, package entrypoints, lockfiles, or private build artifacts change; English workflow.
---

# Release check

The current repository produces a checksummed **private workspace bundle**, not npm publication, signing proof, or V2 product demos. The Chinese equivalent is [outlive-release-check-zh](../outlive-release-check-zh/SKILL.md). First read the [release module doc](../../../docs/modules/13-工程化与发布.md) and [package.json](../../../package.json).

1. Verify the intended version, tag, package entrypoints, and change scope. Inspect CHANGELOG, package versions, exports/bin, and README boundary claims. A successful local build does not prove a user can install it or that remote publication happened.
2. From the repository root select pnpm verify:lockfile, pnpm build, and pnpm release:check. For release-rule or script changes also run pnpm test:engineering; for docs use [doc sync](../outlive-doc-sync-en/SKILL.md). pnpm release:check needs built dist but checks without generating a bundle.
3. pnpm release:bundle writes _tmp_release/ and creates a private bundle. Run it only when the user requests a release artifact. Inspect any existing output there first to avoid overwriting user artifacts. Do not automatically tag, upload, push, or publish.
4. Report version, exact commands, results, artifact location if generated, and uncovered installation/recovery/cancellation/evidence demos. If external release state is unknown, say unknown; local success cannot stand in for it.
