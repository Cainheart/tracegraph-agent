import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CATALOG_OUTPUTS, generateReferenceCatalogs } from "./gen-reference-catalogs.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reference-catalogs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(file, content) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  await put("pnpm-workspace.yaml", "packages: [packages/*, apps/*]\n");
  await put("architecture-policy.yaml", "version: 2\npackages:\n  - {name: '@test/contracts', governance: managed}\n  - {name: '@test/core', governance: managed}\n  - {name: '@test/cli', governance: managed}\n");
  for (const [directory, name] of [["packages/contracts", "@test/contracts"], ["packages/core", "@test/core"], ["apps/cli", "@test/cli"]]) await put(`${directory}/package.json`, JSON.stringify({ name, exports: { ".": "./dist/index.js" } }));
  await put("packages/contracts/src/event.ts", 'export const EventTypeSchema = z.enum(["run.created", "run.completed"]);\n');
  await put("packages/contracts/src/action.ts", 'export const BUILTIN_TOOL_NAMES = ["read_file"] as const;\n');
  await put("packages/core/src/domains/tools/registry.ts", 'const tool = { name: "read_file" };\n');
  await put("apps/cli/src/profiles/cli.ts", 'export const CLI_PROFILE = { profile_id: "test.cli", revision: 1 } as const;\n');
  return { root, put };
}

test("deterministically generates all four catalogs and check mode is read-only", async (t) => {
  const { root } = await fixture(t);
  assert.equal((await generateReferenceCatalogs(root)).length, CATALOG_OUTPUTS.length);
  const before = await Promise.all(CATALOG_OUTPUTS.map((file) => readFile(path.join(root, file), "utf8")));
  assert.deepEqual(await generateReferenceCatalogs(root, true), []);
  assert.deepEqual(await generateReferenceCatalogs(root), []);
  assert.deepEqual(await Promise.all(CATALOG_OUTPUTS.map((file) => readFile(path.join(root, file), "utf8"))), before);
  assert.match(before[1], /run.completed/u);
  assert.match(before[2], /read_file/u);
  assert.match(before[3], /@test\/cli/u);
  assert.match(before[4], /test.cli/u);
});

test("reports every stale or deleted owned output without repairing it", async (t) => {
  const { root, put } = await fixture(t);
  await generateReferenceCatalogs(root);
  for (const file of CATALOG_OUTPUTS) await put(file, "tampered\n");
  await rm(path.join(root, CATALOG_OUTPUTS[1]));
  await assert.rejects(generateReferenceCatalogs(root, true), (error) => CATALOG_OUTPUTS.every((file) => error.message.includes(file)));
  assert.equal(await readFile(path.join(root, CATALOG_OUTPUTS[2]), "utf8"), "tampered\n");
});

test("source changes and newly added modules invalidate the catalogs", async (t) => {
  const { root, put } = await fixture(t);
  await generateReferenceCatalogs(root);
  await put("packages/contracts/src/event.ts", 'export const EventTypeSchema = z.enum(["run.created", "run.completed", "run.failed"]);\n');
  await put("apps/cli/src/new-module.ts", "export const added = true;\n");
  await assert.rejects(generateReferenceCatalogs(root, true), /events.md/u);
  await generateReferenceCatalogs(root);
  assert.match(await readFile(path.join(root, "docs/generated/events.md"), "utf8"), /run.failed/u);
  assert.match(await readFile(path.join(root, "docs/generated/modules.md"), "utf8"), /new-module.ts/u);
});

test("fails closed for missing definitions, unsupported enum expressions and unregistered packages", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/core/src/domains/tools/registry.ts", "// no tool definition\n");
  await assert.rejects(generateReferenceCatalogs(root), /no literal registry definition/u);
  await put("packages/core/src/domains/tools/registry.ts", 'const tool = { name: "read_file" };\n');
  await put("packages/contracts/src/event.ts", 'export const EventTypeSchema = z.enum(["run.created", ...extra]);\n');
  await assert.rejects(generateReferenceCatalogs(root), /unsupported non-literal/u);
  await put("packages/contracts/src/event.ts", 'export const EventTypeSchema = z.enum(["run.created"]);\n');
  await put("packages/new/package.json", '{"name":"@test/new"}');
  await assert.rejects(generateReferenceCatalogs(root), /missing from architecture-policy/u);
});
