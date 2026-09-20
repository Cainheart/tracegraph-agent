import type { TelemetrySink } from "../sink.js";
import type { TelemetryEvent } from "../types.js";
import { parseTelemetryEvent } from "../validation.js";

export class NoopTelemetrySink implements TelemetrySink {
  readonly kind = "noop" as const;

  emit(event: TelemetryEvent): void {
    // Keep noop contract-compatible: invalid or unbounded events fail in the
    // direct sink just as they do in stateful/exporting implementations.
    parseTelemetryEvent(event);
  }

  async flush(): Promise<void> {
    // Intentionally empty. No network or filesystem side effect is possible.
  }
}
