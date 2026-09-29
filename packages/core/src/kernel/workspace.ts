import { cp, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  MANAGED_LOCAL_CAPABILITIES,
  READONLY_LOCAL_CAPABILITIES,
  WorkspaceHandleSchema,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { defaultIdFactory } from "./crypto.js";

export interface WorkspaceFactoryInput {
  projectId: string;
  root: string;
}

export async function createReadonlyWorkspaceHandle(
  input: WorkspaceFactoryInput,
): Promise<WorkspaceHandle> {
  const root = await requireDirectory(input.root);
  return WorkspaceHandleSchema.parse({
    handle_id: defaultIdFactory("workspace"),
    project_id: input.projectId,
    real_root: root,
    workspace_kind: "readonly_local",
    capabilities: READONLY_LOCAL_CAPABILITIES,
    created_at: new Date().toISOString(),
  });
}

export async function createManagedWorkspaceHandle(
  input: WorkspaceFactoryInput,
): Promise<WorkspaceHandle> {
  const root = await requireDirectory(input.root);
  return WorkspaceHandleSchema.parse({
    handle_id: defaultIdFactory("workspace"),
    project_id: input.projectId,
    real_root: root,
    workspace_kind: "managed_local",
    capabilities: MANAGED_LOCAL_CAPABILITIES,
    created_at: new Date().toISOString(),
  });
}

export async function createDisposableFixtureWorkspace(input: {
  projectId: string;
  templateRoot: string;
  parentDir?: string;
}): Promise<{ handle: WorkspaceHandle; cleanup(): Promise<void> }> {
  const templateRoot = await requireDirectory(input.templateRoot);
  const parentDir = input.parentDir === undefined
    ? tmpdir()
    : await requireDirectory(input.parentDir);
  const root = await mkdtemp(resolve(parentDir, "tracegraph-fixture-"));
  await cp(templateRoot, root, { recursive: true, force: false });
  const handle = WorkspaceHandleSchema.parse({
    handle_id: defaultIdFactory("workspace"),
    project_id: input.projectId,
    real_root: await realpath(root),
    workspace_kind: "disposable_fixture",
    capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
    created_at: new Date().toISOString(),
  });

  let cleaned = false;
  return {
    handle,
    async cleanup() {
      if (!cleaned) {
        cleaned = true;
        await removeControlledTemporaryDirectory(root);
      }
    },
  };
}

export async function removeControlledTemporaryDirectory(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    // Managed development hosts may intentionally block bulk deletion. These
    // are OS-created temporary directories, so leave them for host cleanup
    // instead of bypassing that safety policy.
    if (error instanceof Error && error.message.includes("SAFE_DELETE_BULK_CONFIRM_REQUIRED")) {
      return;
    }
    throw error;
  }
}

export async function resolveWorkspacePath(
  workspace: WorkspaceHandle,
  workspaceRelativePath: string,
): Promise<string> {
  if (isAbsolute(workspaceRelativePath)) {
    throw new WorkspaceBoundaryError("absolute paths are not allowed");
  }
  const candidate = resolve(workspace.real_root, workspaceRelativePath);
  assertInside(workspace.real_root, candidate);

  // The target exists for every P0 tool. Resolving it catches symlink escapes.
  const canonical = await realpath(candidate);
  assertInside(workspace.real_root, canonical);
  return canonical;
}

export function assertInside(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) {
    return;
  }
  throw new WorkspaceBoundaryError("path escapes the workspace capability root");
}

async function requireDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new WorkspaceBoundaryError(`${path} is not a directory`);
  }
  return canonical;
}

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

export function workspaceParent(path: string): string {
  return dirname(path);
}
