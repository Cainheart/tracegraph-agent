import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => {
  const probe = vi.fn();
  Object.defineProperty(probe, Symbol.for("nodejs.util.promisify.custom"), { value: probe, configurable: true });
  return { probe, realpath: vi.fn(), stat: vi.fn(), access: vi.fn() };
});
vi.mock("node:child_process", () => ({ execFile: doubles.probe }));
vi.mock("node:fs/promises", () => ({ realpath: doubles.realpath, stat: doubles.stat, access: doubles.access }));

import {
  curatedNodeEnvironment,
  DesktopHostNodeUnavailableError,
  nodeExecutableCandidates,
  resolveDesktopHostNodeExecutable,
  supportedNodeVersion,
} from "./node-executable.js";

const context = {
  execPath: "/private/Electron.app/Contents/MacOS/Electron",
  electron: true,
  platform: "darwin" as const,
  environment: {
    PATH: ":.:relative:/trusted/bin:/trusted/bin", HOME: "/safe-home",
    NODE_OPTIONS: "--require /private/preload.js", NODE_PATH: "/private/modules",
    ELECTRON_RUN_AS_NODE: "1", DYLD_INSERT_LIBRARIES: "/private/injection.dylib", OPENAI_API_KEY: "private-key",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  doubles.realpath.mockImplementation(async (path: string) => path);
  doubles.stat.mockResolvedValue({ isFile: () => true });
  doubles.access.mockResolvedValue(undefined);
  doubles.probe.mockImplementation(async (path: string) => ({
    stdout: JSON.stringify({ node: "24.21.0", execPath: path }), stderr: "",
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("trusted Desktop Host Node selection", () => {
  it("uses a verified absolute realpath and strips all startup injection and credential variables", async () => {
    doubles.realpath.mockImplementation(async (path: string) => path === "/opt/homebrew/bin/node" ? "/opt/homebrew/Cellar/node@24/24.21.0/bin/node" : path);
    await expect(resolveDesktopHostNodeExecutable(context)).resolves.toBe("/opt/homebrew/Cellar/node@24/24.21.0/bin/node");
    expect(doubles.probe).toHaveBeenCalledOnce();
    expect(doubles.probe).toHaveBeenCalledWith("/opt/homebrew/Cellar/node@24/24.21.0/bin/node", ["--eval", expect.any(String)], {
      env: { PATH: context.environment.PATH, HOME: "/safe-home" }, shell: false,
      timeout: 2_000, maxBuffer: 4_096, windowsHide: true,
    });
    expect(curatedNodeEnvironment(context.environment)).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  it("never treats the Electron parent or a project-relative PATH as a Node candidate", () => {
    expect(nodeExecutableCandidates(context)).toEqual([
      "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/trusted/bin/node",
    ]);
  });

  it("rejects embedded Electron, unsupported Node, identity mismatch and invalid probes before falling back", async () => {
    doubles.probe
      .mockResolvedValueOnce({ stdout: JSON.stringify({ node: "24.21.0", electron: "44.5.1", execPath: "/opt/homebrew/bin/node" }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ node: "23.0.0", execPath: "/usr/local/bin/node" }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ node: "24.21.0", execPath: "/different/node" }) })
      .mockResolvedValueOnce({ stdout: "malformed" });
    await expect(resolveDesktopHostNodeExecutable(context)).rejects.toBeInstanceOf(DesktopHostNodeUnavailableError);
    expect(doubles.probe).toHaveBeenCalledTimes(4);
  });

  it("does not execute a non-file, inaccessible, or non-absolute resolved candidate", async () => {
    doubles.realpath.mockResolvedValueOnce("relative/node");
    doubles.stat.mockResolvedValueOnce({ isFile: () => false });
    doubles.access.mockRejectedValueOnce(new Error("not executable"));
    doubles.realpath.mockRejectedValueOnce(new Error("missing"));
    await expect(resolveDesktopHostNodeExecutable(context)).rejects.toMatchObject({
      message: expect.stringContaining("Desktop Host setup unavailable"),
    });
    expect(doubles.probe).not.toHaveBeenCalled();
  });

  it("retains a supported standalone Node parent as the first choice", async () => {
    await expect(resolveDesktopHostNodeExecutable({ ...context, electron: false, execPath: "/standalone/node" })).resolves.toBe("/standalone/node");
    expect(doubles.probe.mock.calls[0]?.[0]).toBe("/standalone/node");
  });

  it("validates exactly the current stable engines range", () => {
    for (const version of ["22.19.0", "22.20.3", "24.0.0", "25.1.0"]) expect(supportedNodeVersion(version)).toBe(true);
    for (const version of ["20.20.0", "22.18.9", "23.9.0", "24.0.0-rc.1", "24.0", "024.0.0", undefined]) expect(supportedNodeVersion(version)).toBe(false);
  });
});
