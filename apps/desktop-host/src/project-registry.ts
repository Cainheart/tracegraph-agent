import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import {
  IdentifierSchema,
  ProjectSummarySchema,
  WorkspaceHandleSchema,
  type ProjectSummary,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { createManagedWorkspaceHandle, createReadonlyWorkspaceHandle } from "@tracegraph/core";
import { z } from "zod";

export const DesktopProjectAccessSchema = z.enum(["read_write", "read_only"]);
export type DesktopProjectAccess = z.infer<typeof DesktopProjectAccessSchema>;

const PersistedProjectSchema = z.object({
  project_id: IdentifierSchema,
  label: z.string().min(1).max(120),
  real_root: z.string().min(1).max(4_096),
  access: DesktopProjectAccessSchema,
  root_device: z.string().min(1).max(64),
  root_inode: z.string().min(1).max(64),
}).strict();
type PersistedProject = z.infer<typeof PersistedProjectSchema>;

const RegistryFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(PersistedProjectSchema).max(128),
}).strict();

interface RegisteredDesktopProject {
  readonly record: PersistedProject;
  readonly workspace: WorkspaceHandle;
}

export class DesktopProjectRegistry {
  readonly #file: string;
  readonly #onWarning: (message: string) => void;
  readonly #projects = new Map<string, RegisteredDesktopProject>();
  #queue: Promise<void> = Promise.resolve();

  private constructor(file: string, onWarning: (message: string) => void) {
    this.#file = resolve(file);
    this.#onWarning = onWarning;
  }

  static async open(options: { file: string; onWarning?: (message: string) => void }): Promise<DesktopProjectRegistry> {
    const registry = new DesktopProjectRegistry(options.file, options.onWarning ?? (() => undefined));
    await registry.#load();
    return registry;
  }

