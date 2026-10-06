import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { collectModuleGraph } from "./gen-module-graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_OUTPUTS = ["README.md", "events.md", "tools.md", "modules.md", "profiles.md", "catalog-manifest.json"].map((file) => `docs/generated/${file}`);
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const sort = (a, b) => a.localeCompare(b, "en");
const table = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

/** Deliberately accepts only the versioned literal-array grammar; never evaluates source code. */
function literalArray(source, declaration, label) {
  const match = declaration.exec(source);
  if (!match) throw new Error(`${label}: expected literal declaration; update generator for a new source grammar`);
  const end = source.indexOf("]", match.index + match[0].length);
  if (end < 0) throw new Error(`${label}: unterminated literal array`);
  const body = source.slice(match.index + match[0].length, end);
  if (!/^\s*(?:"[^"\\]*"\s*,?\s*)*$/u.test(body)) throw new Error(`${label}: unsupported non-literal source; refusing an incomplete catalog`);
  const values = JSON.parse(`[${body.replace(/,\s*$/u, "")}]`);
  if (!values.length || new Set(values).size !== values.length) throw new Error(`${label}: empty or duplicate entries`);
  return values.sort(sort);
}

/** Project only the supported literal definition/registration grammar, without evaluating tools. */
async function toolSources(names, registryFile, source) {
  const registry = await source(registryFile);
  const definitions = (text, file) => {
    const result = new Map();
    const patterns = [
      /^\s*(export\s+)?(?:const|let|var)\s+([\w$]+)(?:\s*:[^=;]+)?\s*=\s*\{\s*name:\s*"([^"\\]+)"/gmu,
      /^\s*(export\s+)?function\s+([\w$]+)\s*\([^;{]*\)\s*:\s*ToolDefinition[^;{]*\{\s*return\s*\{\s*name:\s*"([^"\\]+)"/gmu,
    ];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
      if (result.has(match[2])) throw new Error(`${file}: duplicate tool definition ${match[2]}`);
      result.set(match[2], { name: match[3], symbol: match[2], file, line: text.slice(0, match.index + match[0].indexOf(match[2])).split("\n").length, exported: Boolean(match[1]) });
    }
    return result;
  };
  const local = definitions(registry, registryFile);
  const imports = new Map();
  for (const match of registry.matchAll(/^import\s*\{([^}]+)\}\s*from\s*"(\.[^"\\]+)"\s*;/gmu)) {
    for (const item of match[1].split(",").map((value) => value.trim()).filter(Boolean)) {
      if (item.startsWith("type ")) continue;
      const binding = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/u.exec(item);
      if (!binding) throw new Error(`${registryFile}: unsupported named import ${item}`);
      imports.set(binding[2] ?? binding[1], { exported: binding[1], specifier: match[2] });
    }
  }
  const groups = new Map();
  for (const match of registry.matchAll(/^\s*function\s+([\w$]+)\s*\([^;{]*\)\s*:\s*readonly\s+ToolDefinition\[\]\s*\{\s*return\s*\[([^\]]*)\]\s*;/gmu)) {
    groups.set(match[1], { body: match[2], offset: match.index + match[0].lastIndexOf("[") + 1 });
  }
  function entries(body, offset) {
    const result = [];
    const entry = /\s*(?:\.\.\.)?([\w$]+)(\.get\("[^"\\]+"\)!|\((?:[^()"']|"[^"\\]*"|'[^'\\]*')*\))?\s*(,|$)/uy;
    let cursor = 0;
    while (cursor < body.length && body.slice(cursor).trim()) {
      entry.lastIndex = cursor;
      const match = entry.exec(body);
      if (!match || entry.lastIndex <= cursor) throw new Error(`${registryFile}: unsupported tool registration; refusing an incomplete catalog`);
      // get() is a lookup of an already registered definition, not an admission fact.
      if (!match[2]?.startsWith(".get")) result.push({ symbol: match[1], line: registry.slice(0, offset + match.index + match[0].indexOf(match[1])).split("\n").length });
      cursor = entry.lastIndex;
    }
    return result;
  }
  const registered = new Map();
  const active = new Set();
  async function visit(entry) {
    if (groups.has(entry.symbol)) {
      if (active.has(entry.symbol)) throw new Error(`${registryFile}: recursive tool registration group ${entry.symbol}`);
      active.add(entry.symbol);
      const group = groups.get(entry.symbol);
      for (const child of entries(group.body, group.offset)) await visit(child);
      active.delete(entry.symbol);
      return;
    }
    let definition = local.get(entry.symbol);
    if (!definition && imports.has(entry.symbol)) {
      const imported = imports.get(entry.symbol);
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(registryFile), imported.specifier)).replace(/\.js$/u, ".ts");
      if (!file.startsWith("packages/core/src/") || !file.endsWith(".ts")) throw new Error(`${registryFile}: unsupported tool definition module ${file}`);
      definition = definitions(await source(file), file).get(imported.exported);
      if (!definition?.exported) throw new Error(`Registered tool ${entry.symbol} has no exported literal tool definition in ${file}`);
    }
    if (!definition) throw new Error(`Registered tool ${entry.symbol} has no literal tool definition`);
    const previous = registered.get(definition.name);
    if (previous && (previous.file !== definition.file || previous.symbol !== definition.symbol)) throw new Error(`Built-in ${definition.name} has ambiguous registered definitions`);
    registered.set(definition.name, { ...definition, registration_file: registryFile, registration_line: entry.line });
  }
  let arrays = 0;
  for (const match of registry.matchAll(/new\s+ToolRegistry\s*\(\s*\[([^\]]*)\]\s*\)/gu)) {
    arrays += 1;
    for (const entry of entries(match[1], match.index + match[0].indexOf("[") + 1)) await visit(entry);
  }
  if (!arrays) throw new Error(`${registryFile}: no literal ToolRegistry registration`);
  for (const name of names) if (!registered.has(name)) throw new Error(`Built-in ${name} has no registered literal tool definition`);
  return names.map((name) => registered.get(name));
}

