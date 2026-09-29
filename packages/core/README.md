# @tracegraph/core

TraceGraph's local Agent Runtime and durable execution kernel. Current Runtime behavior is described in [module 02](../../docs/modules/02-Agent-Runtime.md).

## Purpose

Run model/tool turns, build context, enforce policy and approval, commit actions, manage Sessions, and derive projections from canonical execution facts.

## Public API

The package root exports Runtime creation and interfaces plus Ledger, Session, Artifact, recovery, context, policy, memory, sandbox, tool, and provider contracts from `src/index.ts`. Core primitives and shared types live in `src/kernel/`; sandbox, LSP, and MCP adapters live in `src/seams/`. The package-root export names remain the consumer-facing contract.

## Dependencies

It depends on `@tracegraph/contracts`, `@tracegraph/telemetry`, and Zod. Host transport, browser UI, and CLI composition are outside this package.

## State ownership

Core owns canonical Run Event Ledger writes and the Runtime-side lifecycle for data-directory stores such as artifacts, action WAL, recovery, and Memory records. Retrieval indexes and Telemetry delivery state are separate projections, not replacements for the Ledger.

## Extension points

`AgentRuntimeOptions` injects the model, tool registry, workspace, retriever, Telemetry sink, CodeGraph, and other bounded providers. `packages/core/src/domains/runtime/runtime.ts` coordinates these seams.

## Model effect

Core directly assembles model context, sends requests through the injected model adapter, consumes decisions, and applies tool and approval policy. Those decisions can change workspace state only through the bounded action path and its required checks.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/core test:unit` from the repository root. End-to-end composition coverage also lives in `@tracegraph/test-support` and the CLI.

## Known limitations

Runtime execution and its in-memory coordination are local to one Host process. Provider behavior depends on the injected implementation; Telemetry is best-effort and does not replace durable Ledger facts.
