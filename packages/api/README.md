# @tracegraph/api

Transport-neutral, in-process application controllers for the private local client surfaces. See [module 09](../../docs/modules/09-Host-与-SDK-接口层.md) and [the shared protocol design](../../docs/outlive-agent-v2/06-clients-protocols-desktop/01-shared-protocol-controller.md).

## Purpose

Own Run/Session application coordination that must be shared by local HTTP and future in-process/RPC adapters, while leaving transport parsing, authentication, and streaming in `@tracegraph/host`.

## Public API

The package root exports `RunSessionController`, `RunInteractionController`, `MemoryExperienceController`, their narrow Runtime/Session ports, and typed controller errors. Run/Session coordination covers Run/chat start/read, Session list/read/rename/delete/resume, registered-workspace binding, command idempotency, and single-active-Run admission. `RunInteractionController` supplies scope-bound approval, stop, plan/input, Todo and Artifact operations for Desktop; it validates reply identities and delegates business semantics to Runtime.

## Dependencies

It depends only on `@tracegraph/contracts`. Runtime, Session persistence, and Workspace handles are supplied through narrow typed ports/callbacks; this package does not depend on Core, Host, SDK, or Fastify.

## State ownership

The controller holds only process-local start-command fingerprints and the current active-Run coordination slot. The canonical Run Event Ledger and Session controller remain the durable owners.

## Extension points

The Host composition supplies current project Workspace handles, an optional isolated chat Workspace, Runtime operations, and the Session controller port.

## Model effect

The controller does not call a model. A valid Run command delegates to the injected Runtime, which may call a model and records its canonical facts.

## Verification

Run `pnpm --filter @tracegraph/api build && pnpm --filter @tracegraph/api test:unit` from the repository root.

## Known limitations

Web Run interactions and Artifact HTTP routes retain their existing Host/Runtime ingress; the new Run interaction controller is currently consumed by Desktop. Settings, extensions, MCP/LSP, Team, project lifecycle, and event streaming remain on their owning Host seams. Coordination remains process-local and assumes one Host instance.
