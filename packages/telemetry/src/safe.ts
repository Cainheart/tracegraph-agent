import type { TelemetryEmitter, TelemetrySink } from "./sink.js";
import {
  TELEMETRY_STATUS_SCHEMA_VERSION,
  type TelemetryEvent,
  type TelemetrySinkKind,
  type TelemetryStatus,
} from "./types.js";
import { parseTelemetryEvent } from "./validation.js";

export interface SafeTelemetryOptions {
  readonly now?: () => Date;
}

export class SafeTelemetry implements TelemetryEmitter {
  readonly #sink: TelemetrySink;
  readonly #sinkKind: TelemetrySinkKind;
  readonly #now: () => Date;
  #sinkErrors = 0;
  #unreportedSinkErrors = 0;
  #lastErrorAt: string | undefined;
  #lastRunId = "telemetry";
  #flushPromise: Promise<void> | undefined;
  #pendingFlush: DeferredFlush | undefined;

  constructor(sink: TelemetrySink, options: SafeTelemetryOptions = {}) {
    this.#sink = sink;
    let suppliedKind: unknown;
    try {
      suppliedKind = sink.kind;
    } catch {
      suppliedKind = undefined;
    }
    this.#sinkKind = suppliedKind === "noop"
      || suppliedKind === "memory"
      || suppliedKind === "otlp_http"
      || suppliedKind === "custom"
      ? suppliedKind
      : "custom";
    this.#now = options.now ?? (() => new Date());
  }

  get sinkKind(): TelemetrySinkKind {
    // Composite sinks (notably the G17 extension fan-out) can change their
    // active children while the Runtime is idle. Re-read the bounded public
    // kind so the process-local status does not remain stuck on its startup
    // value; a hostile/throwing getter still falls back to the safe initial
    // classification captured by the constructor.
    try {
      const current = this.#sink.kind;
      return current === "noop"
        || current === "memory"
        || current === "otlp_http"
        || current === "custom"
        ? current
        : "custom";
    } catch {
      return this.#sinkKind;
    }
  }

  get sinkErrors(): number {
    return this.#sinkErrors;
  }

  get lastErrorAt(): string | undefined {
    return this.#lastErrorAt;
  }

  status(): TelemetryStatus {
    return Object.freeze({
      schema_version: TELEMETRY_STATUS_SCHEMA_VERSION,
      sink: this.sinkKind,
      state: this.sinkKind === "noop"
        ? "disabled"
        : this.#sinkErrors === 0
          ? "active"
          : "degraded",
      error_count: this.#sinkErrors,
      ...(this.#lastErrorAt === undefined ? {} : { last_error_at: this.#lastErrorAt }),
    });
  }

  emit(event: TelemetryEvent): void {
    try {
      const normalized = parseTelemetryEvent(event);
      this.#lastRunId = normalized.run_id;
      this.#sink.emit(normalized);
    } catch {
      this.#recordSinkError();
    }
  }

  flush(): Promise<void> {
    if (this.#flushPromise !== undefined) {
      // Coalesce an arbitrary flush storm into one bounded follow-up barrier.
      // That follow-up still closes the same-tick emit-after-flush window.
      this.#pendingFlush ??= createDeferredFlush();
      return this.#pendingFlush.promise;
    }
    return this.#startFlush();
  }

  #startFlush(): Promise<void> {
    // Publish the active barrier before user-supplied sink code can run. A
    // sink may synchronously call back into flush(); that reentrant call must
    // join the bounded follow-up rather than start a concurrent drain.
    const operation = Promise.resolve().then(() => this.#flushOnce());
    this.#flushPromise = operation;
    void operation.finally(() => {
      if (this.#flushPromise !== operation) return;
      this.#flushPromise = undefined;
      const pending = this.#pendingFlush;
      this.#pendingFlush = undefined;
      if (pending !== undefined) {
        void this.#startFlush().then(pending.resolve, pending.reject);
      }
    }).catch(() => undefined);
    return operation;
  }

  async #flushOnce(): Promise<void> {
    if (this.#unreportedSinkErrors > 0) {
      const pending = this.#unreportedSinkErrors;
      try {
        this.#sink.emit(parseTelemetryEvent({
          kind: "metric",
          name: "telemetry.sink_errors",
          at: this.#nowIso(),
          run_id: this.#lastRunId,
          attributes: { sink: this.sinkKind },
          value: pending,
          unit: "errors",
        }));
        this.#unreportedSinkErrors = 0;
      } catch {
        this.#recordSinkError();
      }
    }
    try {
      await this.#sink.flush();
    } catch {
      this.#recordSinkError();
    }
  }

  #recordSinkError(): void {
    this.#sinkErrors = Math.min(Number.MAX_SAFE_INTEGER, this.#sinkErrors + 1);
    this.#unreportedSinkErrors = Math.min(Number.MAX_SAFE_INTEGER, this.#unreportedSinkErrors + 1);
    this.#lastErrorAt = this.#nowIso();
  }

  #nowIso(): string {
    try {
      const value = this.#now();
      if (!Number.isFinite(value.getTime())) return "1970-01-01T00:00:00.000Z";
      return value.toISOString();
    } catch {
      return "1970-01-01T00:00:00.000Z";
    }
  }
}

interface DeferredFlush {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferredFlush(): DeferredFlush {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
