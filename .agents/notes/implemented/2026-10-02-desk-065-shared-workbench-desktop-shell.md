---
id: 2026-10-02-desk-065-shared-workbench-desktop-shell
title: Extract a shared workbench and add the isolated Desktop shell
status: implemented
owners: [desktop, web]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/workbench, apps/web, apps/desktop, apps/desktop-host, packages/sdk]
supersedes: []
---

# Agent Note: Extract a shared workbench and add the isolated Desktop shell

## Problem

The Web app already owns the primary Workspace/Session navigation, conversation, Run trajectory, Tool status, and review surfaces. Its `App` accepts a `WorkbenchClient`, but the views and client contract live under `apps/web/src`, so an Electron renderer cannot consume them through a stable inward package boundary. DESK-064 provides the initial private Host process but no Electron shell.

## Current implementation

- `packages/workbench` owns `App`, `WorkbenchClient`, the Demo/Live clients, projection model, components, translations, CSS, and UI/client tests. `App` requires an injected client; Web and Desktop are separate composition roots.
- `apps/web/src/main.tsx` injects the existing HTTP/SSE `LiveTraceGraphClient`. Web build and its protocol-conformance test passed.
- `apps/desktop` uses Electron 44.5.1, launches the exact-version `@tracegraph/desktop-host`, loads a local renderer file, and exposes only five schema-validated IPC methods for Host status, Session list/read, and Run get/start.
- The default Desktop adapter reports no registered projects because DESK-064 has no project-registration route. Active Run events use 500 ms polling of canonical `run.get` projections; unsupported command families fail with explicit unavailable errors.
- `--preview` injects only `DemoTraceGraphClient` and the shared header marks it “Preview”/“演示预览”. The actual Electron window was checked in Preview and normal live modes.

## Decision and implementation

Extract the current Workbench views, shared client contract/adapters, model, translation catalog, tests, and styles into a private `@tracegraph/workbench` workspace package. Keep `apps/web` as the Web composition root and have it explicitly inject its existing `LiveTraceGraphClient`.

Create `apps/desktop` with a small Electron Main process that launches `@tracegraph/desktop-host` and loads a packaged local renderer file. The preload exposes a fixed typed surface for Host identity/status and the supported Run/Session queries/command; it does not expose generic `ipcRenderer`, Node, arbitrary channels, paths, or secrets. The renderer uses the shared `WorkbenchClient` view contract and the desktop bridge adapter.

The live desktop surface shows facts available from the current Host route slice. A deliberate `--preview` launch may use the existing `DemoTraceGraphClient` for visual review; it must show an unmistakable Preview indicator and must never label demo data as live Host state. Directory selection, persistent project registration, credentials, and unsupported command families remain DESK-066/later scope.

## Alternatives considered

- Import `apps/web/src` directly from Desktop: rejected because apps are composition roots and cross-app source imports create a deep dependency in the wrong direction.
- Copy the Web UI into Desktop: rejected because it duplicates the business presentation and will drift.
- Put the shared views in `@tracegraph/workbench`: selected because Web and Desktop are two real consumers, the existing `WorkbenchClient` is already an injectable seam, and the package gets contract/UI tests.

## Invariants and boundaries

- The shared Workbench owns presentation and client-neutral view state; Host/Core remain the source of business truth.
- Web and Desktop inject transport adapters into the same `App`; the shared package imports no Electron or Node modules.
- Electron Main owns the Host child lifecycle. Preload exports only explicit methods. Renderer runs with `contextIsolation`, sandboxing, and `nodeIntegration: false`.
- The packaged renderer loads from `file://`; Electron Main does not start an HTTP server or open a listener.
- Every RPC request and response is parsed by the existing SDK/contracts schemas in Main before crossing into the renderer.
- Demo state is explicitly marked and cannot be presented as a real Run or Host receipt.
- DESK-065 does not add project path authority, credential access, persistent settings, or unsupported Host route semantics.

## Migration and rollback

Move shared sources and tests into `packages/workbench`, retaining the same exported UI and behavior. `apps/web` changes only its imports and explicit client construction. If Desktop shell work is rolled back, the Web app continues consuming the shared package; the package remains justified by its two consumers.

## Acceptance criteria

- [x] Web and Desktop render the same shared Workspace/Session navigation, conversation, Run activity, and Tool status UI from `@tracegraph/workbench`.
- [x] The Web app keeps its HTTP/SSE Host semantics after injecting its client explicitly.
- [x] Desktop Main launches the exact-version Host, uses its supported framed routes through fixed typed preload methods, and reports unsupported functionality without inventing business state.
- [x] The `--preview` surface is visibly marked Preview and uses only `DemoTraceGraphClient` state.
- [x] Renderer/shared Workbench have no Node/Electron imports; preload runtime imports only Electron's `contextBridge` and `ipcRenderer`; Main opens no network port.
- [x] Desktop build and real Electron Preview/live launch smoke pass. Workbench: 149 tests and typecheck; Desktop: 5 adapter/security tests, typecheck, and build; Web: build and protocol test.
- [x] Workspace dependency policy, generated module graph, roadmap, Desktop/client docs, package READMEs, and paired Note agree.

## Risks and open questions

- The current Host has no project list/open-local route, so live Desktop starts with no registered Workspace. The session list remains Host-owned. DESK-066 supplies native project registration.
- The first Desktop adapter must not make the unsupported command list look like transport failures. UI messaging should preserve the route's explicit unavailable state.
- Electron packaging and update signing are outside this task.

## Evidence

- Implementation: `packages/workbench/src/`, `apps/web/src/main.tsx`, `apps/desktop/src/`, `apps/desktop/renderer/`.
- Tests: `pnpm --filter @tracegraph/workbench test:unit` (149 passed), `pnpm --filter @tracegraph/desktop test:unit` (5 passed), `pnpm --filter @tracegraph/web test:unit` (1 passed).
- Builds/typechecks: Workbench build/typecheck; Web build; Desktop build/typecheck.
- Architecture: `verify:lockfile`, `verify:package-readmes`, `verify:boundaries`, `verify:invariants`, `graph:modules:check`, and `verify:v2-docs` passed.
- Runtime: Electron window visibly rendered shared UI in normal and `--preview` modes; the preview label was visible, normal mode showed “Local” and no registered Workspace; `lsof -nP -a -p <Electron-main>,<Desktop-Host-child> -iTCP -sTCP:LISTEN` returned no listeners.
