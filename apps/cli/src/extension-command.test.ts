import { describe, expect, it, vi } from "vitest";
import { runExtensionsCommand } from "./extension-command.js";

describe("extensions CLI command", () => {
  it("bootstraps before listing extensions and honors the explicit Host URL", async () => {
    const calls: string[] = [];
    let selectedUrl = "";
    const write = vi.fn();

    await runExtensionsCommand(["list", "--host-url", "http://127.0.0.1:4999"], {
      environment: {},
      createClient(baseUrl) {
        selectedUrl = baseUrl;
        return {
          async bootstrap() { calls.push("bootstrap"); },
          async listExtensions() { calls.push("list"); return [{ name: "fixture" }]; },
          async reloadExtension() { throw new Error("unexpected reload"); },
          async runExtensionCommand() { throw new Error("unexpected command"); },
        };
      },
      write,
    });

    expect(selectedUrl).toBe("http://127.0.0.1:4999");
    expect(calls).toEqual(["bootstrap", "list"]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"name": "fixture"'));
  });

  it("keeps reload and command arguments separate from --host-url", async () => {
    const calls: unknown[] = [];
    const client = {
      async bootstrap() { calls.push("bootstrap"); },
      async listExtensions() { throw new Error("unexpected list"); },
      async reloadExtension(name: string) { calls.push(["reload", name]); return { name }; },
      async runExtensionCommand(name: string, input: { args: readonly string[] }) {
        calls.push(["run", name, input.args]);
        return { name };
      },
    };
    const dependencies = {
      environment: { TRACEGRAPH_HOST_URL: "http://127.0.0.1:4888" },
      createClient: () => client,
      write: () => undefined,
    };

    await runExtensionsCommand(["reload", "@tracegraph/builtin-artifact-tools"], dependencies);
    await runExtensionsCommand(["run", "artifacts.list", "--safe", "--host-url", "http://127.0.0.1:4777"], dependencies);

    expect(calls).toEqual([
      "bootstrap",
      ["reload", "@tracegraph/builtin-artifact-tools"],
      "bootstrap",
      ["run", "artifacts.list", ["--safe"]],
    ]);
  });

  it("rejects incomplete commands before attempting bootstrap", async () => {
    const bootstrap = vi.fn();
    const dependencies = {
      createClient: () => ({
        bootstrap,
        async listExtensions() { return []; },
        async reloadExtension() { return {}; },
        async runExtensionCommand() { return {}; },
      }),
      write: () => undefined,
    };

    await expect(runExtensionsCommand(["reload"], dependencies)).rejects.toThrow(/trusted-extension-name/u);
    await expect(runExtensionsCommand(["unknown"], dependencies)).rejects.toThrow(/Usage/u);
    expect(bootstrap).not.toHaveBeenCalled();
  });
});
