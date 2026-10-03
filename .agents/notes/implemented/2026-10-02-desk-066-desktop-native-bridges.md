---
id: 2026-10-02-desk-066-desktop-native-bridges
title: Add scoped native project, file, and credential bridges to Desktop
status: implemented
owners: [desktop, desktop-host]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [apps/desktop, apps/desktop-host, packages/workbench, packages/core]
supersedes: []
---

# Agent Note: Add scoped native project, file, and credential bridges to Desktop

## Problem

DESK-065 delivered an isolated Electron shell and shared Workbench, but Desktop has no native project registration, project-scoped file opening, or credential configuration. The Run/Session controller already enforces registered-project scope, while the shared Workbench already has folder and model-settings entry points. Desktop must connect those existing seams without letting Renderer-provided paths become authority or returning credential values.

## Current state

- `apps/desktop/src/main.ts` exposes five fixed IPC methods and launches `@tracegraph/desktop-host` with an empty project set.
- `apps/desktop-host/src/desktop-host.ts` binds its Run/Session controller to an in-memory project map populated only at startup.
- `packages/workbench` already calls `openLocalProject`, `revealProject`, `removeProject`, `getModelConfig`, and `configureModel`; the Desktop adapter does not implement them.
- Core provides `WorkspaceHandle`, `ProjectSummary`, `ConfigurableModelAdapter`, `CredentialStore`, a macOS Keychain backend, and a strict-permission private-file fallback.

## Proposal

Keep native authority in Electron Main and the Desktop Host. Main presents native folder/file dialogs; the Host canonicalizes selected directories, persists registrations in its private data directory, and keeps real roots plus opaque Workspace handles. Renderer receives only safe project summaries and IDs. Run, Session, reveal, remove, and file-open operations resolve those IDs against Host-owned registrations on every call. Removing a registration does not delete the user's directory.

The file-open action is bound to an already registered project. Main obtains its root through the private Host control channel, asks the OS to select a file under that root, resolves symlinks, rejects paths outside the canonical root and non-regular files, and opens only the validated selection.

Model settings use the existing shared Settings UI. API keys travel only over fixed, schema-validated IPC and the private Main/Host control channel. The Host stores values through Core's platform CredentialStore, config persists only a `${secret:NAME}` reference, and the Host resolves the reference immediately before provider requests. Public responses expose metadata and `has_key`, never plaintext. macOS uses Keychain; other supported platforms use Core's private-permission file backend and fail closed on backend errors.

## Alternatives considered

- Accepting a Renderer-supplied absolute path: rejected because a path string cannot prove an OS user grant.
- Restarting the Host after every project change: rejected because it interrupts active work and needlessly replays recovery.
- Returning or persisting API keys in model configuration: rejected because the existing Core credential seam and safe metadata contracts already support reference-only configuration.

## Invariants and boundaries

- Native dialogs run only in Electron Main; no IPC method accepts a filesystem path from Renderer.
- Workspace handles and canonical roots remain Host-owned. Renderer project IDs are lookup keys, not filesystem capabilities.
- Every project-specific Host operation checks the current registration and Workspace capability profile.
- File opening requires a selected file whose canonical real path stays beneath the registered project's canonical root.
- Credential APIs are write-only for secrets. Responses, persisted configuration, logs, and errors contain no credential values.
- Credential backend errors never trigger a plaintext fallback. The non-macOS Core fallback is private-permission storage, not hardware-backed encryption.
- Web's existing HTTP project and credential routes are unchanged; this bridge is Desktop-only.

## Migration and rollback

Persist project registrations under the Desktop Host data directory using a versioned, schema-validated file. Existing Desktop installs have no projects or model configuration, so startup begins with an empty registry. If native bridge startup data is invalid, the Host fails closed or skips the invalid project with a safe warning; it never grants broader access. Removing a project unregisters metadata only. The model config stores only non-secret provider settings and a secret reference; rollback can remove those config records without touching user projects or Keychain entries.

## Acceptance criteria

- [x] Native folder selection creates a persistent Host registration; Main/Renderer can list and select projects using safe summaries, and removal leaves files untouched.
- [x] Project IDs are resolved against the Host-owned opaque Workspace registry for Run/Session operations; unregistered IDs and stale roots are rejected.
- [x] The Workbench can open a file through an explicit native picker scoped to a registered project; traversal, symlink escape, and non-file targets are rejected.
- [x] Existing model settings configure a live Desktop Host using reference-only persisted config and the platform CredentialStore; API-key values never appear in read responses or persisted config.
- [x] Contract tests cover unauthorized IDs, invalid/removed roots, file escape, credential backend failure, secret redaction, and restart persistence.
- [x] Paired Notes, Desktop/Host docs, roadmap, dependency policy, module graph, and V2 docs agree with shipped behavior.

## Risks and open questions

- On Windows/Linux the existing fallback is protected by private filesystem permissions but is not equivalent to an OS keychain. A future native secret service may replace it behind `CredentialStore`.
- Persisted local paths can become unavailable after a directory is moved; the Host must expose that registration as unavailable and require a fresh native selection rather than silently changing its authority.

## Evidence

- Implementation: `apps/desktop-host/src/project-registry.ts`, `model-configuration.ts`, `native-control.ts`, `worker.ts`, and `desktop-host.ts`; `apps/desktop/src/main.ts`, `native-files.ts`, `bridge-contract.ts`, `ipc-channels.ts`, `preload.cts`, and `desktop-sdk.ts`; optional Workbench project-file capability in `packages/workbench`.
- Tests: Desktop Host unit tests (6 passed), Desktop Host child-process E2E (4 passed), Desktop unit tests (8 passed), Workbench tests (149 passed), Web protocol fixture test (1 passed). The real Electron window registered a temporary directory and opened an in-project text file through the OS default app; the temporary registration and fixture directory were removed afterward.
- Verification: typechecks passed for Desktop Host, Desktop, Workbench and Web. Desktop Host, Desktop, Web and Workbench builds passed. `verify:lockfile`, `verify:package-readmes`, `verify:boundaries`, `verify:invariants`, `graph:modules:check`, `verify:v2-docs`, and `git diff --check` passed. The checks use `env -u NODE_OPTIONS` because the inherited shell preload points to a missing file. No real API key or system Keychain write was used.
