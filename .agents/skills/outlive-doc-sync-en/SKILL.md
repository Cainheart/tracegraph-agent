---
name: outlive-doc-sync-en
description: Synchronize truth sources and inspect links, status, and existing docs eval after TraceGraph or Outlive module docs, V2 design docs, indexes, or Agent Notes change; English workflow.
---

# Documentation sync

Distinguish [current module docs](../../../docs/modules/) from the [proposed V2 design](../../../docs/outlive-agent-v2.md). Source and tests establish current capabilities; V2 text does not prove that a feature shipped. The Chinese equivalent is [outlive-doc-sync-zh](../outlive-doc-sync-zh/SKILL.md). Run commands from the repository root.

1. Identify each changed document's owner and inbound links. After an implementation change, update the owning module doc, then consider docs/README.md, README.md, README.en.md, and DIRECTORY.md. When moving a V2 module, synchronize docs/outlive-agent-v2/README.md, manifest.yaml, roadmap.yaml, and old-path links. Never replace current facts with target-state prose.
2. For new or moved files, check relative links and anchors, frontmatter id/status/parent, manifest coverage, and roadmap task IDs/dependencies. If the DAG changes, verify every dependency exists, IDs are unique, and no cycle exists. This repository does not yet have a complete automated link/YAML/DAG checker; report any unverified item honestly.
3. Run the existing documentation-consistency eval:

       pnpm exec vitest run --config vitest.evals.config.ts evals/docs
       git diff --check

   Before running, inspect _tmp_evals/ for results worth retaining: the eval truncates existing metrics/*.json there and writes ignored reports and metrics. It checks selected docs/implementation mappings and release consistency, **not** every link, YAML file, or translation's meaning. Inspect the selected test count and failures; do not silently rewrite eval baselines.
4. Report updated truth sources/indexes, check results, manual-check scope, and residual risk. A broken link, conflicting status, or unverified current-behavior claim blocks a docs-synchronized conclusion.
