---
id: client-locale-and-docs
language: en
status: current
---

# Client locale and documentation checks

The shared locale catalog lives in [SDK client locale](../../packages/sdk/src/client/locale/index.ts). Web and Desktop use the same Workbench provider. Terminal consumers use the same catalog and precedence: explicit `TRACEGRAPH_LOCALE`, then `LC_ALL`, `LC_MESSAGES`, and `LANG`. The repository has a CLI, not a complete TUI. Its human-readable startup labels consume the shared catalog; JSON protocol output remains unchanged.

## Fallback and terminology

English keys are canonical. Unsupported locale hints fall back to English; Chinese language variants select Simplified Chinese. Unknown keys preserve the original string, and missing interpolation values preserve the placeholder. The [terminology table](terminology.md) defines presentation vocabulary. Translation does not change event names, tool names, permission values, model text, or receipts.

## Pair validation

The [pair manifest](pairs.yaml) records exact source and translation hashes, source language, and review state. Run `node scripts/verify-translation-pairs.mjs --check` from the repository root. It checks both hashes, paragraph/list/table/heading structure, code blocks, inline code, YAML metadata, local links and anchors. External links are reported as unchecked. Draft pairs can pass mechanical checks. Legacy pairs use `legacy-unreviewed`: both files have separate structure and metadata fingerprints, because their historical layouts may differ. Every discovered bilingual pair must be registered; unregistered pairs fail. Passing does not establish semantic equivalence or human review.

To update a pair, edit the canonical source, update its translation, inspect the diff, and explicitly refresh both hashes in the manifest using SHA-256 of the exact file bytes. A human reviewer may then set `review_state` to `reviewed` with their name and review date. The checker never edits content or silently blesses a changed digest. `--require-reviewed` fails drafts and is required when claiming human-reviewed translations for publication. Use `node scripts/record-translation-baseline.mjs --register-unreviewed` only for explicit initial registration of unregistered historical pairs. It never refreshes existing fingerprints. After inspecting a changed pair, use `node scripts/record-translation-baseline.mjs --refresh <source-path> --acknowledge-unreviewed`; this explicitly refreshes that pair and revokes any previous human review. Lifecycle moves must update the source and translation paths in the manifest. Every registered file, including legacy pairs, receives local-link and YAML checks. This tool does not certify historical translations.

## Generated catalogs

Run `node scripts/gen-reference-catalogs.mjs --write` after changing event enums, built-in tool declarations, workspace modules, or entry profiles. Run `node scripts/gen-reference-catalogs.mjs --check` to compare every owned output without writing. The [generated index](../generated/README.md) records source digests and links. These are static source catalogs; dynamic MCP/extension tool inventories and machine-specific resolved configuration are outside their scope.
