import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReadonlyWorkspaceHandle,
  removeControlledTemporaryDirectory,
  resolveWorkspacePath,
  WorkspaceBoundaryError,
} from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("Workspace capability boundary", () => {
  it("rejects traversal and absolute path access", async () => {
    const root = await temporaryRoot("workspace");
    const handle = await createReadonlyWorkspaceHandle({ projectId: "project:test", root });

    await expect(resolveWorkspacePath(handle, "../outside.txt")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
    await expect(resolveWorkspacePath(handle, "/etc/passwd")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
  });

  it("rejects a symlink that resolves outside the workspace root", async () => {
    const root = await temporaryRoot("workspace");
    const outside = await temporaryRoot("outside");
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "outside");
    await symlink(secret, join(root, "escaped.txt"));
    const handle = await createReadonlyWorkspaceHandle({ projectId: "project:test", root });

    await expect(resolveWorkspacePath(handle, "escaped.txt")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
  });
});

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-${name}-`));
  roots.push(root);
  return root;
}
