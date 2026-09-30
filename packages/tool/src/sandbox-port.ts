import type { SandboxMode, SandboxReport } from "@tracegraph/contracts";

export interface BoundedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
}

export interface SandboxProbeRequest {
  mode: SandboxMode;
  workspaceRoot: string;
}

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

/** Injectable boundary implemented by Core's selected sandbox runner. */
export interface SandboxRunner {
  probe(request: SandboxProbeRequest): Promise<SandboxReport>;
  run(request: SandboxRunRequest): Promise<SandboxExecutionResult>;
}
