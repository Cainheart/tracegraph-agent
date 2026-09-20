import {
  EXTENSION_API_VERSION,
  EventTypeSchema,
  ExtensionCommandInvocationSchema,
  ExtensionCommandResultSchema,
  ExtensionErrorDataSchema,
  ExtensionNameSchema,
  ExtensionRunSnapshotSchema,
  ExtensionStatusSchema,
  PolicyRuleSchema,
  type EventType,
  type ExtensionCommandInvocation,
  type ExtensionCommandResult,
  type ExtensionErrorData,
  type ExtensionRunSnapshot,
  type ExtensionStatus,
  type PolicyRule,
  type SessionEvent,
} from "@tracegraph/contracts";
import {
  NoopTelemetrySink,
  type TelemetryEvent,
  type TelemetrySink,
  type TelemetrySinkKind,
} from "@tracegraph/telemetry";
import { z } from "zod";
import { sha256, stableStringify } from "./crypto.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDefinition } from "./types.js";

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface ExtensionContextStrategyInput {
  readonly projectId: string;
  readonly runId: string;
  readonly task: string;
  readonly turn: number;
}

export interface ExtensionContextContribution {
  readonly summary: string;
  readonly facts?: Readonly<Record<string, unknown>>;
}

export interface ContextStrategy {
  readonly name: string;
  contribute(
    input: Readonly<ExtensionContextStrategyInput>,
  ): ExtensionContextContribution | undefined | Promise<ExtensionContextContribution | undefined>;
}

export type ExtensionCommandHandler = (
  invocation: Readonly<ExtensionCommandInvocation>,
) => unknown | Promise<unknown>;

export type ExtensionEventHandler = (
  event: Readonly<SessionEvent>,
) => void | Promise<void>;

export interface ExtensionContext {
  registerTool(definition: ToolDefinition): Disposable;
  registerTelemetrySink(sink: TelemetrySink): Disposable;
  registerContextStrategy(strategy: ContextStrategy): Disposable;
  registerPolicyRule(rule: PolicyRule): Disposable;
  registerCommand(name: string, handler: ExtensionCommandHandler): Disposable;
  on(type: EventType, handler: ExtensionEventHandler): Disposable;
}

export interface TraceGraphExtension {
  readonly name: string;
  readonly api_version: typeof EXTENSION_API_VERSION;
  activate(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

interface ExtensionCandidate extends Omit<TraceGraphExtension, "api_version"> {
  readonly api_version: string;
}

export interface ExtensionRuntimeError {
  readonly extensionName: string;
  readonly phase: ExtensionErrorData["phase"];
  readonly code: string;
  readonly message: string;
  readonly sourceEvent?: SessionEvent;
}

export interface ContextContributionResult {
  readonly extensionName: string;
  readonly strategyName: string;
  readonly contribution: ExtensionContextContribution;
}

export interface ExtensionRunLease {
  readonly snapshot: ExtensionRunSnapshot;
  release(): void;
}

export interface ExtensionManagerOptions {
  readonly toolRegistry?: ToolRegistry;
  readonly now?: () => Date;
  readonly hookTimeoutMs?: number;
  readonly contextTimeoutMs?: number;
  readonly lifecycleTimeoutMs?: number;
}

interface Registration {
  disposed: boolean;
  dispose(): Promise<void>;
}

interface ExtensionRecord {
  extension: ExtensionCandidate;
  state: ExtensionStatus["state"];
  registrations: Registration[];
  generation: number;
  updatedAt: string;
  error?: { code: string; message: string };
}

interface OwnedContextStrategy {
  owner: string;
  strategy: ContextStrategy;
}

interface OwnedCommand {
  owner: string;
  handler: ExtensionCommandHandler;
}

interface OwnedHook {
  owner: string;
  type: EventType;
  handler: ExtensionEventHandler;
}

interface OwnedTelemetrySink {
  owner: string;
  sink: TelemetrySink;
}

const ContextContributionSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  facts: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value.facts ?? {}), "utf8");
    if (bytes > 16 * 1024) {
      context.addIssue({ code: "custom", path: ["facts"], message: "context contribution exceeds 16 KiB" });
    }
  } catch {
    context.addIssue({ code: "custom", path: ["facts"], message: "context contribution must be JSON serializable" });
  }
});

