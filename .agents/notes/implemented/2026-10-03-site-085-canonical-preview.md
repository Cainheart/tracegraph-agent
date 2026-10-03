---
id: 2026-10-03-site-085-canonical-preview
title: Project canonical documentation into a bounded local VitePress preview
status: implemented
owners: [docs, repository-governance]
created: 2026-10-03
last_reviewed: 2026-10-03
language: en
affects: [docs, scripts, package.json, pnpm-lock.yaml, ci]
supersedes: []
---

# Project canonical documentation into a bounded local VitePress preview

## Problem

SITE-085 requires a reproducible documentation projection after P1–P7 and its release prerequisites. The repository now has locale, translation-freshness and reference-generation gates, and now needs a site that preserves those boundaries. Documentation includes current behavior, proposed designs, internal lineage material and unreviewed translations; publishing the whole tree would erase those boundaries.

## Current state and verified prerequisites

Implementation began only after the coordinating task confirmed the Memory corrections and independent review: Core 56 files / 468 tests, the competing-worker regression, and corrected-memory/cache checks passed. Release archive clean-install/proofs and the Desktop preview boundary were also validated. Optional external quality evaluation remains not evaluated, and non-maintainer acceptance remains open; neither is claimed by this local website.

## Implemented projection

The lockfile installs exact VitePress 2.0.0-alpha.20, Vue 3.5.43 and jsdom 26.1.0, with the existing exact Mermaid 12.0.0 catalog. VitePress uses the repository's Vite 8 family. Frozen lock verification and the high-severity dependency audit passed after installation. These are source-checkout development dependencies; the runtime preview archive has no site sources.

Read canonical Markdown directly from the repository's documentation directory. An explicit page manifest selects the documentation index, current module references, generated event/tool/module/profile catalogs, release/install/limitations material, locale governance, and the two proposed Runtime/Session and Command/Query/Event design pages. Internal reference-lineage, Agent Notes, unreviewed translated files, historical diagnostic baselines and the large generated module graph are excluded. This is a finite first projection, not a claim that every repository document or all design Mermaid blocks were published or validated.

Each selected page exposes its source path and exact digest, real package version, source language and current/proposed status. Local full-text search indexes only selected canonical pages. There are no fabricated stable releases, historical versions or reviewed translations; unavailable version/language switches remain absent or explicitly unavailable. Source-link rewriting distinguishes selected site pages, repository-only references and excluded translations. Build output contains a UTF-8 source viewer and unchanged Markdown downloads for selected canonical documents; no separately maintained Markdown body exists.

## Alternatives considered

Copy documents into a website source tree: rejected because it creates drift. Publish every Markdown file: rejected because internal and unreviewed material would become public content. Adopt a second CMS or hosted service: outside scope. VitePress 1.6.4 is the published stable alternative, but uses a separate older Vite family; the selected preview version must be recorded in the lockfile and actual validation evidence.

## Invariants and failure policy

Build fails on an unknown or missing selected page, a version mismatch, missing/contradictory status metadata, an unreviewed translation in the page manifest, a broken local file/anchor link or invalid selected Mermaid syntax. Mermaid validation must invoke the real parser in a controlled DOM environment; counting fences is insufficient. Excluded pages are reported as outside the projection rather than silently described as checked. VitePress tokens determine actual Mermaid fences and heading anchors. Include/snippet directives, noncanonical paths and symlink aliases fail closed. No network deployment, telemetry, credentials or hosted search service is introduced. The local static preview binds only 127.0.0.1 and rejects traversal; it does not use the upstream preview command, which ignores its host argument in this installed version.

## Migration and rollback

The documentation files remain the source of truth. Remove the site configuration, renderer and site-only dependency/script wiring to roll back; no domain state or stored user data changes. Build caches and generated static output remain ignored. A future public deployment and any expansion to reviewed translations require their own review evidence and scope decision.

## Acceptance criteria

- Actual local build from the current canonical documents, with source/version/status labels and functional local search.
- Deterministic allowlist and build manifest; no internal lineage or unreviewed translation route or search entry.
- Passing negative fixtures for dead local links, wrong punctuation anchors, stale/unknown version, all supported Mermaid fences, include/snippet imports and unauthorized publication aliases.
- Browser checks for a current page, a proposed page, search, source access and at least one rendered Mermaid diagram.
- Current owning documentation and this paired implemented Note were updated after the prerequisites and checks passed.

## Risks and limits

The artifact is a local canonical-document preview, not a deployed public website or a human-certified bilingual release. External repository links and external URL availability are distinct from the mandatory local-link gate. New site dependencies may alter the preview release inventory and require the parent task to rebuild its release artifacts after integration.

## Sources and evidence

Repository authority: [SITE-085 roadmap](../../../docs/outlive-agent-v2/roadmap.yaml), [DEC-10 governance](../../../docs/outlive-agent-v2/02-repository-governance/02-docs-generation-i18n.md), and [website design](../../../docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/04-docs-i18n-website.md). Official technical references: [VitePress configuration](https://vitepress.dev/reference/site-config), [routing](https://vitepress.dev/guide/routing), and [local search](https://vitepress.dev/reference/default-theme-search). Implementation: [projection and gates](../../../scripts/site-projection.mjs), [VitePress configuration](../../../docs/.vitepress/config.mjs), [local preview server](../../../scripts/preview-site.mjs), and [owning guide](../../../docs/site/README.md). Site/projection tests passed 12/12, and the combined site/translation/catalog tests passed 27/27. Local build passed for 32 selected pages, 526 local references and five Mermaid diagrams. Independent read-only review replayed the parser/scope regressions and checked that the built search index contains only the 32 selected routes. Safari verification showed current/proposed labels, a read_artifact search result opening its actual section, a rendered architecture diagram, and the UTF-8 exact-source viewer with matching SHA-256 and uncommitted snapshot status. No external deployment occurred.
