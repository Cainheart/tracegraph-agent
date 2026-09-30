import { EXTENSION_API_VERSION } from "@tracegraph/contracts";
import type { ToolDefinition } from "./tool/definition.js";
export type {
  BoundedProcessResult,
  SandboxExecutionResult,
  SandboxProbeRequest,
  SandboxRunRequest,
  SandboxRunner,
} from "@tracegraph/tool";

/** Minimal disposal port shared by Core-managed registrations. */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** Narrow extension context needed by adapters that contribute Tools. */
export interface ToolExtensionContext {
  registerTool(definition: ToolDefinition): Disposable;
}

/** Tool-only extension contract; lifecycle policy remains in ExtensionManager. */
export interface ToolExtension {
  readonly name: string;
  readonly api_version: typeof EXTENSION_API_VERSION;
  activate(context: ToolExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
