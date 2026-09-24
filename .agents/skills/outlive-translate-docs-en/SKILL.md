---
name: outlive-translate-docs-en
description: Keep meaning, links, code, and status aligned when adding or updating paired Chinese and English TraceGraph or Outlive docs; English workflow.
---

# Chinese and English docs

The repository root README.md ↔ README.en.md is an explicit public pair. AGENTS, CHANGELOG, evals/README, Agent Notes, and the example README now have .zh.md counterparts; these repository-maintenance skills pair -zh ↔ -en. Most V2 prose still exists only in Chinese, and no automated pairing manifest exists. Do not infer other pairs from filenames alone. The Chinese equivalent is [outlive-translate-docs-zh](../outlive-translate-docs-zh/SKILL.md).

1. Identify the actual pair and authored language for this change. Synchronize only changed semantic units; do not retranslate reviewed unchanged passages. If a counterpart does not exist, confirm that a full translation is wanted instead of inferring a pair from a filename.
2. Compare facts, Current/Target/Deferred status, limitations, commands, configuration keys, event names, links, and code blocks section by section. Preserve technical identifiers; explain them in Chinese and use natural, accurate English. Translation must not turn target capabilities into current claims.
3. Update language-switch links, indexes, and inbound references. Run the existing checks from [doc sync](../outlive-doc-sync-en/SKILL.md) and manually compare semantics and local links. There is no i18n pair manifest, source digest, or automated translation-freshness gate yet; never claim one passed.
4. Report pair paths, source language, changed scope, unresolved terminology, and manual verification. Mark an uncertain technical fact for review rather than inventing a translation.
