# @tracegraph/telemetry

Best-effort observability sinks and bounded signal helpers. Runtime integration and delivery limits are documented in [module 02](../../docs/modules/02-Agent-Runtime.md) and [module 05](../../docs/modules/05-证据链-账本投影工件.md).

## Purpose

Project selected committed execution facts into no-op, in-memory, or OTLP-HTTP spans, metrics, and logs without becoming a second business-event store.

## Public API

The package root exports sink interfaces and implementations, configuration/validation, signal types, and safe wrappers. The declared `./testing` export contains sink conformance helpers.

## Dependencies

It has no TraceGraph workspace dependency. OTLP transport uses the platform fetch API; schemas and types are defined locally in this package.

## State ownership

Sink health, error counts, and retryable OTLP queue entries are process-local. This state is not canonical and is not used to recover Runs; the Event Ledger remains the source of truth.

## Extension points

Implement `TelemetrySink` for another destination and preserve the bounded signal and safe-emission contract. `./testing` exposes conformance helpers for sink implementations.

## Model effect

Telemetry does not alter prompts, model decisions, permissions, or Run state. It observes a bounded allowlist of already committed facts; signal delivery can fail independently of the Run.

## Verification

Run `pnpm run build && pnpm --filter @tracegraph/telemetry test:unit` from the repository root.

## Known limitations

Delivery is best-effort: queues and health counters are not durable, there is no automatic backoff or persistent retry, and this package does not provide the full OpenTelemetry SDK/processor/sampling/propagation stack.
