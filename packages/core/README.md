# @tracegraph/core

TraceGraph's local Agent Runtime and durable execution kernel. Current Runtime behavior is described in [module 02](../../docs/modules/02-Agent-Runtime.md).

## Purpose

Run Agents over canonical execution facts: coordinate turn processing, assemble Context, enforce policy and approval, commit actions, manage Sessions, and derive projections.

## Public API

The package root exports Runtime creation and interfaces plus constructor-compatible Evidence and Session façades, recovery, context, policy, memory, sandbox, tool, and provider contracts from `src/index.ts`. Memory's opt-in `migrateMemoryJsonlAdjacent()` writes a review-gated V2 sidecar and leaves the current V1 canonical store untouched. `MemoryLifecycleService` records V2 status transitions through owner-scoped Evidence Ledger streams. MEM-042 adds `replayMemoryUseStatus()` for Run-scoped `memory.use_status` events. MEM-045 adds deterministic V2 conflict detection/recall eligibility plus exact-version feedback and replay. MEM-046 adds `MemoryControlService` and a local V2 immutable candidate seed store for inspect/review/correct/revoke/delete, without changing V1 automatic recall or its canonical store. MEM-047 exposes `buildLegacyCapsule()`, `verifyLegacyCapsule()`, `previewLegacyCapsuleImport()`, and `acceptLegacyCapsuleImport()` for a fixed bounded file map. Imported Memory is local, external, untrusted, candidate-only, and cannot inherit consent/model-use/export policy; Experience import returns candidate-only external evidence and is not persisted. Ledger, Artifact, Projection, and Replay implementations live in `@tracegraph/evidence`; Core binds its canonical crypto/redaction and Team/Todo projectors through `src/domains/evidence/runtime-service.ts`. Session's JSONL format, persistence, and query implementation lives in `@tracegraph/session`; the local adapter keeps Core's existing constructors and injects canonical title redaction. `DurableSessionController` stays here because it coordinates `AgentRuntime`. Core primitives and shared types live in `src/kernel/`; sandbox, LSP, and MCP adapters live in `src/seams/`. The package-root export names remain the consumer-facing contract.

## Dependencies

It depends on `@tracegraph/contracts`, `@tracegraph/evidence`, `@tracegraph/session`, `@tracegraph/telemetry`, Zod, and YAML for bounded Capsule manifest/consent parsing. Host transport, browser UI, CLI composition, and filesystem/ZIP Capsule transport are outside this package.

## State ownership

Evidence owns canonical Run Event Ledger writes, owner-scoped Memory lifecycle, control and versioned feedback streams, scoped Artifact persistence, and pure Projection/Replay. Session owns its durable JSONL index, format migration, file safety, and query store; Core retains Session-to-Run lifecycle orchestration. Core also owns Runtime authority and the lifecycle/composition for data-directory stores such as Action WAL, recovery, and V1/V2 Memory records. The V2 migration sidecar is an explicit review artifact; V2 lifecycle/control/feedback facts are stored in separate aggregate namespaces within the Evidence Ledger, while MemoryUse status events remain in the corresponding Run stream. None changes the current V1 Runtime store. Retrieval indexes and Telemetry delivery state remain projections, not replacements for their respective canonical facts.

## Extension points

`AgentRuntimeOptions` injects the model, tool registry, workspace, retriever, Telemetry sink, CodeGraph, and other bounded providers. `packages/core/src/domains/runtime/runtime.ts` owns public Run commands, recovery, Ledger, approval, control-lock, and workspace authority. `agent-loop.ts` coordinates each model turn through a typed port to those Runtime services.

## Model effect

`AgentLoopCoordinator` assembles model Context, sends requests through the injected adapter, validates Decisions, and coordinates Tool batches. It receives persistence, failure, approval, scheduling, and surface updates through Runtime-bound ports; it does not own Ledger writes, approval authority, or workspace mutation. Decisions can change workspace state only through Runtime's bounded action path and its required checks.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/core test:unit` from the repository root. End-to-end composition coverage also lives in `@tracegraph/test-support` and the CLI.

## Known limitations

Runtime execution and its in-memory coordination are local to one Host process. V2 Memory control queueing is also single-instance; multiple Hosts sharing a dataDir are unsupported. V2 deletion rewrites only the local V2 payload store and does not erase V1 records, audit history, external Artifacts, backups, or filesystem snapshots. Provider behavior depends on the injected implementation; Telemetry is best-effort and does not replace durable Ledger facts.

Legacy Capsule v1 provides a deterministic UTF-8 file map, not filesystem/ZIP import/export or a UI. SHA-256 checksums detect inconsistent bytes but do not authenticate a sender. Raw evidence/Artifacts, encryption/signatures, Experience persistence/review, and remote-copy deletion remain unsupported.
