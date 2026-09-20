import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, parse, resolve } from "node:path";
import {
  createManagedWorkspaceHandle,
  createReadonlyWorkspaceHandle,
} from "@tracegraph/core";
import type { RegisteredProject } from "@tracegraph/host";

export type LocalProjectAccess = "read_write" | "read_only";

interface PersistedLocalProject {
  project_id: string;
  label: string;
  real_root: string;
  access: LocalProjectAccess;
}

interface LocalProjectRegistryFile {
  version: 1;
  projects: PersistedLocalProject[];
}

export interface LocalProjectRegistryOptions {
  file: string;
  onWarning?: (message: string) => void;
}

const execFileAsync = promisify(execFile);

/**
 * Host-owned registry for folders selected through the native picker. The
 * browser never supplies `real_root`; it only receives an informational path
 * after the Host has canonicalized and registered the directory.
 */
export class LocalProjectRegistry {
  readonly #file: string;
  readonly #onWarning: (message: string) => void;
  readonly #records = new Map<string, PersistedLocalProject>();
  readonly #projects = new Map<string, RegisteredProject>();

  private constructor(options: LocalProjectRegistryOptions) {
    this.#file = resolve(options.file);
    this.#onWarning = options.onWarning ?? (() => undefined);
  }

  static async open(options: LocalProjectRegistryOptions): Promise<LocalProjectRegistry> {
    const registry = new LocalProjectRegistry(options);
    await registry.#load();
    return registry;
  }

  list(): RegisteredProject[] {
    return [...this.#projects.values()];
  }

  /** Remove a selected directory from the registry without touching it. */
  async unregister(projectId: string): Promise<boolean> {
    const record = this.#records.get(projectId);
    if (!record) return false;
    const nextRecords = [...this.#records.values()].filter((candidate) => candidate.project_id !== projectId);
    await persistRegistry(this.#file, nextRecords);
    this.#records.delete(projectId);
    this.#projects.delete(projectId);
    return true;
  }

  async register(selectedRoot: string, access: LocalProjectAccess): Promise<RegisteredProject> {
    const canonicalRoot = await requireSafeDirectory(selectedRoot);
    const existingRecord = [...this.#records.values()].find(
      (record) => record.real_root === canonicalRoot && record.access === access,
    );
    if (existingRecord) {
      const existingProject = this.#projects.get(existingRecord.project_id);
      if (existingProject) return existingProject;
    }

    const projectId = existingRecord?.project_id ?? localProjectId(canonicalRoot, access);
    const record: PersistedLocalProject = existingRecord ?? {
      project_id: projectId,
      label: access === "read_only"
        ? `${basename(canonicalRoot) || canonicalRoot} (read-only)`
        : basename(canonicalRoot) || canonicalRoot,
      real_root: canonicalRoot,
      access,
    };
    const project = await projectFromRecord(record);
    const nextRecords = new Map(this.#records);
    nextRecords.set(record.project_id, record);
    await persistRegistry(this.#file, [...nextRecords.values()]);
    this.#records.set(record.project_id, record);
    this.#projects.set(record.project_id, project);
    return project;
  }

  async #load(): Promise<void> {
    const value = await readRegistryFile(this.#file, this.#onWarning);
    for (const record of value.projects) {
      try {
        const project = await projectFromRecord(record);
        if (this.#records.has(record.project_id)) {
          this.#onWarning(`Skipped duplicate local project id ${record.project_id}`);
          continue;
        }
        this.#records.set(record.project_id, record);
        this.#projects.set(record.project_id, project);
      } catch (error) {
        this.#onWarning(`Skipped unavailable local project ${record.label}: ${publicError(error)}`);
      }
    }
  }
}

export async function selectLocalDirectory(access: LocalProjectAccess): Promise<string | undefined> {
  const prompt = access === "read_write"
    ? "Choose a folder and grant TraceGraph read-write access (writes still require approval)"
    : "Choose a folder and grant TraceGraph read-only access";
  if (process.platform === "darwin") {
    const script = [
      "try",
      `set selectedFolder to choose folder with prompt ${appleScriptString(prompt)}`,
      "return POSIX path of selectedFolder",
      "on error number -128",
      "return \"\"",
      "end try",
    ].join("\n");
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 5 * 60_000,
      maxBuffer: 16 * 1024,
    });
    return stdout.trim() || undefined;
  }

  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("zenity", [
        "--file-selection",
        "--directory",
        `--title=${prompt}`,
      ], { timeout: 5 * 60_000, maxBuffer: 16 * 1024 });
      return stdout.trim() || undefined;
    } catch (error) {
      if (exitCode(error) === 1) return undefined;
      throw error;
    }
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = '${prompt.replaceAll("'", "''")}'`,
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      script,
    ], { timeout: 5 * 60_000, maxBuffer: 16 * 1024 });
    return stdout.trim() || undefined;
  }

  throw new Error(`Native directory selection is unavailable on ${process.platform}`);
}

export async function revealLocalDirectory(root: string): Promise<void> {
  const canonicalRoot = await requireSafeDirectory(root);
  if (process.platform === "darwin") {
    await execFileAsync("open", [canonicalRoot], { timeout: 30_000 });
    return;
  }
  if (process.platform === "linux") {
    await execFileAsync("xdg-open", [canonicalRoot], { timeout: 30_000 });
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("explorer.exe", [canonicalRoot], { timeout: 30_000 });
    return;
  }
  throw new Error(`Revealing directories is unavailable on ${process.platform}`);
}

async function projectFromRecord(record: PersistedLocalProject): Promise<RegisteredProject> {
  const workspace = record.access === "read_write"
    ? await createManagedWorkspaceHandle({ projectId: record.project_id, root: record.real_root })
    : await createReadonlyWorkspaceHandle({ projectId: record.project_id, root: record.real_root });
  return {
    label: record.label,
    workspace,
    location: {
      kind: "linked_directory",
      display_path: workspace.real_root,
      can_reveal: true,
      access: record.access,
    },
  };
}

async function readRegistryFile(
  file: string,
  onWarning: (message: string) => void,
): Promise<LocalProjectRegistryFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      throw new TypeError("registry must contain version=1 and a projects array");
    }
    const projects = parsed.projects.flatMap((candidate) => {
      const record = parsePersistedProject(candidate);
      if (record) return [record];
      onWarning("Skipped malformed local project registry entry");
      return [];
    });
    return { version: 1, projects };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 1, projects: [] };
    onWarning(`Could not load local project registry: ${publicError(error)}`);
    return { version: 1, projects: [] };
  }
}

async function persistRegistry(file: string, projects: PersistedLocalProject[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

async function requireSafeDirectory(value: string): Promise<string> {
  const canonicalRoot = await realpath(value);
  const info = await stat(canonicalRoot);
  if (!info.isDirectory()) throw new TypeError("Selected path is not a directory");
  if (canonicalRoot === parse(canonicalRoot).root) {
    throw new TypeError("Selecting the filesystem root is not allowed");
  }
  return canonicalRoot;
}

function localProjectId(root: string, access: LocalProjectAccess): string {
  const digest = createHash("sha256").update(`${access}\0${root}`).digest("hex").slice(0, 16);
  return `project:local:${digest}`;
}

function parsePersistedProject(value: unknown): PersistedLocalProject | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.project_id !== "string"
    || typeof value.label !== "string"
    || typeof value.real_root !== "string"
    || (value.access !== "read_write" && value.access !== "read_only")
  ) return undefined;
  return {
    project_id: value.project_id,
    label: value.label,
    real_root: value.real_root,
    access: value.access,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function exitCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.code === "number" ? value.code : undefined;
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
