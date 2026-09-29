# @tracegraph/contracts

Shared runtime schemas and TypeScript wire/domain types for TraceGraph. See [module 01](../../docs/modules/01-契约层-contracts.md) for version and compatibility details.

## Purpose

Define the common contracts used by Runtime, Host, SDK, Web, and provider seams: commands, actions, events, projections, context, Sessions, tools, and related payloads.

## Public API

The package root re-exports the schema/type modules from `src/index.ts`, including strict Zod validators and version identifiers. The manifest exposes only the `@tracegraph/contracts` root entry.

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

`SessionEvent.data` retains a general record shape, so the top-level Event union does not statically narrow every event payload by type. Strict validation is applied at specific producer/consumer boundaries; a TypeScript type alone is not evidence that a business action succeeded.
