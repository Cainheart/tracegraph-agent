import { TelemetryError } from "../errors.js";
import type { TelemetrySink } from "../sink.js";
import type { TelemetryEvent, TelemetrySinkKind } from "../types.js";

export type TelemetrySinkFactory = () => TelemetrySink | Promise<TelemetrySink>;

export interface TelemetryConformanceReport {
  readonly sink: TelemetrySinkKind;
  readonly emitted: number;
  readonly invalid_event_rejected: true;
  readonly flush_idempotent: true;
}

export interface TelemetryConformanceOptions {
  /** Stable, secret-free snapshot of delivered output after each flush. */
  readonly deliverySnapshot: (sink: TelemetrySink) => string;
}

/** Framework-neutral conformance routine. Test suites can await this function;
 * it throws when a backend violates the common sink contract. */
export async function runTelemetryConformance(
  makeSink: TelemetrySinkFactory,
  options: TelemetryConformanceOptions,
): Promise<TelemetryConformanceReport> {
  const sink = await makeSink();
  const events = conformanceEvents();
  for (const event of events) sink.emit(event);
  await sink.flush();
  const firstDelivery = options.deliverySnapshot(sink);
  await sink.flush();
  const secondDelivery = options.deliverySnapshot(sink);
  if (firstDelivery !== secondDelivery) {
    throw new Error("Telemetry sink repeated delivery during an idempotent flush");
  }

  const sentinel = "conformance-secret-must-not-leak";
  let failure: unknown;
  try {
    sink.emit({
      kind: "log",
      name: "invalid",
      at: "not-a-timestamp",
      run_id: "run:conformance",
      attributes: { authorization: sentinel },
      severity: "info",
      body: sentinel,
    });
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof TelemetryError) || failure.code !== "invalid_event") {
    throw new Error("Telemetry sink did not reject an invalid event consistently");
  }
  if (String(failure).includes(sentinel)) {
    throw new Error("Telemetry sink exposed invalid event content in an error");
  }
  return Object.freeze({
    sink: sink.kind,
    emitted: events.length,
    invalid_event_rejected: true,
    flush_idempotent: true,
  });
}

export function conformanceEvents(): readonly TelemetryEvent[] {
  return Object.freeze([
    {
      kind: "span",
      name: "model_call",
      at: "2026-09-19T00:00:00.000Z",
      run_id: "run:conformance",
      attributes: { model: "test", fallback_retry: false },
      duration_ms: 12.5,
      status: "ok",
    },
    {
      kind: "metric",
      name: "model.tokens",
      at: "2026-09-19T00:00:00.100Z",
      run_id: "run:conformance",
      attributes: { direction: "input" },
      value: 42,
      unit: "tokens",
    },
    {
      kind: "log",
      name: "run.lifecycle",
      at: "2026-09-19T00:00:00.200Z",
      run_id: "run:conformance",
      attributes: { phase: "completed" },
      severity: "info",
      body: "Run completed",
    },
  ] satisfies readonly TelemetryEvent[]);
}
