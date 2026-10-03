---
id: local-canonical-docs-site
language: en
status: current
---

# Local documentation preview

This VitePress site projects selected canonical files directly from the repository documentation directory. It is a local preview of the real package version, not a deployed public website. Current reference pages and proposed design pages keep separate status labels. Unreviewed translated files, internal Agent Notes, internal reference lineage, historical diagnostic baselines and the large generated module graph are outside this projection.

## Build and open

These commands require a source checkout; runtime preview archives omit the site sources. Use the Node and pnpm versions required by the repository, install the frozen lockfile, then run:

```sh
pnpm site:check
pnpm site:build
pnpm site:preview --host 127.0.0.1 --port 4173
```

The preview server binds only 127.0.0.1, rejects non-loopback host arguments and path escapes, and sends explicit UTF-8 text headers. Open the versioned local URL printed by the preview command. The current version is `0.1.0-alpha.0`; the site has no invented stable release, latest alias, archive, or language switch. Search runs locally over the selected canonical pages without a hosted search account or telemetry.

## Read the evidence

Each page displays its status, source language and real package version. Expand “Source and snapshot” to open a generated UTF-8 viewer of the exact Markdown, download its unchanged source bytes and inspect their SHA-256 digest. A dirty working-tree snapshot is labelled as uncommitted: remote repository links can differ from these local files. Repository-only references remain links to the repository revision, with that limitation and unverified remote availability identified; internal and unreviewed-translation references do not become published routes.

The generated `projection-manifest.json` records every selected source path, source digest, version, source commit/dirty state, check counts and excluded page. Static output is under `docs/.vitepress/dist`; these build artifacts are generated from source, not a second editable documentation tree.

## Quality gates and scope

The [page manifest](../site-pages.json) is an explicit finite allowlist. The build invokes the real Mermaid parser in a controlled DOM process, validates every selected page's local file and anchor references, checks page status against frontmatter, verifies the version against the root package, and rejects translations or internal lineage in the allowlist. It uses VitePress heading and fence tokens, including tilde and long fences; include/snippet imports, noncanonical paths and symlink aliases are rejected. Broken links, invalid Mermaid, contradictory metadata, an invented version, hidden imports and publication aliases have negative regression fixtures. VitePress also checks routed internal links while building.

All other repository pages are listed as excluded, not reported as tested or published. External URL availability is not checked by the offline gate. Browser checks cover current/proposed status, exact source access, local search and a rendered Mermaid diagram. The [translation checker](../i18n/README.md) remains a separate gate: a mechanically fresh pair is not a human-reviewed translation.

## Future publication

A public deployment, additional versions or translated routes require a separate scope decision and actual evidence. A draft badge does not authorize publishing an unreviewed translation. This local site does not establish external Memory quality evaluation or non-maintainer release acceptance; those retain their own evidence requirements in the [release guide](../releases/README.md).
