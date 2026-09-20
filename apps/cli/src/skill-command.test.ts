import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSkillsCommand } from "./skill-command.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  process.exitCode = 0;
});

describe("skills CLI command", () => {
  it("lists metadata, conflicts, and diagnostics without exposing the body", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "tracegraph-skills-cli-"));
    roots.push(root);
    const projectRoot = resolve(root, "project");
    const userRoot = resolve(root, "user");
    await mkdir(resolve(projectRoot, ".tracegraph", "skills", "review"), { recursive: true });
    await mkdir(resolve(userRoot, "review"), { recursive: true });
    await writeFile(resolve(projectRoot, ".tracegraph", "skills", "review", "SKILL.md"), [
      "---", "name: review", "description: Project review", "version: 1.0.0", "allowed_tools: [read_file]", "---",
      "SECRET BODY MUST NOT BE IN CLI CATALOG",
    ].join("\n"));
    await writeFile(resolve(userRoot, "review", "SKILL.md"), [
      "---", "name: review", "description: User review", "version: 0.9.0", "---", "User body",
    ].join("\n"));

    let output = "";
    await runSkillsCommand(["list"], {
      cwd: projectRoot,
      environment: { TRACEGRAPH_SKILLS_ROOT: userRoot },
      write: (value) => { output += value; },
    });
    const parsed = JSON.parse(output) as { skills: Array<{ name: string; source: string }>; conflicts: unknown[] };
    expect(parsed.skills).toEqual([{ name: "review", description: "Project review", version: "1.0.0", allowed_tools: ["read_file"], source: "project" }]);
    expect(parsed.conflicts).toHaveLength(1);
    expect(output).not.toContain("SECRET BODY");
  });

  it("returns a non-zero exit code only for validate diagnostics", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "tracegraph-skills-validate-"));
    roots.push(root);
    const projectRoot = resolve(root, "project");
    const userRoot = resolve(root, "user");
    await mkdir(resolve(projectRoot, ".tracegraph", "skills", "broken"), { recursive: true });
    await writeFile(resolve(projectRoot, ".tracegraph", "skills", "broken", "SKILL.md"), "name: broken\n");
    let output = "";
    await runSkillsCommand(["validate"], {
      cwd: projectRoot,
      environment: { TRACEGRAPH_SKILLS_ROOT: userRoot },
      write: (value) => { output += value; },
    });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ diagnostics: [{ code: "missing_frontmatter" }] });
  });
});
