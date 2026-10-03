---
id: 2026-10-02-client-068-memory-experience-control
title: Connect Memory and Experience controls through shared client protocol and UI
status: implemented
owners: [client-memory, api, desktop]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [packages/contracts, packages/api, packages/sdk, packages/host, packages/workbench, apps/desktop-host, apps/desktop]
supersedes: []
---

# Agent Note: Connect Memory and Experience controls through shared client protocol and UI

## Problem

MEM-046 provides an owner-scoped Memory control service and Web/CLI clients. MEM-050 provides persistent Experience candidates and lifecycle transitions, but Experience has no Host API or client surface. DESK-065/066 provide a shared Web/Desktop Workbench and a private Desktop Host transport; the Desktop Workbench still cannot inspect or operate either control plane. Duplicating scope checks and lifecycle semantics in the Web routes and Desktop dispatcher would make transport behavior drift likely.

## Current state

- The private `@tracegraph/sdk/protocol` v1 carries Run commands and Run/Session queries only.
- Web Memory REST routes call Runtime Memory methods directly; the SDK and shared Memory panel implement list/create/review/correct/revoke/delete.
- Runtime exposes Experience list/create/review, with owner and project scope enforced in Core. There are no Experience Host routes, SDK methods, or shared UI.
- Desktop's framed dispatcher and fixed IPC expose Run/Session only. The shared Workbench already hosts the Memory panel.

## Proposal

Add canonical request/response schemas for Experience list and lifecycle review, and extend the private client protocol with Memory/Experience control queries and commands. Bump the private protocol version so a Host that cannot dispatch these operations fails at startup rather than accepting a connection that later cannot honor the UI contract.

Add a transport-neutral Memory/Experience controller to `@tracegraph/api`. It receives the Runtime port and resolves the currently visible project IDs for each request. Both Web routes and Desktop framed RPC use the same controller methods, schema parsing, scope, and Runtime command IDs. The Web SDK validates the same protocol command/query envelopes before mapping them to HTTP endpoints; Desktop Main maps fixed, validated IPC calls to those envelopes and the private RPC client. Renderer never supplies owner or actor identity.

Extend the shared Workbench Memory control surface with Experience inspection and lifecycle review. Experience actions are candidate validate/reject, validated dispute/retire, and disputed resolve/retire, all using the displayed lifecycle sequence as CAS input. Experience seed payloads remain immutable; this task adds no Experience edit or delete operation. Memory retains its existing review/correct/revoke/delete controls and limitations.

## Invariants and boundaries

- Memory and Experience commands keep their existing Core services as the sole writers of canonical ledger events.
- Web and Desktop pass the same strict command payload and stable command ID to the same Runtime service; neither transport invents a second event format.
- Every request derives allowed project scope from current Host registrations. Client-supplied owner/actor values are ignored or rejected by strict schemas.
- Experience lifecycle transitions remain append-only, idempotent, sequence-checked, and limited to the existing contract transitions.
- Experience deletion is unsupported because the domain has no delete command. Memory deletion remains limited to the existing local V2 payload/lineage behavior and retains its documented audit/V1/backup limitations.
- V1 G-21 recall and its Context behavior remain unchanged; neither control surface enables Memory or Experience recall.
- The protocol stays private and versioned; no external SDK publication is implied.

## Migration and rollback

This protocol is private to exact-version local clients. The protocol-version bump deliberately rejects an older Desktop Host/client pair. No persisted record format changes. Rollback removes the new UI/routes/IPC operations and restores the previous private protocol version; existing Memory and Experience ledger records remain readable by their existing Core services.

## Acceptance criteria

- [x] Protocol schemas and fixtures cover Memory list/create/review/correct/revoke/delete and Experience list/review, including strict invalid-action and unknown-operation rejection.
- [x] Web REST and Desktop RPC delegate to the same API controller and preserve command IDs, CAS sequence, scope checks, idempotent replay, and canonical event behavior.
- [x] Both transport paths preserve the same command payload into the shared controller; Core lifecycle tests cover canonical event replay/idempotency, while unauthorized and stale-sequence cases fail closed.
- [x] Shared Workbench renders the same Memory and Experience controls in Web and Desktop; Experience evidence, status, lifecycle sequence, and supported transitions are visible.
- [x] Fixed Desktop IPC and preload expose only schema-validated control operations; owner/actor and filesystem authority do not cross into Renderer.
- [x] Current module, SDK/Host/Desktop docs, V2 roadmap, paired Notes, package policy, and module graph match verified behavior.

## Risks and open questions

- Experience cases can contain rich evidence-derived text. The shared UI should display only the existing validated projection and source references, and must not silently turn a candidate into a recall-eligible case.
- A future Experience correction or deletion policy needs a separate domain decision and lifecycle/event semantics before adding controls.

## Evidence

Implementation sources: `packages/contracts/src/memory-experience-control.ts`, `packages/api/src/memory-experience-controller.ts`, `packages/host/src/webserver/index.ts`, `apps/desktop-host/src/desktop-host.ts`, `apps/desktop/src/bridge-contract.ts`, `apps/desktop/src/main.ts`, and `packages/workbench/src/components/ExperienceControlSection.tsx`.

Verification (2026-10-02): contract tests 177; API 8; SDK 61; Host 56; Workbench 150; Desktop Host unit 7 + real child-process E2E 4; Desktop 9; Web 1; focused Core Memory/Experience lifecycle 8. `pnpm typecheck` passed (build, workspace typechecks, eval typecheck). `pnpm test:engineering` passed (48 Node checks + 8 coverage checks). Boundary, invariant, module graph, V2 docs, package README, and `git diff --check` gates passed; the module graph was regenerated before checking.
