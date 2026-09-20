import {
  DecisionSchema,
  ModelUsageReportSchema,
  type Decision,
  type ModelUsageReport,
} from "@tracegraph/contracts";
import {
  ModelRequestError,
  type ContextSummaryInput,
  type ModelAdapter,
  type ModelInput,
  type PublicModelRequestMetadata,
} from "@tracegraph/core";

export const MAX_MOCK_PROVIDER_STEPS = 64;
export const MAX_MOCK_PROVIDER_RESPONSE_BYTES = 64 * 1024;
export const MAX_MOCK_PROVIDER_SCRIPT_BYTES = 512 * 1024;
export const MAX_MOCK_PROVIDER_TIMEOUT_MS = 30_000;

export interface MockProviderResponseStep {
  readonly kind: "response";
  readonly value: unknown;
  readonly usage?: ModelUsageReport;
}

export interface MockProviderInvalidOutputStep {
  readonly kind: "invalid_output";
  readonly value: unknown;
  readonly usage?: ModelUsageReport;
}

export interface MockProviderTimeoutStep {
  readonly kind: "timeout";
  /** The simulated provider deadline. It is always finite and hard-bounded. */
  readonly timeoutMs: number;
}

export type MockProviderStep =
  | MockProviderResponseStep
  | MockProviderInvalidOutputStep
  | MockProviderTimeoutStep;

export interface ScriptedMockProviderOptions {
  readonly decisions: readonly MockProviderStep[];
  readonly summaries?: readonly MockProviderStep[];
  readonly provider?: string;
  readonly model?: string;
  readonly name?: string;
}

export interface MockProviderCall {
  readonly channel: "decision" | "summary";
  readonly ordinal: number;
  readonly step_kind: MockProviderStep["kind"];
  readonly run_id: string;
}

interface NormalizedOutputStep {
  readonly kind: "response" | "invalid_output";
  readonly serializedValue: string;
  readonly usage?: ModelUsageReport;
}

type NormalizedStep = NormalizedOutputStep | MockProviderTimeoutStep;

/**
 * A deterministic, zero-network provider for executable evaluations.
 *
 * Scripts are copied and size-checked at construction. Each request consumes
 * exactly one step; exhaustion fails closed instead of reusing the last
 * response. Timeout steps are finite and honour AbortSignal cancellation.
 */
export class ScriptedMockProvider implements ModelAdapter {
  readonly name: string;
  readonly #provider: string;
  readonly #model: string;
  readonly #decisions: readonly NormalizedStep[];
  readonly #summaries: readonly NormalizedStep[];
  readonly #calls: MockProviderCall[] = [];
  #decisionCursor = 0;
  #summaryCursor = 0;

  constructor(options: ScriptedMockProviderOptions) {
    this.name = boundedIdentity(options.name ?? "scripted-mock-provider", "name");
    this.#provider = boundedIdentity(options.provider ?? "tracegraph-mock", "provider");
    this.#model = boundedIdentity(options.model ?? "scripted-v1", "model");
    this.#decisions = normalizeScript(options.decisions, "decisions", this.#provider, this.#model);
    this.#summaries = normalizeScript(options.summaries ?? [], "summaries", this.#provider, this.#model);
    const totalBytes = [...this.#decisions, ...this.#summaries].reduce(
      (total, step) => total + (step.kind === "timeout" ? 0 : byteLength(step.serializedValue)),
      0,
    );
    if (totalBytes > MAX_MOCK_PROVIDER_SCRIPT_BYTES) {
      throw new RangeError(`Mock provider script exceeds ${MAX_MOCK_PROVIDER_SCRIPT_BYTES} bytes`);
    }
  }

