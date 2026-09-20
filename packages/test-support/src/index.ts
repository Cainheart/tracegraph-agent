import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDisposableFixtureWorkspace,
  removeControlledTemporaryDirectory,
} from "@tracegraph/core";

export const FAILING_TYPESCRIPT_FIXTURE_ROOT = fileURLToPath(
  new URL("../../../examples/failing-typescript-repo/", import.meta.url),
);

export function createSequentialIdFactory(seed = 0): (prefix: string) => string {
  let sequence = seed;
  return (prefix) => `${prefix}:${String(++sequence).padStart(6, "0")}`;
}

export async function createFailingTypescriptFixture(projectId = "fixture-project") {
  return createDisposableFixtureWorkspace({
    projectId,
    templateRoot: FAILING_TYPESCRIPT_FIXTURE_ROOT,
  });
}

export async function createTemporaryDataDir(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "tracegraph-data-"));
  return {
    path,
    async cleanup() {
      await removeControlledTemporaryDirectory(path);
    },
  };
}

export * from "./mock-provider.js";
