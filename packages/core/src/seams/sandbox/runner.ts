import type { SandboxReport } from "@tracegraph/contracts";
import {
  probeNativeSandbox,
  validateSandboxPaths,
  type NativeSandboxProbeOptions,
} from "./platform.js";
import { runBoundedProcess } from "./process-runner.js";
import {
  generateSeatbeltProfile,
  SEATBELT_EXECUTABLE,
  seatbeltArguments,
} from "./seatbelt.js";
import type {
  SandboxExecutionResult,
  SandboxProbeRequest,
  SandboxRunRequest,
  SandboxRunner,
} from "../../kernel/registration.js";

export type {
  SandboxExecutionResult,
  SandboxRunRequest,
  SandboxRunner,
} from "../../kernel/registration.js";

export class NativeSandboxRunner implements SandboxRunner {
  readonly #options: NativeSandboxProbeOptions;

  constructor(options: NativeSandboxProbeOptions = {}) {
    this.#options = { ...options };
  }

  probe(request: SandboxProbeRequest): Promise<SandboxReport> {
    return probeNativeSandbox(request, this.#options);
  }

  async run(request: SandboxRunRequest): Promise<SandboxExecutionResult> {
    const paths = await validateSandboxPaths(request);
    const sandboxReport = await this.probe({
      mode: request.mode,
      workspaceRoot: paths.workspaceRoot,
    });

    if (request.mode !== "danger-full-access" && sandboxReport.enforcement !== "full") {
      return unavailableExecution(sandboxReport);
    }

    if (request.mode === "danger-full-access") {
      const result = await runBoundedProcess(paths.executable, request.args, {
        cwd: paths.cwd,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return { ...result, started: true, sandboxReport };
    }

    const backend = this.#options.seatbeltExecutable ?? SEATBELT_EXECUTABLE;
    try {
      const result = await runBoundedProcess(
        backend,
        seatbeltArguments({
          profile: generateSeatbeltProfile(request.mode),
          workspaceRoot: paths.workspaceRoot,
          executable: paths.executable,
          args: request.args,
        }),
        {
          cwd: paths.cwd,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
      return { ...result, started: true, sandboxReport };
    } catch {
      const unavailable = await probeNativeSandbox(
        { mode: request.mode, workspaceRoot: paths.workspaceRoot },
        { ...this.#options, seatbeltExecutable: "/tracegraph/unavailable/sandbox-exec" },
      );
      return unavailableExecution(unavailable);
    }
  }
}

export function createSandboxRunner(options: NativeSandboxProbeOptions = {}): SandboxRunner {
  return new NativeSandboxRunner(options);
}

function unavailableExecution(sandboxReport: SandboxReport): SandboxExecutionResult {
  return {
    started: false,
    sandboxReport,
    failureCode: "sandbox_unavailable",
    exitCode: null,
    stdout: "",
    stderr: `sandbox enforcement unavailable: ${sandboxReport.unmet_constraints.join(", ")}`,
    timedOut: false,
    truncated: false,
    aborted: false,
  };
}
