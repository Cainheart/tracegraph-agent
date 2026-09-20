import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalProjectRegistry } from "./project-registry.js";

describe("LocalProjectRegistry", () => {
  it("persists Host-selected directories and restores their access after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-local-registry-"));
    const projectRoot = join(root, "existing-project");
    const registryFile = join(root, "state", "local-projects.json");
    await mkdir(projectRoot);

    const first = await LocalProjectRegistry.open({ file: registryFile });
    const writable = await first.register(projectRoot, "read_write");
    expect(writable.workspace.capabilities.commit_patch).toBe(true);
    expect(writable.location).toEqual({
      kind: "linked_directory",
      display_path: await realpath(projectRoot),
      can_reveal: true,
      access: "read_write",
    });

    const restored = await LocalProjectRegistry.open({ file: registryFile });
    expect(restored.list()).toHaveLength(1);
    expect(restored.list()[0]).toMatchObject({
      label: "existing-project",
      workspace: {
        project_id: writable.workspace.project_id,
        capabilities: { commit_patch: true },
      },
    });
    expect((await stat(registryFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(registryFile, "utf8")).toContain(await realpath(projectRoot));
  });

  it("keeps read-only and read-write grants distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-local-access-"));
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const registry = await LocalProjectRegistry.open({
      file: join(root, "local-projects.json"),
    });

    const readonly = await registry.register(projectRoot, "read_only");
    const writable = await registry.register(projectRoot, "read_write");

    expect(readonly.workspace.project_id).not.toBe(writable.workspace.project_id);
    expect(readonly.workspace.capabilities.commit_patch).toBe(false);
    expect(writable.workspace.capabilities.commit_patch).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });

  it("unregisters a selected directory without deleting the directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-local-unregister-"));
    const projectRoot = join(root, "project");
    const registryFile = join(root, "local-projects.json");
    await mkdir(projectRoot);
    const registry = await LocalProjectRegistry.open({ file: registryFile });
    const project = await registry.register(projectRoot, "read_write");

    await expect(registry.unregister(project.workspace.project_id)).resolves.toBe(true);
    expect(registry.list()).toEqual([]);
    expect((await stat(projectRoot)).isDirectory()).toBe(true);
    const restored = await LocalProjectRegistry.open({ file: registryFile });
    expect(restored.list()).toEqual([]);
    await expect(registry.unregister(project.workspace.project_id)).resolves.toBe(false);
  });

  it("does not reactivate an unavailable directory from persisted state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-local-missing-"));
    const warnings: string[] = [];
    const registryFile = join(root, "local-projects.json");
    await mkdir(join(root, "project"));
    const first = await LocalProjectRegistry.open({ file: registryFile });
    await first.register(join(root, "project"), "read_only");

    const serialized = JSON.parse(await readFile(registryFile, "utf8")) as {
      projects: Array<{ real_root: string }>;
    };
    serialized.projects[0]!.real_root = join(root, "missing");
    await writeFile(registryFile, JSON.stringify(serialized), { mode: 0o600 });
    const restored = await LocalProjectRegistry.open({
      file: registryFile,
      onWarning: (message) => warnings.push(message),
    });
    expect(restored.list()).toEqual([]);
    expect(warnings.join("\n")).toContain("Skipped unavailable local project");
  });
});
