import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeControlledTemporaryDirectory } from "@tracegraph/core";
import { describe, expect, it } from "vitest";
import { closeHostAndFlushTelemetry, createCodeGraphProvider } from "./composition.js";

describe("CLI composition", () => {
  it("waits for telemetry flush after Host close, including close failures", async () => {
    const order: string[] = [];
    await closeHostAndFlushTelemetry(
      async () => { order.push("host.closed"); },
      async () => { await Promise.resolve(); order.push("telemetry.flushed"); },
    );
    expect(order).toEqual(["host.closed", "telemetry.flushed"]);

    const failedOrder: string[] = [];
    await expect(closeHostAndFlushTelemetry(
      async () => { failedOrder.push("host.failed"); throw new Error("close failed"); },
      async () => { await Promise.resolve(); failedOrder.push("telemetry.flushed"); },
    )).rejects.toThrow("close failed");
    expect(failedOrder).toEqual(["host.failed", "telemetry.flushed"]);
  });

  it("bounds a telemetry flush that never settles during shutdown", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(closeHostAndFlushTelemetry(
      async () => undefined,
      () => never,
      1,
    )).resolves.toBeUndefined();
  });

  it("adapts CodeGraph to the Core provider seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-cli-graph-"));
    try {
      await writeFile(join(root, "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
      await writeFile(join(root, "b.ts"), "export const b = 1;\n");
      const provider = createCodeGraphProvider();
      const before = await provider.createSnapshot({
        projectId: "project-test",
        workspaceRoot: root,
      });
      await writeFile(join(root, "c.ts"), "export const c = 2;\n");
      const after = await provider.createSnapshot({
        projectId: "project-test",
        workspaceRoot: root,
      });
      const delta = await provider.createDelta({ base: before, result: after });
      expect(before.nodes.length).toBeGreaterThan(0);
      expect(delta.node_changes.some((change) => change.change === "added")).toBe(true);
    } finally {
      await removeControlledTemporaryDirectory(root);
    }
  });

  it("propagates cancellation through the CodeGraph provider seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-cli-graph-abort-"));
    try {
      await writeFile(join(root, "a.ts"), "export const a = 1;\n");
      const provider = createCodeGraphProvider();
      const controller = new AbortController();
      controller.abort(new Error("stop requested"));

      await expect(provider.createSnapshot({
        projectId: "project-test",
        workspaceRoot: root,
        signal: controller.signal,
      })).rejects.toMatchObject({ code: "analysis_aborted" });
    } finally {
      await removeControlledTemporaryDirectory(root);
    }
  });
});
