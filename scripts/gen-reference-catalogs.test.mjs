import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CATALOG_OUTPUTS, generateReferenceCatalogs, referenceCatalogContents } from "./gen-reference-catalogs.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reference-catalogs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(file, content) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  await put("pnpm-workspace.yaml", "packages: [packages/*, apps/*]\n");
  await put("architecture-policy.yaml", "version: 2\npackages:\n  - {name: '@test/contracts', governance: managed}\n  - {name: '@test/core', governance: managed}\n  - {name: '@test/cli', governance: managed}\n");
  for (const [directory, name] of [["packages/contracts", "@test/contracts"], ["packages/core", "@test/core"], ["apps/cli", "@test/cli"]]) await put(`${directory}/package.json`, JSON.stringify({ name, exports: { ".": "./dist/index.js" } }));
  await put("packages/contracts/src/event.ts", 'export const EventTypeSchema = z.enum(["run.created", "run.completed"]);\n');
  await put("packages/contracts/src/action.ts", 'export const BUILTIN_TOOL_NAMES = ["read_file"] as const;\n');
  await put("packages/core/src/domains/tools/registry.ts", 'const tool = { name: "read_file" };\nexport function registry() { return new ToolRegistry([tool]); }\n');
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
  await assert.rejects(generateReferenceCatalogs(root), /no literal ToolRegistry registration/u);
  await put("packages/core/src/domains/tools/registry.ts", 'const tool = { name: "read_file" };\nexport function registry() { return new ToolRegistry([tool]); }\n');
  await put("packages/contracts/src/event.ts", 'export const EventTypeSchema = z.enum(["run.created", ...extra]);\n');
  await assert.rejects(generateReferenceCatalogs(root), /unsupported non-literal/u);
  await put("packages/contracts/src/event.ts", 'export const EventTypeSchema = z.enum(["run.created"]);\n');
  await put("packages/new/package.json", '{"name":"@test/new"}');
  await assert.rejects(generateReferenceCatalogs(root), /missing from architecture-policy/u);
});

test("links imported registered definitions and hashes the actual module without evaluating tools", async (t) => {
  const { root, put } = await fixture(t);
  const module = "packages/core/src/domains/tools/project-commands.ts";
  const definitions = 'throw new Error("A static catalog must never execute this module");\nexport const discovery: ToolDefinition<Input> = { name: "discover_project_commands" };\nexport const execution: ToolDefinition<Input> = { name: "run_project_command" };\n';
  await put(module, definitions);
  await put("packages/contracts/src/action.ts", 'export const BUILTIN_TOOL_NAMES = ["read_file", "discover_project_commands", "run_project_command"] as const;\n');
  await put("packages/core/src/domains/tools/registry.ts", 'import { discovery as importedDiscovery, execution } from "./project-commands.js";\nconst tool = { name: "read_file" };\nexport function registry() { return new ToolRegistry([tool, importedDiscovery, execution]); }\n');
  const contents = await referenceCatalogContents(root);
  assert.match(contents.get("docs/generated/tools.md"), /\| `discover_project_commands` \| \[project-commands.ts\]\(\.\.\/\.\.\/packages\/core\/src\/domains\/tools\/project-commands.ts#L2\)/u);
  const manifest = JSON.parse(contents.get("docs/generated/catalog-manifest.json"));
  assert.match(manifest.inputs[module], /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(manifest.tool_definitions.find((value) => value.name === "discover_project_commands"), { name: "discover_project_commands", symbol: "discovery", file: module, line: 2, registration_file: "packages/core/src/domains/tools/registry.ts", registration_line: 3 });
  await generateReferenceCatalogs(root);
  await put(module, `${definitions}// real implementation changed\n`);
  await assert.rejects(generateReferenceCatalogs(root, true), /tools.md/u);
});

test("follows literal factory groups and function tool definitions", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/core/src/domains/tools/registry.ts", 'function readFile(): ToolDefinition<Input> { return { name: "read_file" }; }\nfunction tools(): readonly ToolDefinition[] { return [readFile()]; }\nexport function registry() { return new ToolRegistry([...tools()]); }\n');
  const contents = await referenceCatalogContents(root);
  const definition = JSON.parse(contents.get("docs/generated/catalog-manifest.json")).tool_definitions[0];
  assert.equal(definition.symbol, "readFile");
  assert.equal(definition.registration_line, 2);
});

test("rejects missing imports, defined-but-unregistered tools, and get lookups masquerading as registration", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/contracts/src/action.ts", 'export const BUILTIN_TOOL_NAMES = ["read_file", "run_project_command"] as const;\n');
  const inline = 'const tool = { name: "read_file" };\n';
  await put("packages/core/src/domains/tools/project-commands.ts", 'export const execution: ToolDefinition<Input> = { name: "run_project_command" };\n');
  await put("packages/core/src/domains/tools/registry.ts", `import { execution } from "./project-commands.js";\n${inline}export function registry() { return new ToolRegistry([tool]); }\n`);
  await assert.rejects(generateReferenceCatalogs(root), /run_project_command has no registered literal tool definition/u);
  await put("packages/core/src/domains/tools/registry.ts", `${inline}const execution = { name: "run_project_command" };\nexport function registry() { return new ToolRegistry([tool, core.get("run_project_command")!]); }\n`);
  await assert.rejects(generateReferenceCatalogs(root), /run_project_command has no registered literal tool definition/u);
  await put("packages/core/src/domains/tools/registry.ts", `${inline}export function registry() { return new ToolRegistry([tool, execution]); }\n`);
  await assert.rejects(generateReferenceCatalogs(root), /execution has no literal tool definition/u);
  await put("packages/core/src/domains/tools/registry.ts", `import { execution } from "./project-commands.js";\n${inline}export function registry() { return new ToolRegistry([tool, execution]); }\n`);
  await put("packages/core/src/domains/tools/project-commands.ts", '// name: "run_project_command" is not a definition\nexport const execution = makeTool();\n');
  await assert.rejects(generateReferenceCatalogs(root), /execution has no exported literal tool definition/u);
});
