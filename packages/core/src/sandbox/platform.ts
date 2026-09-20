import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  SandboxModeSchema,
  SandboxReportSchema,
  type SandboxMode,
  type SandboxPlatform,
  type SandboxReport,
} from "@tracegraph/contracts";
import { runBoundedProcess } from "./process-runner.js";
import {
  generateSeatbeltProfile,
  SEATBELT_EXECUTABLE,
  seatbeltArguments,
} from "./seatbelt.js";

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_OUTPUT_LIMIT_BYTES = 4_096;
const DARWIN_PROBE_EXECUTABLE = "/usr/bin/true";
const LINUX_BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;

export interface SandboxProbeRequest {
  mode: SandboxMode;
  workspaceRoot: string;
}

export interface NativeSandboxProbeOptions {
  platform?: NodeJS.Platform;
  seatbeltExecutable?: string;
}

export interface ValidatedSandboxPaths {
  workspaceRoot: string;
  cwd: string;
  executable: string;
}

export async function probeNativeSandbox(
  request: SandboxProbeRequest,
  options: NativeSandboxProbeOptions = {},
): Promise<SandboxReport> {
  const mode = SandboxModeSchema.parse(request.mode);
  const platform = supportedPlatform(options.platform ?? process.platform);
  const workspaceRoot = await canonicalDirectory(request.workspaceRoot, "workspaceRoot");

  if (mode === "danger-full-access") return disabledReport(mode, platform);
  if (platform === "darwin") {
    return probeSeatbelt(mode, platform, workspaceRoot, options.seatbeltExecutable ?? SEATBELT_EXECUTABLE);
  }
  if (platform === "linux") {
    const bwrap = await firstTrustedExecutable(LINUX_BWRAP_CANDIDATES);
    return unavailableReport(mode, platform, [
      bwrap === undefined ? "linux_sandbox_backend_unavailable" : "linux_sandbox_backend_not_enabled",
      "filesystem_scope_unenforced",
      "network_denial_unenforced",
    ]);
  }
  return unavailableReport(mode, platform, [
    "windows_sandbox_backend_unavailable",
    "filesystem_scope_unenforced",
    "network_denial_unenforced",
  ]);
}

export async function validateSandboxPaths(input: {
  workspaceRoot: string;
  cwd: string;
  executable: string;
}): Promise<ValidatedSandboxPaths> {
  const workspaceRoot = await canonicalDirectory(input.workspaceRoot, "workspaceRoot");
  const cwd = await canonicalDirectory(input.cwd, "cwd");
  assertInsideWorkspace(workspaceRoot, cwd);
  const executable = await canonicalExecutable(input.executable);
  return { workspaceRoot, cwd, executable };
}

async function probeSeatbelt(
  mode: Exclude<SandboxMode, "danger-full-access">,
  platform: "darwin",
  workspaceRoot: string,
  sandboxExecutable: string,
): Promise<SandboxReport> {
  const backend = await trustedExecutable(sandboxExecutable);
  if (backend === undefined) {
    return unavailableReport(mode, platform, [
      "seatbelt_backend_unavailable",
      "filesystem_scope_unenforced",
      "network_denial_unenforced",
    ]);
  }

  try {
    const profile = generateSeatbeltProfile(mode);
    const result = await runBoundedProcess(
      backend,
      seatbeltArguments({
        profile,
        workspaceRoot,
        executable: DARWIN_PROBE_EXECUTABLE,
        args: [],
      }),
      {
        cwd: workspaceRoot,
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_OUTPUT_LIMIT_BYTES,
      },
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated || result.aborted) {
      return unavailableReport(mode, platform, [
        "seatbelt_capability_probe_failed",
        "filesystem_scope_unenforced",
        "network_denial_unenforced",
      ]);
    }
  } catch {
    return unavailableReport(mode, platform, [
      "seatbelt_capability_probe_failed",
      "filesystem_scope_unenforced",
      "network_denial_unenforced",
    ]);
  }

  return SandboxReportSchema.parse({
    report_version: 1,
    mode,
    enforcement: "full",
    platform,
    mechanisms: [
      `seatbelt:${backend}`,
      mode === "read-only" ? "filesystem:read-only" : "filesystem:workspace-write",
      "path-scope:canonical-workspace",
      "network:denied",
      "process:shell-false",
    ],
    unmet_constraints: [],
  });
}

export function disabledReport(
  mode: "danger-full-access",
  platform: SandboxPlatform,
): SandboxReport {
  return SandboxReportSchema.parse({
    report_version: 1,
    mode,
    enforcement: "none",
    platform,
    mechanisms: [],
    unmet_constraints: [],
  });
}

export function unavailableReport(
  mode: Exclude<SandboxMode, "danger-full-access">,
  platform: SandboxPlatform,
  unmetConstraints: readonly string[],
): SandboxReport {
  return SandboxReportSchema.parse({
    report_version: 1,
    mode,
    enforcement: "none",
    platform,
    mechanisms: [],
    unmet_constraints: [...new Set(unmetConstraints)],
  });
}

function supportedPlatform(platform: NodeJS.Platform): SandboxPlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new SandboxPlatformError(`unsupported sandbox platform: ${platform}`);
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  assertAbsoluteSafePath(path, label);
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new SandboxPathError(`${label} must be a directory`);
  return canonical;
}

async function canonicalExecutable(path: string): Promise<string> {
  assertAbsoluteSafePath(path, "executable");
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isFile()) throw new SandboxPathError("executable must be a regular file");
  await access(canonical, constants.X_OK);
  return canonical;
}

async function firstTrustedExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const executable = await trustedExecutable(candidate);
    if (executable !== undefined) return executable;
  }
  return undefined;
}

async function trustedExecutable(path: string): Promise<string | undefined> {
  try {
    assertAbsoluteSafePath(path, "sandbox backend");
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    if ((info.mode & 0o022) !== 0) return undefined;
    if (process.getuid !== undefined && info.uid !== 0 && info.uid !== process.getuid()) return undefined;
    await access(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

function assertAbsoluteSafePath(path: string, label: string): void {
  if (!isAbsolute(path)) throw new SandboxPathError(`${label} must be absolute`);
  if (/[\0\r\n]/u.test(path)) {
    throw new SandboxPathError(`${label} contains an unsupported control character`);
  }
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const fromRoot = relative(workspaceRoot, candidate);
  if (
    fromRoot === ""
    || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  ) return;
  throw new SandboxPathError("cwd escapes the canonical workspace root");
}

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPathError";
  }
}

export class SandboxPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPlatformError";
  }
}
