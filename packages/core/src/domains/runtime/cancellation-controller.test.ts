import { describe, expect, it } from "vitest";

import { CancellationController } from "./cancellation-controller.js";

describe("CancellationController", () => {
  it("fences later dispatches and waits for admitted work to settle", async () => {
    const controller = new CancellationController();
    const task = deferred<string>();
    let starts = 0;
    const active = controller.startJob("model", () => {
      starts += 1;
      return task.promise;
    });

    expect(active).toBeDefined();
    expect(controller.activeJobCount).toBe(1);
    controller.abort(new Error("cancelled"));

    expect(controller.signal.aborted).toBe(true);
    expect(controller.isFenced).toBe(true);
    expect(controller.startJob("tool", () => {
      starts += 1;
    })).toBeUndefined();
    expect(starts).toBe(1);
    await expect(controller.waitForQuiescence(5)).resolves.toBe(false);

    task.resolve("settled");
    await expect(active).resolves.toBe("settled");
    await expect(controller.waitForQuiescence(50)).resolves.toBe(true);
    expect(controller.activeJobCount).toBe(0);
  });

  it("reports quiescence to a deferred cancellation finalizer", async () => {
    const controller = new CancellationController();
    const task = deferred<void>();
    let finalized = 0;
    controller.startJob("tool", () => task.promise);
    controller.abort();
    controller.onQuiescent(() => finalized += 1);

    expect(finalized).toBe(0);
    task.resolve();
    await Promise.resolve();
    expect(finalized).toBe(1);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value as T) };
}
