import { mkdtemp, readFile, rename, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopProjectRegistry } from "./project-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop Host project registry", () => {
  it("keeps an opaque Workspace handle behind safe metadata and persists only native grants", async () => {
    const base = await mkdtemp(join(tmpdir(), "tracegraph-desktop-projects-"));
    roots.push(base);
    const selected = join(base, "source-tree");
    await mkdir(selected);
    const canonicalSelected = await realpath(selected);
    const file = join(base, "host", "projects.json");
    const registry = await DesktopProjectRegistry.open({ file });

    const [first, duplicate] = await Promise.all([
      registry.register(selected, "read_write"),
      registry.register(selected, "read_write"),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.label).toBe(basename(selected));
    expect(first.location?.display_path).toBe(basename(selected));
    expect(JSON.stringify(first)).not.toContain(selected);
    expect(registry.getWorkspace(first.project_id)?.real_root).toBe(canonicalSelected);
    expect(JSON.stringify(first)).not.toContain(registry.getWorkspace(first.project_id)?.handle_id);

    const persisted = await readFile(file, "utf8");
    expect(persisted).toContain(canonicalSelected);
    expect(persisted).not.toContain("handle_id");

    const reopened = await DesktopProjectRegistry.open({ file });
    expect(reopened.list()).toEqual([first]);
    expect(await reopened.resolveRoot(first.project_id)).toBe(canonicalSelected);
    expect(await reopened.unregister(first.project_id)).toBe(true);
    expect(reopened.list()).toEqual([]);
    expect((await stat(selected)).isDirectory()).toBe(true);
  });

  it("rejects filesystem roots and drops registrations whose root identity changed", async () => {
    const base = await mkdtemp(join(tmpdir(), "tracegraph-desktop-stale-"));
    roots.push(base);
    const selected = join(base, "source-tree");
    await mkdir(selected);
    const file = join(base, "host", "projects.json");
    const registry = await DesktopProjectRegistry.open({ file });

    await expect(registry.register("/", "read_write")).rejects.toThrow("filesystem root");
    const project = await registry.register(selected, "read_write");
    const moved = join(base, "old-source-tree");
    await rename(selected, moved);
    await mkdir(selected);

    const warnings: string[] = [];
    const reopened = await DesktopProjectRegistry.open({ file, onWarning: (warning) => warnings.push(warning) });
    expect(reopened.list()).toEqual([]);
    expect(warnings).toContain("Skipped an unavailable Desktop project; select its folder again to restore access");
    await expect(reopened.resolveRoot(project.project_id)).rejects.toThrow("not registered");
  });
});
