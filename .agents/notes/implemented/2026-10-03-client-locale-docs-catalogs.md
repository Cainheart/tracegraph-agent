---
id: 2026-10-03-client-locale-docs-catalogs
title: Shared client locale and verifiable documentation projections
status: implemented
owners: [client, docs]
created: 2026-10-03
last_reviewed: 2026-10-03
language: en
affects: [packages/sdk, packages/workbench, docs/i18n, docs/generated, scripts]
supersedes: []
---

# Shared client locale and verifiable documentation projections

## Decision

Keep locale as a transport-independent logical module under the existing SDK client public export. Web and Desktop consume the shared Workbench; terminal clients can use the same catalog without React. Do not create a physical client package just for locale. Preserve the existing English-string keys and local preference key to avoid a migration of every component.

Pair validation records exact source and translation hashes, structural fingerprints, local links and YAML metadata. Explicitly distinguish mechanically checked drafts from human-reviewed translations. All historical pairs are explicitly registered as legacy-unreviewed with independent structure and metadata fingerprints; unknown pairs fail. A passing gate is never a claim that repository translations are human-reviewed.

Generate event, built-in tool, module and profile catalogs deterministically from versioned source. Read-only check compares all owned files and reports every stale output. Dynamic MCP/extension tools and machine-specific resolved profiles are outside this static catalog.

## Invariants and rollback

Locale affects presentation only; wire values, ledger events, tool identifiers, model text and receipts are never translated. Unsupported locales fall back to English, unknown keys fall back to the input key, and missing interpolation values remain visible. No runtime authority moves. Rollback restores the previous Workbench catalog and removes the new documentation commands; no persistent data migration is needed.

## Acceptance and evidence

The shared Workbench (Web/Desktop) and CLI startup labels consume one catalog. A full TUI does not currently exist and is not created by this task. Current behavior and review boundaries are documented in [locale governance](../../../docs/i18n/README.md).

- Implementation: [shared locale](../../../packages/sdk/src/client/locale/index.ts), [pair checker](../../../scripts/verify-translation-pairs.mjs), [catalog generator](../../../scripts/gen-reference-catalogs.mjs).
- Contract evidence: SDK locale tests 3/3; Workbench provider render tests 3/3; engineering negative fixtures 14/14. SDK and CLI builds plus Workbench typecheck passed.
- Negative evidence: changed source/translation hashes, structural or metadata drift, broken links/anchors, omitted new pairs, missing review evidence, tampered/deleted catalogs and changed source inventory all fail. The explicit fingerprint refresh revokes a previous reviewed state.
- Verification commands: `node --test scripts/verify-translation-pairs.test.mjs scripts/gen-reference-catalogs.test.mjs`, `node scripts/verify-translation-pairs.mjs --check`, `node scripts/gen-reference-catalogs.mjs --check`.

Profile references reproduce real versioned declarations and bind their source hashes. They do not invent live resolved settings or profiles for surfaces with no declaration. External link availability and human translation equivalence remain outside the mechanical gate.
