import { EXTENSION_API_VERSION } from "@tracegraph/contracts";
import type { SandboxMode, SandboxReport } from "@tracegraph/contracts";
import type { ToolDefinition } from "./tool/definition.js";

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

export interface BoundedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
}

/** Narrow request accepted by the sandbox platform probe. */
export interface SandboxProbeRequest {
  mode: SandboxMode;
  workspaceRoot: string;
}

/** Narrow process request accepted by a registered sandbox runner. */
export interface SandboxRunRequest {
  mode: SandboxMode;
  workspaceRoot: string;
  cwd: string;
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface SandboxExecutionResult extends BoundedProcessResult {
  started: boolean;
  sandboxReport: SandboxReport;
  failureCode?: "sandbox_unavailable";
}

/** Injectable port implemented by the selected sandbox execution seam. */
export interface SandboxRunner {
  probe(request: SandboxProbeRequest): Promise<SandboxReport>;
  run(request: SandboxRunRequest): Promise<SandboxExecutionResult>;
}