  usageIdentity(): { provider: string; model: string } {
    return { provider: this.#provider, model: this.#model };
  }

  publicRequestMetadata(input: ModelInput): PublicModelRequestMetadata {
    return {
      adapter: this.name,
      provider: this.#provider,
      model: this.#model,
      requested_reasoning_effort: input.reasoningEffort,
      reasoning_configuration: "unsupported",
    };
  }

  async decide(input: ModelInput): Promise<unknown> {
    const ordinal = this.#decisionCursor;
    const step = this.#decisions[ordinal];
    if (step === undefined) {
      throw new ModelRequestError("mock_script_exhausted", "Mock provider decision script is exhausted");
    }
    this.#decisionCursor += 1;
    this.#recordCall("decision", ordinal, step.kind, input.runId);
    return executeStep(step, input.signal, input.onUsage);
  }

  async summarizeContext(input: ContextSummaryInput): Promise<unknown> {
    const ordinal = this.#summaryCursor;
    const step = this.#summaries[ordinal];
    if (step === undefined) {
      throw new ModelRequestError("mock_script_exhausted", "Mock provider summary script is exhausted");
    }
    this.#summaryCursor += 1;
    this.#recordCall("summary", ordinal, step.kind, input.runId);
    return executeStep(step, input.signal, input.onUsage);
  }

  calls(): readonly MockProviderCall[] {
    return this.#calls.map((call) => ({ ...call }));
  }

  remaining(): { decisions: number; summaries: number } {
    return {
      decisions: this.#decisions.length - this.#decisionCursor,
      summaries: this.#summaries.length - this.#summaryCursor,
    };
  }

  #recordCall(
    channel: MockProviderCall["channel"],
    ordinal: number,
    stepKind: MockProviderStep["kind"],
    runId: string,
  ): void {
    // A call consumes one finite script step, so this log can never grow past
    // the constructor-enforced script bound.
    this.#calls.push({ channel, ordinal, step_kind: stepKind, run_id: runId });
  }
}

export function mockDecision(
  decision: Decision,
  usage?: ModelUsageReport,
): MockProviderResponseStep {
  return {
    kind: "response",
    value: DecisionSchema.parse(decision),
    ...(usage === undefined ? {} : { usage: ModelUsageReportSchema.parse(usage) }),
  };
}

export function mockInvalidOutput(
  value: unknown,
  usage?: ModelUsageReport,
): MockProviderInvalidOutputStep {
  return {
    kind: "invalid_output",
    value,
    ...(usage === undefined ? {} : { usage: ModelUsageReportSchema.parse(usage) }),
  };
}

export function mockTimeout(timeoutMs: number): MockProviderTimeoutStep {
  return { kind: "timeout", timeoutMs: boundedTimeout(timeoutMs) };
}

function normalizeScript(
  script: readonly MockProviderStep[],
  label: string,
  provider: string,
  model: string,
): readonly NormalizedStep[] {
  if (script.length > MAX_MOCK_PROVIDER_STEPS) {
    throw new RangeError(`${label} exceeds ${MAX_MOCK_PROVIDER_STEPS} steps`);
  }
  return script.map((step) => {
    if (step.kind === "timeout") {
      return { kind: "timeout", timeoutMs: boundedTimeout(step.timeoutMs) };
    }
    const serializedValue = boundedJson(step.value);
    const usage = step.usage === undefined
      ? undefined
      : ModelUsageReportSchema.parse(step.usage);
    if (usage !== undefined && (usage.provider !== provider || usage.model !== model)) {
      throw new TypeError("Mock provider usage identity must match the configured provider and model");
    }
    return {
      kind: step.kind,
      serializedValue,
      ...(usage === undefined ? {} : { usage }),
    };
  });
}

async function executeStep(
  step: NormalizedStep,
  signal: AbortSignal | undefined,
  onUsage: ((usage: ModelUsageReport) => void) | undefined,
): Promise<unknown> {
  if (signal?.aborted === true) {
    throw new ModelRequestError("mock_aborted", "Mock provider request was aborted");
  }
  if (step.kind === "timeout") {
    await waitForTimeout(step.timeoutMs, signal);
    throw new ModelRequestError("mock_timeout", "Mock provider request timed out");
  }
  if (step.usage !== undefined && onUsage !== undefined) {
    try {
      onUsage(ModelUsageReportSchema.parse(step.usage));
    } catch {
      // Usage accounting is deliberately best-effort, matching ModelAdapter's
      // production contract. It cannot invalidate an otherwise usable reply.
    }
  }
  return JSON.parse(step.serializedValue) as unknown;
}

function waitForTimeout(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ModelRequestError("mock_aborted", "Mock provider request was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MOCK_PROVIDER_TIMEOUT_MS) {
    throw new RangeError(`Mock provider timeout must be between 1 and ${MAX_MOCK_PROVIDER_TIMEOUT_MS} ms`);
  }
  return value;
}

function boundedJson(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Mock provider output must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new TypeError("Mock provider output must be JSON serializable");
  }
  if (byteLength(serialized) > MAX_MOCK_PROVIDER_RESPONSE_BYTES) {
    throw new RangeError(`Mock provider response exceeds ${MAX_MOCK_PROVIDER_RESPONSE_BYTES} bytes`);
  }
  return serialized;
}

function boundedIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`Mock provider ${label} must contain 1-100 safe characters`);
  }
  return normalized;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