  list(): ProjectSummary[] {
    return [...this.#projects.values()].map(({ record, workspace }) => summaryFor(record, workspace));
  }

  listWorkspaces(): WorkspaceHandle[] {
    return [...this.#projects.values()].map(({ workspace }) => workspace);
  }

  getWorkspace(projectId: string): WorkspaceHandle | undefined {
    return this.#projects.get(IdentifierSchema.parse(projectId))?.workspace;
  }

  async resolveRoot(projectIdInput: string): Promise<string> {
    const projectId = IdentifierSchema.parse(projectIdInput);
    const project = this.#projects.get(projectId);
    if (project === undefined) throw new Error("Project is not registered by this Desktop Host");
    await assertSameDirectoryIdentity(project.record);
    return project.record.real_root;
  }

  register(selectedPathInput: string, accessInput: DesktopProjectAccess): Promise<ProjectSummary> {
    return this.#serialize(() => this.#register(selectedPathInput, accessInput));
  }

  async #register(selectedPathInput: string, accessInput: DesktopProjectAccess): Promise<ProjectSummary> {
    const selectedPath = z.string().min(1).max(4_096).parse(selectedPathInput);
    const access = DesktopProjectAccessSchema.parse(accessInput);
    if (!isAbsolute(selectedPath) || selectedPath.includes("\u0000")) {
      throw new TypeError("A native absolute directory selection is required");
    }
    const realRoot = await realpath(resolve(selectedPath));
    const info = await stat(realRoot);
    assertSelectableDirectory(realRoot, info.isDirectory());
    const projectId = projectIdentity(realRoot, access);
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) {
      await assertSameDirectoryIdentity(existing.record);
      return summaryFor(existing.record, existing.workspace);
    }
    if (this.#projects.size >= 128) throw new RangeError("Desktop project registration limit reached");

    const record = PersistedProjectSchema.parse({
      project_id: projectId,
      label: projectLabel(realRoot, access),
      real_root: realRoot,
      access,
      root_device: String(info.dev),
      root_inode: String(info.ino),
    });
    const workspace = await workspaceFor(record);
    const nextProjects = [...this.#projects.values()].map(({ record: item }) => item).concat(record);
    await persistRegistry(this.#file, nextProjects);
    this.#projects.set(projectId, { record, workspace });
    return summaryFor(record, workspace);
  }

  unregister(projectIdInput: string): Promise<boolean> {
    return this.#serialize(() => this.#unregister(projectIdInput));
  }

  async #unregister(projectIdInput: string): Promise<boolean> {
    const projectId = IdentifierSchema.parse(projectIdInput);
    if (!this.#projects.has(projectId)) return false;
    const nextProjects = [...this.#projects.values()]
      .map(({ record }) => record)
      .filter((record) => record.project_id !== projectId);
    await persistRegistry(this.#file, nextProjects);
    this.#projects.delete(projectId);
    return true;
  }

  async #load(): Promise<void> {
    const registry = await readRegistry(this.#file);
    for (const record of registry.projects) {
      try {
        await assertSameDirectoryIdentity(record);
        if (this.#projects.has(record.project_id)) {
          this.#onWarning("Skipped duplicate Desktop project registration");
          continue;
        }
        const workspace = await workspaceFor(record);
        this.#projects.set(record.project_id, { record, workspace });
      } catch {
        this.#onWarning("Skipped an unavailable Desktop project; select its folder again to restore access");
      }
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function summaryFor(record: PersistedProject, workspace: WorkspaceHandle): ProjectSummary {
  return ProjectSummarySchema.parse({
    project_id: record.project_id,
    label: record.label,
    workspace_kind: workspace.workspace_kind,
    capabilities: workspace.capabilities,
    // The renderer needs an opaque identity and safe label, not the native path.
    location: {
      kind: "linked_directory",
      display_path: basename(record.real_root) || record.label,
      can_reveal: true,
      access: record.access,
    },
  });
}

async function workspaceFor(record: PersistedProject): Promise<WorkspaceHandle> {
  const input = { projectId: record.project_id, root: record.real_root };
  return WorkspaceHandleSchema.parse(record.access === "read_write"
    ? await createManagedWorkspaceHandle(input)
    : await createReadonlyWorkspaceHandle(input));
}

async function assertSameDirectoryIdentity(record: PersistedProject): Promise<void> {
  const currentRoot = await realpath(record.real_root);
  const info = await stat(currentRoot);
  if (currentRoot !== record.real_root
    || !info.isDirectory()
    || String(info.dev) !== record.root_device
    || String(info.ino) !== record.root_inode) {
    throw new Error("Registered Desktop project root is no longer available");
  }
}

function assertSelectableDirectory(root: string, isDirectory: boolean): void {
  if (!isDirectory) throw new TypeError("The selected item is not a directory");
  if (root === parse(root).root) throw new TypeError("Selecting the filesystem root is not allowed");
}

function projectIdentity(root: string, access: DesktopProjectAccess): string {
  const digest = createHash("sha256").update(`${access}\0${root}`).digest("hex").slice(0, 24);
  return IdentifierSchema.parse(`project:desktop:${digest}`);
}

function projectLabel(root: string, access: DesktopProjectAccess): string {
  const name = (basename(root) || "Local project")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 100) || "Local project";
  return access === "read_only" ? `${name} (read-only)` : name;
}

async function readRegistry(file: string): Promise<z.infer<typeof RegistryFileSchema>> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error("Desktop project registry must be a private regular file");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Desktop project registry has an unexpected owner");
    }
    const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let contents: string;
    try {
      const openedInfo = await handle.stat();
      if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
        throw new Error("Desktop project registry changed while opening");
      }
      contents = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    return RegistryFileSchema.parse(JSON.parse(contents));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 1, projects: [] };
    throw new Error("Desktop project registry is invalid or unavailable");
  }
}

async function persistRegistry(file: string, projects: readonly PersistedProject[]): Promise<void> {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Desktop project registry directory must be a real directory");
  }
  if (typeof process.getuid === "function" && parentInfo.uid !== process.getuid()) {
    throw new Error("Desktop project registry directory has an unexpected owner");
  }
  if ((parentInfo.mode & 0o077) !== 0) await chmod(parent, 0o700);
  const payload = RegistryFileSchema.parse({ version: 1, projects });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
