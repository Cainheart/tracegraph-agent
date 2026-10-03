---
id: 2026-10-03-installed-local-product
title: Installable local product with an independent bundled runtime
status: implemented
language: en
owners: [host, desktop, distribution]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/host, apps/desktop, apps/desktop-host, apps/cli, scripts, .github/workflows]
supersedes: []
---

# Agent Note: Installed local product

## Problem and accepted target

The existing unsigned workspace archive requires external Node.js and pnpm. The user requested an install-and-use local application. Keep the shared authenticated Host and typed Web/Desktop/CLI clients, but deliver an independent supported Node binary with the application. Electron-as-Node is unsuitable for sandboxed nested Node tasks because its framework resources are outside their authority.

Desktop uses a fixed bundled executable whose manifest, hash, identity and version are verified in the trusted composition layer. Installed startup never falls back to PATH. Source development retains the existing supported-Node resolver. Package scripts assemble artifacts; they do not own product behavior. Keep the @tracegraph package scope and persisted protocol vocabulary.

The Host selects a dynamic loopback port when no port is explicitly supplied. Packaged Web assets and the HTTP gateway reach the same Runtime as the private local channel. CLI launchers invoke the bundled Node and discover the same profile. Closing a window only detaches clients. Explicit Host stop closes background resources; no login item is installed automatically.

An explicit host.restart applies restart-scoped settings only when no active Run, queued admission, owned terminal/preview or other mutation is in flight. Quiesce admission before checking idle state and reject new writes until the replacement owner is ready. Busy restart never cancels work. A restart-request receipt is not readiness: Desktop rebinds its private client/streams only after a different boot nonce; Web and CLI verify the replacement owner and cleared pending settings. Installed clients compare a content-derived build identity and reject a different live build without automatically stopping it. Bundled Node is prepended only to the owner/launcher process PATH, so child Node tasks use the same independent runtime.

The branded default profile is ~/.outlive/profiles/default. Explicit existing profile roots remain usable. Existing ~/.tracegraph sources are offered to the existing inventory/backup/selection migration workflow; startup never silently merges or deletes them. Recovery requires explicit new authority and never automatically resumes imported or interrupted side effects.

The v2 package resource policy preserves the fixed target TypeScript native compiler and its full standard-library tree. These `.d.ts` files are runtime inputs, despite the packager's usual declaration pruning. Target-native optional packages are selected from the exact lockfile version/integrity and checked against their OS/CPU and executable header. The build identity covers the application stage, pinned Node and this resource policy. A separate post-builder inventory records actually delivered files and their resolved dependency graph; it does not pretend that dependency relocation, metadata normalization or pruning left the stage unchanged.

## Invariants and failure policy

- Private profile permissions, owner leases, bearer authentication, renderer isolation and permission ceilings remain intact.
- Bundled runtime identity or integrity failures produce setup-unavailable; model credentials and arbitrary environment arguments are never executable selection inputs.
- Same-origin packaged Web requests require the exact loopback gateway identity and browser provenance. Missing or foreign origins do not gain mutation authority.
- Model saving and a bounded connection test remain separate outcomes. Optional MCP/LSP configuration never blocks first chat.
- Installer artifacts include fixed application code, Web assets, CLI, native runtime dependencies and license material. User data and credentials are excluded.
- Unsigned, signed/notarized and independently verified platform outcomes are stated separately. No Windows or fresh-machine acceptance is claimed from a macOS cross-build.

## Compatibility and rollback

Keep legacy private framed Host and source launch seams for their compatibility tests. Keep old archive evidence as historical evidence; it does not prove the new installers. An installation upgrade leaves the profile outside the app bundle. An unsupported discovery protocol, unsafe profile or live competing writer fails closed. Replacing an app does not rewrite ledgers or automatically grant execution authority.

## Acceptance criteria

- [x] Bundled runtime validation rejects missing, corrupt, unsupported and Electron executables without PATH fallback.
- [x] Default-port startup, owner reuse, client detach and explicit stop are proved through actual local transports.
- [x] Packaged Web bootstrap and mutations are same-origin safe; foreign and missing-provenance requests fail.
- [x] A macOS app launches with no external Node/pnpm and shares real state with its bundled CLI.
- [x] Assembly builds self-contained macOS and Windows artifacts with checksums; native CI is configured, while signing and actual platform boundaries remain explicit.
- [x] Actual installed macOS first launch reaches saved model configuration, an explicit connection test and first chat; optional integrations do not block it.

## Evidence

Implementation and current evidence are indexed in [installed-local-product](../../../docs/validation/installed-local-product/README.md). Runtime/transport negatives, real idle/busy restart and installer integrity/dependency negatives passed. The macOS v2 real-app smoke has 13 assertions with actual native CodeGraph, private owner, bundled CLI, Web, PTY, background completion and restart. Actual DMG installation UI verifies setup, chat, exact approval, real patch/test/review and media at three sizes; installed media has 94 oracles and 666 independent verifier checks. Synthetic loopback providers and maintainer scope are explicit.

The earlier candidate's missing TypeScript standard libraries caused a real project-analysis failure; its evidence remains retained and is not final acceptance. Windows x64 NSIS/ZIP were cross-built and PE/icon/target-runtime inventories checked, but native Windows installation/launch/PTY and fresh independent-user acceptance remain unverified. No signing credentials were used; default artifacts are unsigned/unnotarized. Normal macOS application-quit observation is tracked separately from window close and harness signal cleanup; signals are not a successful Cmd-Q claim. Earlier unified-local-workbench evidence remains valid only for its previous source/archive scope.