export async function referenceCatalogContents(root = ROOT) {
  const inputs = new Map();
  async function source(file) {
    if (!inputs.has(file)) inputs.set(file, await readFile(path.join(root, file), "utf8"));
    return inputs.get(file);
  }
  const eventFile = "packages/contracts/src/event.ts";
  const toolFile = "packages/contracts/src/action.ts";
  const registryFile = "packages/core/src/domains/tools/registry.ts";
  const events = literalArray(await source(eventFile), /export const EventTypeSchema\s*=\s*z\.enum\(\[/u, "EventTypeSchema");
  const tools = literalArray(await source(toolFile), /export const BUILTIN_TOOL_NAMES\s*=\s*\[/u, "BUILTIN_TOOL_NAMES");
  const toolDefinitions = await toolSources(tools, registryFile, source);
  const graph = await collectModuleGraph(root);
  const policy = parse(await source("architecture-policy.yaml"), { uniqueKeys: true, maxAliasCount: 100 });
  const policies = new Map((policy.packages ?? []).map((item) => [item.name, item]));
  await source("pnpm-workspace.yaml");
  for (const item of graph.packages) {
    await source(`${item.directory}/package.json`);
    if (!policies.has(item.name)) throw new Error(`Workspace package ${item.name} is missing from architecture-policy.yaml`);
  }
  for (const item of graph.modules) await source(item.id);
  const profileFiles = graph.modules.map((item) => item.id).filter((file) => /\/profiles\/.*\.ts$/u.test(file) && !/\.test\.ts$/u.test(file));
  if (!profileFiles.length) throw new Error("No versioned entry profiles found");
  const digests = Object.fromEntries([...inputs.entries()].sort(([a], [b]) => sort(a, b)).map(([file, content]) => [file, sha(content)]));
  const sourceDigest = sha(JSON.stringify(digests));
  const generatorDigest = sha(await readFile(fileURLToPath(import.meta.url), "utf8"));
  const header = (title) => ["<!-- Generated by node scripts/gen-reference-catalogs.mjs --write. Do not edit. -->", "", `# ${title}`, "", `Source set: \`${sourceDigest}\`. Generator: \`${generatorDigest}\`.`, "", "See [input manifest](catalog-manifest.json) for exact source hashes.", ""];
  const output = new Map();
  const eventLines = [...header("Event catalog"), `Canonical enum: [EventTypeSchema](../../${eventFile}). ${events.length} declared event types.`, "", "| Event | Namespace |", "| --- | --- |"];
  for (const event of events) eventLines.push(`| \`${event}\` | \`${event.split(".")[0]}\` |`);
  output.set(CATALOG_OUTPUTS[1], `${eventLines.join("\n")}\n`);
  const toolLines = [...header("Built-in tool catalog"), `Canonical names: [BUILTIN_TOOL_NAMES](../../${toolFile}); registration: [registry](../../${registryFile}).`, "", "Definition sources are resolved from the registry's literal registrations and named local imports. This static inventory does not enumerate dynamic MCP servers or extension registrations and does not imply that a tool is authorized in every profile.", "", "| Tool | Definition source | Registration source |", "| --- | --- | --- |"];
  for (const tool of toolDefinitions) toolLines.push(`| \`${tool.name}\` | [${path.posix.basename(tool.file)}](../../${tool.file}#L${tool.line}) | [registry](../../${tool.registration_file}#L${tool.registration_line}) |`);
  output.set(CATALOG_OUTPUTS[2], `${toolLines.join("\n")}\n`);
  const moduleLines = [...header("Module catalog"), "Workspace inventory comes from package manifests and source files; governance comes from [architecture policy](../../architecture-policy.yaml).", "", "| Package | Governance | Public exports | Source modules |", "| --- | --- | --- | --- |"];
  for (const item of graph.packages) moduleLines.push(`| \`${item.name}\` | ${table(policies.get(item.name).governance)} | ${Object.keys(item.manifest.exports ?? {}).sort(sort).map((key) => `\`${key}\``).join(", ") || "none"} | ${graph.modules.filter((module) => module.package === item.name).length} |`);
  moduleLines.push("", "## Source inventory", "", "| Package | Module |", "| --- | --- |");
  for (const item of graph.modules) moduleLines.push(`| \`${item.package}\` | [${item.id}](../../${item.id}) |`);
  output.set(CATALOG_OUTPUTS[3], `${moduleLines.join("\n")}\n`);
  const profileLines = [...header("Entry profile catalog"), "Profiles are reproduced from versioned source under workspace `src/profiles/`. No profile is invented for an app without a profile declaration. This is not a machine-specific resolved configuration or a claim of a universal cross-app profile schema.", ""];
  for (const file of profileFiles.sort(sort)) profileLines.push(`## ${file}`, "", `[Source](../../${file}) · \`${digests[file]}\``, "", "```typescript", (await source(file)).trimEnd(), "```", "");
  output.set(CATALOG_OUTPUTS[4], `${profileLines.join("\n")}\n`);
  const index = [...header("Generated reference catalogs"), "All catalogs are deterministic source projections. Regenerate with `node scripts/gen-reference-catalogs.mjs --write`; verify every owned output with `node scripts/gen-reference-catalogs.mjs --check`.", "", `- [Events](events.md): ${events.length} enum members.`, `- [Built-in tools](tools.md): ${tools.length} declared names.`, `- [Modules](modules.md): ${graph.packages.length} packages and ${graph.modules.length} source files.`, `- [Profiles](profiles.md): ${profileFiles.length} versioned profile source files.`, "", "[Package/module graph](module-graph.md) and [current baseline](current-baseline.md) have their own existing generators and check commands. Generated catalogs do not certify translation review, external quality, or production deployment.", ""];
  output.set(CATALOG_OUTPUTS[0], `${index.join("\n")}\n`);
  output.set(CATALOG_OUTPUTS[5], `${JSON.stringify({ schema_version: 1, generator: "scripts/gen-reference-catalogs.mjs", generator_digest: generatorDigest, source_digest: sourceDigest, inputs: digests, tool_definitions: toolDefinitions.map(({ exported, ...definition }) => definition), outputs: CATALOG_OUTPUTS, counts: { events: events.length, tools: tools.length, packages: graph.packages.length, modules: graph.modules.length, profiles: profileFiles.length } }, null, 2)}\n`);
  return output;
}

export async function generateReferenceCatalogs(root = ROOT, check = false) {
  const expected = await referenceCatalogContents(root);
  const stale = [];
  for (const [file, content] of expected) {
    let current;
    try { current = await readFile(path.join(root, file), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current !== content) stale.push(file);
  }
  if (check && stale.length) throw new Error(`Stale generated catalogs:\n${stale.map((file) => `- ${file}`).join("\n")}\nRun node scripts/gen-reference-catalogs.mjs --write.`);
  if (!check) for (const file of stale) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), expected.get(file));
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !["--check", "--write"].includes(args[0])) throw new Error("Usage: node scripts/gen-reference-catalogs.mjs --write|--check");
    const changed = await generateReferenceCatalogs(ROOT, args[0] === "--check");
    console.log(args[0] === "--check" ? "All reference catalogs are current." : `Generated ${changed.length} reference files.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
