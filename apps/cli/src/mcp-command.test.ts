import { describe, expect, it, vi } from "vitest";
import { runMcpCommand } from "./mcp-command.js";

describe("mcp CLI command", () => {
  it("bootstraps before listing and honors the Host URL", async () => {
    const calls: unknown[] = [];
    const write = vi.fn();
    await runMcpCommand(["list", "--host-url", "http://127.0.0.1:4999"], {
      environment: {},
      createClient(url) {
        expect(url).toBe("http://127.0.0.1:4999");
        return {
          async bootstrap() { calls.push("bootstrap"); },
          async getMcpStatus() { calls.push("list"); return { servers: [] }; },
          async restartMcpServer() { throw new Error("unexpected restart"); },
        };
      },
      write,
    });
    expect(calls).toEqual(["bootstrap", "list"]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"servers": []'));
  });

  it("dispatches restart with the selected server and rejects incomplete input", async () => {
    const calls: unknown[] = [];
    const dependencies = {
      createClient: () => ({
        async bootstrap() { calls.push("bootstrap"); },
        async getMcpStatus() { return { servers: [] }; },
        async restartMcpServer(name: string) { calls.push(["restart", name]); return { name }; },
      }),
      write: () => undefined,
    };
    await runMcpCommand(["restart", "filesystem"], dependencies);
    expect(calls).toEqual(["bootstrap", ["restart", "filesystem"]]);
    await expect(runMcpCommand(["restart"], dependencies)).rejects.toThrow(/restart <server>/u);
    expect(calls).toHaveLength(2);
  });
});
