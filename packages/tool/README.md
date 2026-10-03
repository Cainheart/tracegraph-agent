# `@tracegraph/tool`

## Purpose

Generic Tool contracts and the bounded execution, registry, policy, and one-shot approval mechanisms that enforce Tool calls before side effects.

## Public API

[`src/index.ts`](src/index.ts) is the only package entrypoint. Core owns built-in Tool implementations and adapts them to these contracts through its public dependency on this package.

## Dependencies

Runtime dependencies are `@tracegraph/contracts`, `zod`, and Node platform APIs. This package does not import Core, Host, applications, Workspace providers, or built-in Tool implementations.

## State ownership

The package owns immutable Tool definitions, process-local Registry slots, bounded result validation, policy evaluation primitives, and ephemeral one-shot approval-token mechanics. Core retains Run policy snapshots, Workspace/Sandbox authority, Action WAL, Receipt/Observation, and Event Ledger ownership.

## Extension points

Core supplies Tool definitions and execution-context bridges. Runtime passes the canonical `operationId` from the durable `tool.started` event so external Tool implementations can correlate provider state for later reconciliation. Scope provider idempotency keys with `projectId` and `runId`; operation IDs are Run-scoped. Callers can inject clocks and ID factories for deterministic policy/approval behavior. Tool Registry registration remains reversible and schema projection remains explicitly model-bounded.

## Model effect

Only the explicit `modelSchemas()` projection reaches model requests. Executors, output schemas, policy state, approval claims, and Host-only scheduling fields remain outside model-visible schemas.

## Verification

Run `pnpm --filter @tracegraph/tool build`, `pnpm --filter @tracegraph/tool typecheck`, and `pnpm --filter @tracegraph/tool test:unit`. Core composition and final-denial ordering are verified by Core Runtime tests.

## Known limitations

Core-specific built-in Tool implementations, ExtensionManager lifecycle, Runtime orchestration, Action WAL, Receipt/Observation mapping, and provider authority remain in Core. This package is an in-process enforcement boundary, not an OS sandbox.
