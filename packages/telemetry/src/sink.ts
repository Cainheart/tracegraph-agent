import type { TelemetryEvent, TelemetrySinkKind, TelemetryStatus } from "./types.js";

export interface TelemetrySink {
  readonly kind: TelemetrySinkKind;
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
}

/** Runtime-facing, failure-isolated telemetry surface. */
export interface TelemetryEmitter {
  readonly sinkKind: TelemetrySinkKind;
  readonly sinkErrors: number;
  readonly lastErrorAt: string | undefined;
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
  status(): TelemetryStatus;
}
