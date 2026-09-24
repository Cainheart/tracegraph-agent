---
name: outlive-agent-note-en
description: Maintain an evidence-backed Agent Note when a durable TraceGraph or Outlive architecture decision is proposed, shipped, rejected, or superseded; English workflow.
---

# Agent Note lifecycle

Read the [lifecycle policy](../../notes/README.md), [template](../../notes/TEMPLATE.md), and [repository rules](../../../AGENTS.md) first. The Chinese equivalent is [outlive-agent-note-zh](../outlive-agent-note-zh/SKILL.md). A Note preserves why a decision was made; it is not a product runtime instruction.

1. Decide whether the change actually affects a public contract, state ownership, Memory governance, authority/sandbox, a process boundary, benchmark meaning, or a durable limitation. Do not create a Note for a one-off implementation detail.
2. Search related Notes, source, and tests. Distinguish Current, Target, and Deferred; record only alternatives genuinely considered. Put a proposal in .agents/notes/proposed/ using the template, with invariants, migration/rollback, and failure/recovery acceptance. Mark unknown facts pending.
3. Mark a decision implemented and move it to .agents/notes/implemented/ only after code, tests, and current module docs agree. A file move alone is insufficient. A rejected proposal goes to rejected/ with a reason; archive an implemented Note only when it is no longer current, explaining its replacement or retirement. Update status, dates, and inbound/outbound links without erasing historical evidence.
4. Check changed relative links, frontmatter, inbound references, and git diff --check; use [doc sync](../outlive-doc-sync-en/SKILL.md) for affected indexes.

Report the Note path, status transition, evidence links, and open questions. If a major decision still awaits maintainer judgment, leave it proposed; never label design text as shipped on your own.
