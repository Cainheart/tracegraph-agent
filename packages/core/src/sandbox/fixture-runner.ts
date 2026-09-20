import {
  SANDBOX_REPORT_FORMAT_VERSION,
  SandboxModeSchema,
  SandboxReportSchema,
  type SandboxMode,
  type SandboxPlatform,
  type SandboxReport,
} from "@tracegraph/contracts";
import {
  disabledReport,
  validateSandboxPaths,
  type SandboxProbeRequest,
} from "./platform.js";
import { runBoundedProcess } from "./process-runner.js";
import type {
  SandboxExecutionResult,
  SandboxRunRequest,
  SandboxRunner,
} from "./runner.js";

/**
 * A `SandboxRunner` for suites that drive a full Run through the `run_test`
 * tool on any platform.
 *
 * `NativeSandboxRunner` fails closed with `sandbox_unavailable` whenever the
 * host cannot prove full OS isolation. macOS satisfies that with seatbelt, but
 * Linux never does: `probeNativeSandbox` reports a Linux backend as unavailable
 * until one is actually implemented. Suites whose subject is approval, WAL or
 * recovery semantics therefore pass on a developer Mac and fail on Linux CI for
 * reasons unrelated to what they assert.
 *
 * This runner keeps the production contract -- it validates the same paths and
 * really spawns the child, so `run_test` executes the fixture suite and its exit
 * code still flows back -- but it reports the enforcement a native backend would
 * have reported. It applies **no** isolation, so it is only ever correct as an
 * injected test boundary. See `AgentRuntimeOptions.sandboxRunner`.
 */
export function createFixtureSandboxRunner(): SandboxRunner {
  return {
    async probe(request: SandboxProbeRequest): Promise<SandboxReport> {
      return fixtureReport(request.mode);
    },

    async run(request: SandboxRunRequest): Promise<SandboxExecutionResult> {
      const paths = await validateSandboxPaths(request);
      const result = await runBoundedProcess(paths.executable, request.args, {
        cwd: paths.cwd,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return { ...result, started: true, sandboxReport: fixtureReport(request.mode) };
    },
  };
}

function fixtureReport(mode: SandboxMode): SandboxReport {
  const parsed = SandboxModeSchema.parse(mode);
  const platform = fixturePlatform();
  // Claiming enforcement while isolation is off is forbidden by the contract,
  // and this mode skips the sandbox natively anyway.
  if (parsed === "danger-full-access") return disabledReport(parsed, platform);
  return SandboxReportSchema.parse({
    report_version: SANDBOX_REPORT_FORMAT_VERSION,
    mode: parsed,
    enforcement: "full",
    platform,
    mechanisms: [
      "fixture:no-os-isolation",
      parsed === "read-only" ? "filesystem:read-only" : "filesystem:workspace-write",
      "path-scope:canonical-workspace",
    ],
    unmet_constraints: [],
  });
}

/** Report the host we really run on so audit events stay truthful. */
function fixturePlatform(): SandboxPlatform {
  const platform = process.platform;
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}
