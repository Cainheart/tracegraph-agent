import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({ resolveNode: vi.fn(), fork: vi.fn() }));
vi.mock("./node-executable.js", async (original) => ({
  ...await original<typeof import("./node-executable.js")>(),
  resolveDesktopHostNodeExecutable: doubles.resolveNode,
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), fork: doubles.fork,
}));

import { launchDesktopHostProcess } from "./host-process.js";
import { DesktopHostNodeUnavailableError } from "./node-executable.js";

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("private Host runtime composition", () => {
  it("reports missing supported Node as setup_unavailable before creating a child", async () => {
    doubles.resolveNode.mockRejectedValue(new DesktopHostNodeUnavailableError());
    await expect(launchDesktopHostProcess({ dataDir: "/isolated-host-data" })).rejects.toMatchObject({
      code: "setup_unavailable", message: expect.stringContaining("install Node.js"),
    });
    expect(doubles.fork).not.toHaveBeenCalled();
  });

  it("forks with the validated standalone executable and without Electron mode, preload or credentials", async () => {
    doubles.resolveNode.mockResolvedValue("/verified/runtime/node");
    const stop = new Error("fork oracle");
    doubles.fork.mockImplementation(() => { throw stop; });
    vi.stubEnv("NODE_OPTIONS", "--require /private/preload.js");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("OPENAI_API_KEY", "private-key");
    await expect(launchDesktopHostProcess({ dataDir: "/isolated-host-data" })).rejects.toBe(stop);
    expect(doubles.fork).toHaveBeenCalledWith(expect.stringMatching(/worker\.js$/), [], expect.objectContaining({
      execPath: "/verified/runtime/node", execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"], serialization: "json",
    }));
    const options = doubles.fork.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
  });
});
