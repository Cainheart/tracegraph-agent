import {
  EXTENSION_API_VERSION,
  type EventType,
  type ExtensionCommandInvocation,
  type PolicyRule,
  type SessionEvent,
} from "@tracegraph/contracts";
import type { TelemetrySink } from "@tracegraph/telemetry";
import type { ToolDefinition } from "../../kernel/tool/definition.js";
import type { Disposable, ToolExtensionContext } from "../../kernel/registration.js";

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

/** Stable registration surface presented to a trusted in-process extension. */
export interface ExtensionContext extends ToolExtensionContext {
  registerTelemetrySink(sink: TelemetrySink): Disposable;
  registerContextStrategy(strategy: ContextStrategy): Disposable;
  registerPolicyRule(rule: PolicyRule): Disposable;
  registerCommand(name: string, handler: ExtensionCommandHandler): Disposable;
  on(type: EventType, handler: ExtensionEventHandler): Disposable;
}

/** Extension API contract; lifecycle policy belongs to ExtensionManager. */
export interface TraceGraphExtension {
  readonly name: string;
  readonly api_version: typeof EXTENSION_API_VERSION;
  activate(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
