import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

// Matches the repository's supported runtime: ^22.19.0 || >=24.0.0.
const NODE_REQUIREMENT = "Node.js 22.19+ (22.x) or 24+";
const NODE_IDENTITY_PROBE = "process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron,execPath:process.execPath}));";

export class DesktopHostNodeUnavailableError extends Error {
  constructor(message = `Desktop Host setup unavailable: install ${NODE_REQUIREMENT} in a standard location or the application PATH, then restart Outlive Agent.`) {
    super(message);
    this.name = "DesktopHostNodeUnavailableError";
  }
}

interface NodeExecutableContext {
  readonly execPath: string;
  readonly electron: boolean;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
}

/** Validates one trusted executable. Never resolves a command through PATH. */
export async function verifyStandaloneNodeExecutable(candidate: string, environment: NodeJS.ProcessEnv = process.env, expectedVersion?: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new DesktopHostNodeUnavailableError();
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isFile()) throw new DesktopHostNodeUnavailableError();
  await access(canonical, fsConstants.X_OK);
  const { stdout } = await promisify(execFile)(canonical, ["--eval", NODE_IDENTITY_PROBE], {
    env: curatedNodeEnvironment(environment), shell: false, timeout: 2_000, maxBuffer: 4_096, windowsHide: true,
  });
  const identity: unknown = JSON.parse(stdout);
  if (typeof identity !== "object" || identity === null) throw new DesktopHostNodeUnavailableError();
  const runtime = identity as Record<string, unknown>;
  if (runtime.electron !== undefined || !supportedNodeVersion(runtime.node) || runtime.execPath !== canonical || (expectedVersion !== undefined && runtime.node !== expectedVersion)) throw new DesktopHostNodeUnavailableError();
  return canonical;
}

/** Main/Host-only resolution; no renderer, project, model or IPC input reaches it. */
export async function resolveDesktopHostNodeExecutable(
  context: NodeExecutableContext = {
    execPath: process.execPath,
    electron: process.versions.electron !== undefined,
    platform: process.platform,
    environment: process.env,
  },
): Promise<string> {
  const seen = new Set<string>();
  for (const candidate of nodeExecutableCandidates(context)) {
    try {
      const canonical = await realpath(candidate);
      if (!isAbsolute(canonical) || seen.has(canonical)) continue;
      seen.add(canonical);
      if (!(await stat(canonical)).isFile()) continue;
      await access(canonical, fsConstants.X_OK);
      const { stdout } = await promisify(execFile)(canonical, ["--eval", NODE_IDENTITY_PROBE], {
        env: curatedNodeEnvironment(context.environment),
        shell: false,
        timeout: 2_000,
        maxBuffer: 4_096,
        windowsHide: true,
      });
      const identity: unknown = JSON.parse(stdout);
      if (typeof identity !== "object" || identity === null) continue;
      const runtime = identity as Record<string, unknown>;
      if (runtime.electron !== undefined || !supportedNodeVersion(runtime.node) || runtime.execPath !== canonical) continue;
      return canonical;
    } catch {
      // An absent, non-executable, unsupported, or invalid candidate grants no authority.
    }
  }
  throw new DesktopHostNodeUnavailableError();
}

export function nodeExecutableCandidates(context: NodeExecutableContext): string[] {
  const name = context.platform === "win32" ? "node.exe" : "node";
  const standard = context.platform === "darwin"
    ? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    : context.platform === "win32" ? [] : ["/usr/local/bin/node", "/usr/bin/node", "/bin/node"];
  const pathCandidates = (context.environment.PATH ?? "").split(delimiter)
    // Empty/relative PATH entries would make a selected project influence startup.
    .filter((directory) => isAbsolute(directory) && !directory.includes("\0"))
    .map((directory) => join(directory, name));
  return [...new Set([
    ...(!context.electron && isAbsolute(context.execPath) ? [context.execPath] : []),
    ...standard,
    ...pathCandidates,
  ])];
}

export function supportedNodeVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 19) || major >= 24;
}

export function curatedNodeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR",
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "LANG", "LC_ALL",
  ];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = environment[key];
    return value === undefined ? [] : [[key, value]];
  }));
}
