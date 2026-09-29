---
id: 2026-09-29-core-020-kernel-extraction
title: Extract the existing Core kernel primitives without behavior changes
status: implemented
owners: [core]
created: 2026-09-29
last_reviewed: 2026-09-29
affects: [core-kernel, architecture]
supersedes: []
---

# Agent Note: Extract the existing Core kernel primitives

## Problem

`packages/core/src` is currently flat for foundational utilities and shared
Runtime/provider interfaces. `types.ts` imports `SandboxRunner` from its
implementation directory, so moving the shared types as-is would make the
kernel depend inward on an execution seam.

## Current state at task start

- `crypto.ts`, `workspace.ts`, and `types.ts` live directly under
  `packages/core/src/` and are re-exported by the package root.
- `types.ts` contained model, tool, provider, and Runtime callback contracts; its
  only implementation-directory dependency is the sandbox runner type.
- Workspace creation and path validation perform local filesystem operations.
- Canonical Event schemas and durable writers live in their current modules;
  this task does not change either.

## Decision

Accepted and implemented as a behavior-preserving kernel extraction. Move the
current foundational implementation into `packages/core/src/kernel/`:

- `brand.ts`: a type-only nominal-brand helper for future internal adoption;
  do not apply it to current public identifiers in this task.
- `types.ts`, `crypto.ts`, and `workspace.ts`: move the existing declarations
  and implementations without semantic edits.
- `registration.ts`: own the sandbox runner port and its structural request/
  result contracts so kernel types no longer import a sandbox implementation.
- Keep `@tracegraph/core` root export names and Runtime behavior unchanged.

The `kernel/` directory is the first internal layer, not a claim that every
current file is already a pure, zero-I/O foundation. Moving or splitting
filesystem-backed workspace operations, tool execution, and capability
lifecycle behavior remains deferred to their own roadmap tasks.

## Alternatives considered

- Leave `types.ts` importing `sandbox/runner.ts`: rejected because it reverses
  the intended dependency direction as `seams/` is introduced.
- Retag all current IDs as opaque brands during the move: rejected because it
  changes the public TypeScript contract and exceeds the behavior-preserving
  acceptance for `CORE-020`.

## Invariants and boundaries

- No `SessionEvent`, Projection, storage format, command, or runtime behavior
  changes.
- Package-root public export names remain unchanged; only their source paths
  move.
- `kernel/` may depend on `@tracegraph/contracts`, its declared type/runtime
  libraries, and platform primitives needed by the moved implementation.
- `kernel/` must not import from `domains/` or `seams/`; those layers may depend
  on kernel-owned types and ports.
- Existing redaction registration, workspace validation, and cleanup behavior
  remain byte-for-byte equivalent apart from import paths.

## Migration and rollback

Move implementation files and update internal relative imports. Restore the
old source paths and import specifiers to roll back; no data migration or
runtime configuration change is needed. Keep adapter-owned re-exports for
sandbox port types so their existing package-root exports remain stable.

## Acceptance criteria

- [x] Kernel primitives and registration ports live under `src/kernel/`.
- [x] Kernel source has no imports into `domains/` or `seams/`.
- [x] Existing package-root exports and canonical Event contracts are
      unchanged.
- [x] Existing Core behavior checks and type/build gates pass.
- [x] Current Core documentation describes the new source locations without
      claiming the proposed full foundation has shipped.

## Risks and open questions

- `workspace.ts` owns filesystem-backed operations today. Its placement under
  `kernel/` is transitional; later extraction must decide which operations
  belong behind a host-owned workspace seam without changing their authority
  checks.
- The brand helper remains unused until a separately scoped, compatibility-
  reviewed ID-type migration.

## Evidence

- Implementation: [`packages/core/src/kernel/`](../../../packages/core/src/kernel/), [`packages/core/src/index.ts`](../../../packages/core/src/index.ts), and adapter-owned type re-exports in `packages/core/src/seams/sandbox/`
- Tests: [`crypto.test.ts`](../../../packages/core/src/crypto.test.ts),
  [`workspace.test.ts`](../../../packages/core/src/workspace.test.ts), and
  [`sandbox.test.ts`](../../../packages/core/src/seams/sandbox/sandbox.test.ts)
  passed as part of the 13-file focused Core run (121 tests total), alongside
  the Tool/Policy/Approval/Runtime suites recorded in the CORE-022 Note.
- Verification: Core build/typecheck and the focused behavior suites passed;
  `graph:modules:check`, `verify:v2-docs`, `verify:package-readmes`,
  `verify:boundaries` (12 packages, 20 dependencies, 1,266 imports),
  `verify:invariants`, kernel import scan, stale-path scan, and
  `git diff --check` passed in the CORE-020/021 worktree sequence.
