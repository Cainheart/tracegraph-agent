# Mermaid diagram rendering repair — 2026-10-06

## Result

The architecture diagram from the existing conversation now renders in the installed macOS Desktop as an SVG with visible nodes and connectors. The failure was caused by `graph` being used as a Mermaid node ID in an edge (`runtime --> graph`): normalization renamed shaped IDs such as `graph[State]`, but left bare reserved-word references unchanged. Mermaid then rejected the diagram and the UI fell back to source.

The renderer now normalizes reserved node IDs both when they have a shape and when they appear as edge endpoints. A standalone `end` remains a subgraph terminator. The regression fixture uses the Mermaid source recovered from the affected conversation and mounts the real `MarkdownContent` renderer.

## Verification

- `pnpm --filter @tracegraph/workbench exec vitest run src/components/MarkdownContent.mermaid.test.tsx` — passed; the component produced Mermaid SVG and no `.mermaid-error`.
- `pnpm --filter @tracegraph/workbench typecheck` — passed.
- `pnpm --filter @tracegraph/workbench test:unit` — passed, 375 tests across 47 files.
- `pnpm build` — passed for all 22 workspace builds, including Web and Desktop.
- Packaged Desktop was launched from `/Users/cain/Applications/Outlive Agent.app`; the affected historical conversation was opened and its architecture diagram was visually confirmed rendered. The accessibility tree exposed the diagram's SVG labels and not the source-fallback error.

`pnpm docs:check` remains blocked by stale generated documentation catalogs already present in the dirty workspace; those generated files were not regenerated or overwritten as part of this repair.

## Installed package and data safety

- Installed app: `/Users/cain/Applications/Outlive Agent.app`
- Version: `0.1.0-alpha.0`
- Product build ID: `6698000685297ace2d7a9e360082b2532905bc71e12d05cee5df6d6d64cbea72`
- Default Profile backup: `/Users/cain/.outlive/backups/default-before-mermaid-fix-20261006`; a recursive comparison against the Profile after installation found no differences.
- Previous app retained for rollback at `/Users/cain/Applications/Outlive Agent.previous-20261006-before-66980006`.
- This local build is unsigned and not notarized. `spctl --assess` does not pass; it is a local test build, not a signed release.

The dedicated temporary build directory `_tmp_release/mermaid-diagram-fix-20261006` was removed after installation and verification. The Profile, its backup, rollback app, and historical validation records were preserved.

## Scope

This repairs Mermaid diagram parsing in chat. DSH's image handling concerns safe, scoped asset loading; the screenshot's failure occurred before asset loading, while parsing Mermaid source, so no image URL or provider changes were needed.
