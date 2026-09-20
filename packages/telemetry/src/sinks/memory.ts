import { TelemetryError } from "../errors.js";
import type { TelemetrySink } from "../sink.js";
import type { TelemetryEvent } from "../types.js";
import { parseTelemetryEvent } from "../validation.js";

export const DEFAULT_MEMORY_TELEMETRY_EVENTS = 1_000;
export const MAX_MEMORY_TELEMETRY_EVENTS = 10_000;

export interface MemoryTelemetrySinkOptions {
  readonly maxEvents?: number;
}

export class MemoryTelemetrySink implements TelemetrySink {
  readonly kind = "memory" as const;
  readonly #maxEvents: number;
  readonly #events: TelemetryEvent[] = [];
  #droppedEvents = 0;

  constructor(options: MemoryTelemetrySinkOptions = {}) {
    this.#maxEvents = boundedInteger(
      options.maxEvents ?? DEFAULT_MEMORY_TELEMETRY_EVENTS,
      1,
      MAX_MEMORY_TELEMETRY_EVENTS,
    );
  }

  get size(): number {
    return this.#events.length;
  }

  get droppedEvents(): number {
    return this.#droppedEvents;
  }

  emit(event: TelemetryEvent): void {
    const normalized = parseTelemetryEvent(event);
    if (this.#events.length === this.#maxEvents) {
      this.#events.shift();
      this.#droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, this.#droppedEvents + 1);
    }
    this.#events.push(normalized);
  }

  snapshot(): readonly TelemetryEvent[] {
    return Object.freeze([...this.#events]);
  }

  clear(): void {
    this.#events.splice(0);
    this.#droppedEvents = 0;
  }

  async flush(): Promise<void> {
    // There is no downstream transport for this bounded test/debug sink.
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TelemetryError("invalid_config", "Telemetry sink configuration is invalid");
  }
  return value;
}
