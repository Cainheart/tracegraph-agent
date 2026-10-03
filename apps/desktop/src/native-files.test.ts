import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openInConfiguredEditor, resolveProjectFileSelection } from "./native-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop native file selection", () => {
  it("opens only regular files whose canonical path remains inside the registered root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-desktop-files-"));
    roots.push(root);
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    const allowed = join(project, "README.md");
    const denied = join(outside, "secrets.txt");
    const escape = join(project, "outside.txt");
    await writeFile(allowed, "safe");
    await writeFile(denied, "no");
    await symlink(denied, escape);

    await expect(resolveProjectFileSelection(project, allowed)).resolves.toBe(await realpath(allowed));
    await expect(resolveProjectFileSelection(project, denied)).rejects.toThrow("outside the registered project");
    await expect(resolveProjectFileSelection(project, escape)).rejects.toThrow("outside the registered project");
    await expect(resolveProjectFileSelection(project, outside)).rejects.toThrow("regular file");
  });
  it("launches a configured executable with one literal file argument and no provider environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-editor-fixture-")); roots.push(root);
    const executable = join(root, "fixture-editor"), file = join(root, "literal $(name) file.txt"), receipt = join(root, "result.json");
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({argv:process.argv.slice(2),secret:process.env.OPENAI_API_KEY??null}));\n`); await chmod(executable, 0o700); await writeFile(file,"fixture");
    await openInConfiguredEditor(executable,file,{PATH:process.env.PATH,OPENAI_API_KEY:"synthetic-do-not-inherit"});
    await vi.waitFor(async()=>expect(JSON.parse(await readFile(receipt,"utf8"))).toEqual({argv:[file],secret:null}));
    await expect(openInConfiguredEditor(`${executable} --wait`,file)).rejects.toThrow();
    await expect(openInConfiguredEditor("missing-fixture-editor",file,{PATH:root})).rejects.toThrow();
  });
});