/**
 * Small, trusted in-process extension kernel. It is a reversible composition
 * boundary, not a sandbox for hostile JavaScript modules.
 */
export class ExtensionManager {
  readonly toolRegistry: ToolRegistry;
  readonly #now: () => Date;
  readonly #hookTimeoutMs: number;
  readonly #contextTimeoutMs: number;
  readonly #lifecycleTimeoutMs: number;
  readonly #records = new Map<string, ExtensionRecord>();
  readonly #toolOwners = new Map<string, string>();
  readonly #telemetrySinks = new Map<symbol, OwnedTelemetrySink>();
  readonly #contextStrategies = new Map<string, OwnedContextStrategy>();
  readonly #policyRules = new Map<string, { owner: string; rule: PolicyRule }>();
  readonly #commands = new Map<string, OwnedCommand>();
  readonly #hooks = new Set<OwnedHook>();
  readonly #telemetryErrors: ExtensionRuntimeError[] = [];
  #generation = 0;
  #activeLeases = 0;
  #pendingMutations = 0;
  #mutating = false;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ExtensionManagerOptions = {}) {
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.#now = options.now ?? (() => new Date());
    this.#hookTimeoutMs = boundedTimeout(options.hookTimeoutMs ?? 1_000, "hookTimeoutMs");
    this.#contextTimeoutMs = boundedTimeout(options.contextTimeoutMs ?? 1_000, "contextTimeoutMs");
    this.#lifecycleTimeoutMs = boundedTimeout(options.lifecycleTimeoutMs ?? 5_000, "lifecycleTimeoutMs");
  }

  get activeLeaseCount(): number {
    return this.#activeLeases;
  }

  activate(extension: TraceGraphExtension): Promise<ExtensionStatus> {
    return this.#serialize(() => this.#activate(extension));
  }

  async activateAll(extensions: readonly TraceGraphExtension[]): Promise<readonly ExtensionStatus[]> {
    const statuses: ExtensionStatus[] = [];
    for (const extension of extensions) statuses.push(await this.activate(extension));
    return statuses;
  }

  deactivate(nameValue: string): Promise<ExtensionStatus> {
    return this.#serialize(async () => {
      this.#assertIdle("deactivate");
      return this.#deactivate(ExtensionNameSchema.parse(nameValue));
    });
  }

  /** Reload is atomic for registry state and deliberately refuses active Run leases. */
  reload(nameValue: string, replacement: TraceGraphExtension): Promise<ExtensionStatus> {
    return this.#serialize(async () => {
      this.#assertIdle("reload");
      const name = ExtensionNameSchema.parse(nameValue);
      const candidateName = ExtensionNameSchema.parse(replacement.name);
      if (candidateName !== name) {
        throw new ExtensionManagerError("extension_name_mismatch", "Replacement extension name does not match");
      }
      this.#validateCandidate(replacement);
      const previous = this.#records.get(name);
      if (previous === undefined || previous.state !== "active") {
        throw new ExtensionManagerError("extension_not_active", `Extension ${name} is not active`);
      }
      const previousExtension = previous.extension;
      await this.#deactivate(name);
      try {
        return await this.#activate(replacement);
      } catch (error) {
        // Restore the old registration set before exposing the reload failure.
        try {
          await this.#activate(previousExtension as TraceGraphExtension);
        } catch (rollbackError) {
          throw new ExtensionManagerError(
            "extension_reload_rollback_failed",
            `Extension reload and rollback failed: ${safeError(rollbackError)}`,
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  acquireRunLease(): ExtensionRunLease {
    if (this.#mutating) {
      throw new ExtensionManagerError(
        "extension_mutating",
        "Cannot start or restore a Run while the extension surface is changing",
      );
    }
    const snapshot = this.snapshot();
    this.#activeLeases += 1;
    let released = false;
    return Object.freeze({
      snapshot,
      release: () => {
        if (released) return;
        released = true;
        this.#activeLeases = Math.max(0, this.#activeLeases - 1);
      },
    });
  }

  snapshot(): ExtensionRunSnapshot {
    const activeExtensions = [...this.#records.values()]
      .filter((record) => record.state === "active")
      .map((record) => record.extension.name)
      .sort();
    const activeToolNames = this.toolRegistry.descriptors().map(({ name }) => name).sort();
    const digestInput = {
      api_version: EXTENSION_API_VERSION,
      generation: this.#generation,
      active_extensions: activeExtensions,
      active_tool_names: activeToolNames,
      context_strategies: [...this.#contextStrategies.keys()].sort(),
      policy_rules: [...this.#policyRules.values()].map(({ rule }) => rule).sort(compareRules),
      commands: [...this.#commands.keys()].sort(),
      hooks: [...this.#hooks].map(({ owner, type }) => `${owner}:${type}`).sort(),
      telemetry_sinks: [...this.#telemetrySinks.values()].map(({ owner }) => owner).sort(),
    };
    return ExtensionRunSnapshotSchema.parse({
      api_version: EXTENSION_API_VERSION,
      config_digest: sha256(stableStringify(digestInput)),
      generation: this.#generation,
      active_extensions: activeExtensions,
      active_tool_names: activeToolNames,
    });
  }

  listStatuses(): readonly ExtensionStatus[] {
    return [...this.#records.values()]
      .map((record) => this.#status(record))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  policyRules(): readonly PolicyRule[] {
    return [...this.#policyRules.values()]
      .map(({ rule }) => PolicyRuleSchema.parse(structuredClone(rule)))
      .sort(compareRules);
  }

  async invokeCommand(inputValue: ExtensionCommandInvocation): Promise<ExtensionCommandResult> {
    const input = ExtensionCommandInvocationSchema.parse(inputValue);
    const command = this.#commands.get(input.name);
    if (command === undefined) {
      return ExtensionCommandResultSchema.parse({
        command_id: input.command_id,
        name: input.name,
        status: "failure",
        summary: `Extension command ${input.name} is not registered`,
      });
    }
    try {
      const output = await withTimeout(
        Promise.resolve(command.handler(deepFreezeClone(input))),
        this.#lifecycleTimeoutMs,
        "extension_command_timeout",
      );
      return ExtensionCommandResultSchema.parse(output);
    } catch (error) {
      return ExtensionCommandResultSchema.parse({
        command_id: input.command_id,
        name: input.name,
        status: "failure",
        summary: safeError(error),
      });
    }
  }

  async dispatchEvent(event: SessionEvent): Promise<readonly ExtensionRuntimeError[]> {
    if (event.type === "extension.error") return [];
    const frozen = deepFreezeClone(event);
    const errors: ExtensionRuntimeError[] = [];
    for (const hook of [...this.#hooks].filter((candidate) => candidate.type === event.type)) {
      try {
        await withTimeout(
          Promise.resolve(hook.handler(frozen)),
          this.#hookTimeoutMs,
          "extension_hook_timeout",
        );
      } catch (error) {
        errors.push(runtimeError(hook.owner, "event_hook", error, event));
      }
    }
    return errors;
  }

  async collectContextContributions(
    input: ExtensionContextStrategyInput,
  ): Promise<{ contributions: readonly ContextContributionResult[]; errors: readonly ExtensionRuntimeError[] }> {
    const frozen = deepFreezeClone(input);
    const contributions: ContextContributionResult[] = [];
    const errors: ExtensionRuntimeError[] = [];
    for (const [strategyName, owned] of [...this.#contextStrategies]) {
      try {
        const raw = await withTimeout(
          Promise.resolve(owned.strategy.contribute(frozen)),
          this.#contextTimeoutMs,
          "extension_context_timeout",
        );
        if (raw === undefined) continue;
        contributions.push({
          extensionName: owned.owner,
          strategyName,
          contribution: (() => {
            const parsed = ContextContributionSchema.parse(raw);
            return {
              summary: parsed.summary,
              ...(parsed.facts === undefined ? {} : { facts: parsed.facts }),
            };
          })(),
        });
      } catch (error) {
        errors.push(runtimeError(owned.owner, "context_strategy", error));
      }
    }
    return { contributions, errors };
  }

  telemetrySink(base: TelemetrySink = new NoopTelemetrySink()): TelemetrySink {
    const manager = this;
    return {
      get kind(): TelemetrySinkKind {
        return manager.#telemetrySinks.size === 0 ? base.kind : "custom";
      },
      emit(event: TelemetryEvent): void {
        base.emit(event);
        // extension.error is the durable isolation boundary. Feeding telemetry
        // derived from that Event back into extension-owned sinks would let a
        // broken sink manufacture an unbounded error chain on later Events.
        if (event.attributes.event_type === "extension.error") return;
        for (const owned of [...manager.#telemetrySinks.values()]) {
          try {
            owned.sink.emit(event);
          } catch (error) {
            manager.#telemetryErrors.push(runtimeError(owned.owner, "telemetry_sink", error));
          }
        }
      },
      async flush(): Promise<void> {
        const results = await Promise.allSettled([
          base.flush(),
          ...[...manager.#telemetrySinks.values()].map(async (owned) => {
            try {
              await owned.sink.flush();
            } catch (error) {
              manager.#telemetryErrors.push(runtimeError(owned.owner, "telemetry_sink", error));
            }
          }),
        ]);
        const baseResult = results[0];
        if (baseResult?.status === "rejected") throw baseResult.reason;
      },
    };
  }

  drainTelemetryErrors(): readonly ExtensionRuntimeError[] {
    return this.#telemetryErrors.splice(0, this.#telemetryErrors.length);
  }

  toErrorData(error: ExtensionRuntimeError, fallbackSourceEvent?: SessionEvent): ExtensionErrorData {
    const source = error.sourceEvent ?? fallbackSourceEvent;
    if (source === undefined || source.type === "extension.error") {
      throw new ExtensionManagerError(
        "extension_error_source_missing",
        "A durable extension error must point to a non-extension source event",
      );
    }
    return ExtensionErrorDataSchema.parse({
      extension_name: error.extensionName,
      api_version: EXTENSION_API_VERSION,
      phase: error.phase,
      code: error.code,
      message: error.message,
      source_event_id: source.event_id,
      source_event_type: source.type,
    });
  }

  async #activate(extension: ExtensionCandidate): Promise<ExtensionStatus> {
    const name = ExtensionNameSchema.parse(extension.name);
    if (this.#records.get(name)?.state === "active") {
      throw new ExtensionManagerError("extension_duplicate", `Extension ${name} is already active`);
    }
    try {
      this.#validateCandidate(extension);
    } catch (error) {
      const record: ExtensionRecord = {
        extension,
        state: "rejected",
        registrations: [],
        generation: this.#generation,
        updatedAt: this.#nowIso(),
        error: { code: errorCode(error, "extension_rejected"), message: safeError(error) },
      };
      this.#records.set(name, record);
      throw error;
    }
    const record: ExtensionRecord = {
      extension,
      state: "activating",
      registrations: [],
      generation: this.#generation,
      updatedAt: this.#nowIso(),
    };
    this.#records.set(name, record);
    try {
      await withTimeout(
        Promise.resolve(extension.activate(this.#contextFor(record))),
        this.#lifecycleTimeoutMs,
        "extension_activate_timeout",
      );
      this.#generation += 1;
      record.generation = this.#generation;
      record.state = "active";
      record.updatedAt = this.#nowIso();
      return this.#status(record);
    } catch (error) {
      await disposeRegistrations(record.registrations);
      record.state = "failed";
      record.error = { code: errorCode(error, "extension_activate_failed"), message: safeError(error) };
      record.updatedAt = this.#nowIso();
      throw new ExtensionManagerError(record.error.code, record.error.message, { cause: error });
    }
  }

  async #deactivate(name: string): Promise<ExtensionStatus> {
    const record = this.#records.get(name);
    if (record === undefined || record.state !== "active") {
      throw new ExtensionManagerError("extension_not_active", `Extension ${name} is not active`);
    }
    record.state = "deactivating";
    record.updatedAt = this.#nowIso();
    const errors: unknown[] = [];
    if (record.extension.deactivate !== undefined) {
      try {
        await withTimeout(
          Promise.resolve(record.extension.deactivate()),
          this.#lifecycleTimeoutMs,
          "extension_deactivate_timeout",
        );
      } catch (error) {
        errors.push(error);
      }
    }
    errors.push(...await disposeRegistrations(record.registrations));
    this.#generation += 1;
    record.generation = this.#generation;
    record.updatedAt = this.#nowIso();
    if (errors.length > 0) {
      record.state = "failed";
      record.error = {
        code: "extension_deactivate_failed",
        message: errors.map(safeError).join("; ").slice(0, 1_000),
      };
    } else {
      record.state = "inactive";
      delete record.error;
    }
    return this.#status(record);
  }

  #validateCandidate(extension: ExtensionCandidate): void {
    ExtensionNameSchema.parse(extension.name);
    if (extension.api_version !== EXTENSION_API_VERSION) {
      throw new ExtensionManagerError(
        "extension_api_version_mismatch",
        `Extension ${extension.name} requires unsupported API ${extension.api_version}`,
      );
    }
    if (typeof extension.activate !== "function") {
      throw new ExtensionManagerError("extension_activate_missing", "Extension activate must be a function");
    }
    if (extension.deactivate !== undefined && typeof extension.deactivate !== "function") {
      throw new ExtensionManagerError("extension_deactivate_invalid", "Extension deactivate must be a function");
    }
  }

  #contextFor(record: ExtensionRecord): ExtensionContext {
    const owner = record.extension.name;
    const register = (disposeValue: () => void | Promise<void>): Disposable => {
      const performDispose = async (): Promise<void> => {
        if (registration.disposed) return;
        registration.disposed = true;
        await disposeValue();
      };
      const registration: Registration = {
        disposed: false,
        dispose: async () => {
          if (registration.disposed) return;
          if (record.state !== "active") {
            await performDispose();
            return;
          }
          await this.#serialize(async () => {
            if (registration.disposed) return;
            await performDispose();
            this.#generation += 1;
            record.generation = this.#generation;
            record.updatedAt = this.#nowIso();
          });
        },
      };
      record.registrations.push(registration);
      return registration;
    };
    const assertActivating = () => {
      if (record.state !== "activating" && record.state !== "active") {
        throw new ExtensionManagerError("extension_not_registering", `Extension ${owner} cannot register in ${record.state}`);
      }
    };
    return Object.freeze({
      registerTool: (definition: ToolDefinition) => {
        assertActivating();
        if (this.#toolOwners.has(definition.name) || this.toolRegistry.get(definition.name) !== undefined) {
          throw new ExtensionManagerError("extension_tool_conflict", `Tool ${definition.name} is already registered`);
        }
        const toolDisposable = this.toolRegistry.register(definition);
        this.#toolOwners.set(definition.name, owner);
        return register(() => {
          if (this.#toolOwners.get(definition.name) === owner) this.#toolOwners.delete(definition.name);
          toolDisposable.dispose();
        });
      },
      registerTelemetrySink: (sink: TelemetrySink) => {
        assertActivating();
        if (sink === null || typeof sink !== "object" || typeof sink.emit !== "function" || typeof sink.flush !== "function") {
          throw new ExtensionManagerError("extension_telemetry_invalid", "Telemetry sink is invalid");
        }
        const token = Symbol(owner);
        this.#telemetrySinks.set(token, { owner, sink });
        return register(() => { this.#telemetrySinks.delete(token); });
      },
      registerContextStrategy: (strategy: ContextStrategy) => {
        assertActivating();
        const name = ExtensionNameSchema.parse(strategy.name);
        if (this.#contextStrategies.has(name)) {
          throw new ExtensionManagerError("extension_context_conflict", `Context strategy ${name} is already registered`);
        }
        if (typeof strategy.contribute !== "function") {
          throw new ExtensionManagerError("extension_context_invalid", "Context strategy contribute must be a function");
        }
        this.#contextStrategies.set(name, { owner, strategy });
        return register(() => { this.#contextStrategies.delete(name); });
      },
      registerPolicyRule: (value: PolicyRule) => {
        assertActivating();
        const rule = PolicyRuleSchema.parse(value);
        if (this.#policyRules.has(rule.rule_id)) {
          throw new ExtensionManagerError("extension_policy_conflict", `Policy rule ${rule.rule_id} is already registered`);
        }
        this.#policyRules.set(rule.rule_id, { owner, rule });
        return register(() => { this.#policyRules.delete(rule.rule_id); });
      },
      registerCommand: (nameValue: string, handler: ExtensionCommandHandler) => {
        assertActivating();
        const name = ExtensionCommandInvocationSchema.shape.name.parse(nameValue);
        if (this.#commands.has(name)) {
          throw new ExtensionManagerError("extension_command_conflict", `Command ${name} is already registered`);
        }
        if (typeof handler !== "function") {
          throw new ExtensionManagerError("extension_command_invalid", "Extension command handler must be a function");
        }
        this.#commands.set(name, { owner, handler });
        return register(() => { this.#commands.delete(name); });
      },
      on: (typeValue: EventType, handler: ExtensionEventHandler) => {
        assertActivating();
        const type = EventTypeSchema.parse(typeValue);
        if (typeof handler !== "function") {
          throw new ExtensionManagerError("extension_hook_invalid", "Extension event handler must be a function");
        }
        const hook = { owner, type, handler };
        this.#hooks.add(hook);
        return register(() => { this.#hooks.delete(hook); });
      },
    });
  }

  #status(record: ExtensionRecord): ExtensionStatus {
    return ExtensionStatusSchema.parse({
      name: record.extension.name,
      api_version: EXTENSION_API_VERSION,
      state: record.state,
      registration_count: record.registrations.filter((registration) => !registration.disposed).length,
      generation: record.generation,
      updated_at: record.updatedAt,
      ...(record.error === undefined ? {} : {
        error_code: record.error.code,
        error_message: record.error.message,
      }),
    });
  }

  #assertIdle(operation: string): void {
    if (this.#activeLeases > 0) {
      throw new ExtensionManagerError(
        "extension_busy",
        `Cannot ${operation} extensions while ${this.#activeLeases} Run lease(s) are active`,
      );
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    // Close the scheduling gap synchronously. Without this gate a caller could
    // queue activate/reload, acquire a Run lease before the first promise
    // continuation starts, and either observe a half-updated surface or make
    // the already-authorized mutation fail for timing-dependent reasons.
    this.#pendingMutations += 1;
    this.#mutating = true;
    const guarded = async (): Promise<T> => {
      this.#assertIdle("change");
      return operation();
    };
    const result = this.#mutationQueue.then(guarded, guarded);
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.#pendingMutations = Math.max(0, this.#pendingMutations - 1);
      this.#mutating = this.#pendingMutations > 0;
    });
  }

  #nowIso(): string {
    const now = this.#now();
    return Number.isFinite(now.getTime()) ? now.toISOString() : "1970-01-01T00:00:00.000Z";
  }
}

export class ExtensionManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtensionManagerError";
    this.code = code;
  }
}

function runtimeError(
  extensionName: string,
  phase: ExtensionErrorData["phase"],
  error: unknown,
  sourceEvent?: SessionEvent,
): ExtensionRuntimeError {
  return {
    extensionName,
    phase,
    code: errorCode(error, `extension_${phase}_failed`),
    message: safeError(error),
    ...(sourceEvent === undefined ? {} : { sourceEvent }),
  };
}

async function disposeRegistrations(registrations: readonly Registration[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const registration of [...registrations].reverse()) {
    try {
      await registration.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 10 || value > 60_000) {
    throw new RangeError(`${label} must be an integer between 10 and 60000`);
  }
  return value;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new ExtensionManagerError(code, code.replaceAll("_", " "))), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function deepFreezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value)) as T;
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "Extension operation failed";
  return normalized.slice(0, 1_000);
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof ExtensionManagerError) return error.code;
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

function compareRules(
  left: { rule_id: string; priority: number },
  right: { rule_id: string; priority: number },
): number {
  return right.priority - left.priority || left.rule_id.localeCompare(right.rule_id);
}
