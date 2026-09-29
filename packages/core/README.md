# @tracegraph/core

TraceGraph's local Agent Runtime and durable execution kernel. Current Runtime behavior is described in [module 02](../../docs/modules/02-Agent-Runtime.md).

## Purpose

Run Agents over canonical execution facts: coordinate turn processing, assemble Context, enforce policy and approval, commit actions, manage Sessions, and derive projections.

## Public API

The package root exports Runtime creation and interfaces plus constructor-compatible Evidence and Session façades, recovery, context, policy, memory, sandbox, tool, and provider contracts from `src/index.ts`. Ledger, Artifact, Projection, and Replay implementations live in `@tracegraph/evidence`; Core binds its canonical crypto/redaction and Team/Todo projectors through `src/domains/evidence/runtime-service.ts`. Session's JSONL format, persistence, and query implementation lives in `@tracegraph/session`; the local adapter keeps Core's existing constructors and injects canonical title redaction. `DurableSessionController` stays here because it coordinates `AgentRuntime`. Core primitives and shared types live in `src/kernel/`; sandbox, LSP, and MCP adapters live in `src/seams/`. The package-root export names remain the consumer-facing contract.

## Dependencies

It depends on `@tracegraph/contracts`, `@tracegraph/evidence`, `@tracegraph/session`, `@tracegraph/telemetry`, and Zod. Host transport, browser UI, and CLI composition are outside this package.

## State ownership

Evidence owns canonical Run Event Ledger writes, scoped Artifact persistence, and pure Projection/Replay. Session owns its durable JSONL index, format migration, file safety, and query store; Core retains Session-to-Run lifecycle orchestration. Core also owns Runtime authority and the lifecycle/composition for data-directory stores such as Action WAL, recovery, and Memory records. Retrieval indexes and Telemetry delivery state are separate projections, not replacements for the Ledger.

## Extension points

`AgentRuntimeOptions` injects the model, tool registry, workspace, retriever, Telemetry sink, CodeGraph, and other bounded providers. `packages/core/src/domains/runtime/runtime.ts` owns public Run commands, recovery, Ledger, approval, control-lock, and workspace authority. `agent-loop.ts` coordinates each model turn through a typed port to those Runtime services.

## Model effect

`AgentLoopCoordinator` assembles model Context, sends requests through the injected adapter, validates Decisions, and coordinates Tool batches. It receives persistence, failure, approval, scheduling, and surface updates through Runtime-bound ports; it does not own Ledger writes, approval authority, or workspace mutation. Decisions can change workspace state only through Runtime's bounded action path and its required checks.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/core test:unit` from the repository root. End-to-end composition coverage also lives in `@tracegraph/test-support` and the CLI.

## Known limitations

Runtime execution and its in-memory coordination are local to one Host process. Provider behavior depends on the injected implementation; Telemetry is best-effort and does not replace durable Ledger facts.
