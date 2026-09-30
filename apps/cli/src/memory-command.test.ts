import { describe, expect, it, vi } from "vitest";
import { runMemoryCommand } from "./memory-command.js";

describe("Memory CLI command", () => {
  it("bootstraps the Host client and creates a candidate through the SDK seam", async () => {
    const calls: unknown[] = [];
    const write = vi.fn();
    const selectedUrls: string[] = [];
    const client = {
      async bootstrap() { calls.push("bootstrap"); },
      async listMemoryControl() { return { items: [], conflicts: [] }; },
      async createMemoryCandidate(input: unknown) {
        calls.push(["create", input]);
        return { record: { memoryId: "memory:test" } } as never;
      },
      async reviewMemory() { throw new Error("unexpected review"); },
      async correctMemory() { throw new Error("unexpected correction"); },
      async revokeMemory() { throw new Error("unexpected revoke"); },
      async deleteMemory() { throw new Error("unexpected delete"); },
    };

    await runMemoryCommand([
      "candidate", "add", "--host-url", "http://127.0.0.1:4999",
      "--kind", "fact", "--claim", "CLI uses the shared Memory service.",
      "--project-id", "project-demo", "--allow-model-use",
    ], {
      environment: {},
      createClient(baseUrl) {
        selectedUrls.push(baseUrl);
        return client;
      },
      write,
    });

    expect(selectedUrls).toEqual(["http://127.0.0.1:4999"]);
    expect(calls).toEqual([
      "bootstrap",
      ["create", {
        kind: "fact",
        claim: "CLI uses the shared Memory service.",
        project_id: "project-demo",
        allow_model_use: true,
      }],
    ]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"memoryId": "memory:test"'));
  });

  it("supports show with --host-url before the Memory identity", async () => {
    const calls: unknown[] = [];
    const write = vi.fn();
    await runMemoryCommand(["show", "--host-url", "http://127.0.0.1:4998", "memory:visible"], {
      environment: {},
      createClient: () => ({
        async bootstrap() { calls.push("bootstrap"); },
        async listMemoryControl() {
          calls.push("list");
          return { items: [{ record: { memoryId: "memory:visible" } }], conflicts: [] } as never;
        },
        async createMemoryCandidate() { throw new Error("unexpected create"); },
        async reviewMemory() { throw new Error("unexpected review"); },
        async correctMemory() { throw new Error("unexpected correction"); },
        async revokeMemory() { throw new Error("unexpected revoke"); },
        async deleteMemory() { throw new Error("unexpected delete"); },
      }),
      write,
    });
    expect(calls).toEqual(["bootstrap", "list"]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"memoryId": "memory:visible"'));
  });

  it("propagates command failures without emitting a success result", async () => {
    const write = vi.fn();
    await expect(runMemoryCommand(["candidate", "add", "--kind", "fact", "--claim", "One"], {
      environment: {},
      createClient: () => ({
        async bootstrap() {},
        async listMemoryControl() { return { items: [], conflicts: [] }; },
        async createMemoryCandidate() { throw new Error("memory_control_conflict"); },
        async reviewMemory() { throw new Error("unexpected review"); },
        async correctMemory() { throw new Error("unexpected correction"); },
        async revokeMemory() { throw new Error("unexpected revoke"); },
        async deleteMemory() { throw new Error("unexpected delete"); },
      }),
      write,
    })).rejects.toThrow("memory_control_conflict");
    expect(write).not.toHaveBeenCalled();
  });
});
