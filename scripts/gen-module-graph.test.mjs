import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectModuleGraph, generateModuleGraph } from "./gen-module-graph.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "tracegraph-module-graph-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  for (const [name, body] of [["a", 'import { value } from "./value.js";\nexport { value };\n'], ["b", 'import { value } from "@tracegraph/a";\nexport const result = value;\n']]) {
    const directory = path.join(root, "packages", name);
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: `@tracegraph/${name}`, exports: { ".": "./dist/index.js" }, ...(name === "b" ? { dependencies: { "@tracegraph/a": "workspace:*" } } : {}) }));
    await writeFile(path.join(directory, "src", "index.ts"), body);
  }
  await writeFile(path.join(root, "packages/a/src/value.ts"), "export const value = 7;\n");
  return root;
}

test("collects package dependencies and resolvable module imports", async (context) => {
  const root = await fixture(context);
  const graph = await collectModuleGraph(root);
  assert.deepEqual(graph.packages.map(({ name }) => name), ["@tracegraph/a", "@tracegraph/b"]);
  assert.deepEqual(graph.edges, [
    ["packages/a/src/index.ts", "packages/a/src/value.ts"],
    ["packages/b/src/index.ts", "packages/a/src/index.ts"],
  ]);
});

test("--check accepts a fresh graph and fails when a package or module is added", async (context) => {
  const root = await fixture(context);
  await generateModuleGraph(root);
  assert.equal(await generateModuleGraph(root, true), false);
  await writeFile(path.join(root, "packages/a/src/extra.ts"), "export const extra = true;\n");
  await assert.rejects(generateModuleGraph(root, true), /module-graph\.md is stale/u);
  await generateModuleGraph(root);
  assert.match(await readFile(path.join(root, "docs/generated/module-graph.md"), "utf8"), /packages\/a\/src\/extra\.ts/u);
  await mkdir(path.join(root, "packages/c/src"), { recursive: true });
  await writeFile(path.join(root, "packages/c/package.json"), JSON.stringify({ name: "@tracegraph/c" }));
  await writeFile(path.join(root, "packages/c/src/index.ts"), "export {};\n");
  await assert.rejects(generateModuleGraph(root, true), /module-graph\.md is stale/u);
});

test("CI checks the generated graph for drift", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/ci.yml"), "utf8");
  assert.equal(hasGraphCheck(workflow), true);
  assert.equal(hasGraphCheck(workflow.replace(/^\s*- run: pnpm graph:modules:check\s*$/mu, "")), false);
});

function hasGraphCheck(workflow) {
  return /^\s*- run: pnpm graph:modules:check\s*$/mu.test(workflow);
}
