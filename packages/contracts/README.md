# @tracegraph/contracts

Shared runtime schemas and TypeScript wire/domain types for TraceGraph. See [module 01](../../docs/modules/01-契约层-contracts.md) for version and compatibility details.

## Purpose

Define the common contracts used by Runtime, Host, SDK, Web, and provider seams: commands, actions, events, projections, context, Sessions, tools, and related payloads.

## Public API

The package root re-exports the schema/type modules from `src/index.ts`, including strict Zod validators and version identifiers. Memory exposes the compatible G-21 `MemoryRecordV1Schema`/`MemoryRecordSchema`, independent `MemoryRecordV2Schema`, exact record-version/evidence references, Run-scoped `MemoryUseEventDataSchema`, MEM-045 feedback/conflict/recall-gate contracts, and MEM-046 control requests, content-free control events, list projections, and delete responses. MEM-047 adds strict Legacy Capsule v1 manifest, payload, quarantine, and explicit-accept contracts, plus the content-free imported-candidate control event shape. New Context manifests can bind their rendered input digest to the token estimate. The manifest exposes only the `@tracegraph/contracts` root entry.

## Dependencies

The only runtime dependency is Zod. This package does not depend on other TraceGraph workspace packages.

## State ownership

Contracts are stateless definitions and validators. They do not persist events or own Runtime state; the owning Runtime and storage implementations decide when validated facts are committed.

## Extension points

New wire or durable shapes are added through the owning schema module and root export. Event/projection compatibility changes must follow the versioning and append-only rules documented in module 01.

## Model effect

Schemas validate model-facing context, model decisions, tool calls, and usage facts where those contracts are used. They constrain accepted data but do not invoke a model or decide its answer.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/contracts test:unit` from the repository root.

## Known limitations

Most `SessionEvent.data` payloads retain a general record shape. `memory.use_status` is an explicit exception: its event schema validates the strict MemoryUse stage payload, and producer/replay boundaries also validate transitions. MEM-045 feedback and MEM-046 lifecycle/control use separate content-free owner/Memory aggregate contracts. MEM-047 Capsule checksums and schemas establish byte/shape consistency only; they do not authenticate the source or make imported content trusted. These schemas do not provide identity authentication or automatically integrate a V2 recall policy; Host/Runtime composition owns caller authorization. A TypeScript type alone is not evidence that a business action succeeded.
