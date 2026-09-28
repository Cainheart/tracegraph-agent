import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = "docs/generated/module-graph.md";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".turbo", ".vite"]);

const posix = (value) => value.split(path.sep).join("/");
const sort = (a, b) => a.localeCompare(b, "en");

async function walk(directory, relative = "") {
  let entries;
  try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => sort(a.name, b.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) files.push(...await walk(directory, child));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      files.push(child);
    }
  }
  return files;
}

async function collectPackages(root) {
  const workspace = parse(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"), { uniqueKeys: true });
  const packages = [];
  for (const pattern of workspace.packages ?? []) {
    if (typeof pattern !== "string" || !/^[^!*?]+\/\*$/u.test(pattern)) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parent = path.join(root, pattern.slice(0, -2));
    for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) => sort(a.name, b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(parent, entry.name);
      const manifestPath = path.join(directory, "package.json");
      try {
        const stat = await lstat(manifestPath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
      } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const dependencies = new Set();
      for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(manifest[section] ?? {})) {
          if (typeof version === "string" && version.startsWith("workspace:")) dependencies.add(name);
        }
      }
      packages.push({ name: manifest.name, directory: posix(path.relative(root, directory)), dependencies: [...dependencies].sort(sort), manifest });
    }
  }
  packages.sort((a, b) => sort(a.name, b.name));
  if (new Set(packages.map((item) => item.name)).size !== packages.length) throw new Error("Workspace package names must be unique");
  const known = new Set(packages.map((item) => item.name));
  for (const item of packages) for (const dep of item.dependencies) if (!known.has(dep)) throw new Error(`${item.name} declares unknown workspace dependency ${dep}`);
  return packages;
}

function importedSpecifiers(source, file) {
  void file;
  const result = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) result.push(match[1]);
  return [...new Set(result)].sort(sort);
}

function resolveSource(base, knownFiles) {
  const stripped = SOURCE_EXTENSIONS.has(path.extname(base)) ? base.slice(0, -path.extname(base).length) : base;
  const candidates = [base, ...[...SOURCE_EXTENSIONS].map((extension) => `${stripped}${extension}`), ...[...SOURCE_EXTENSIONS].map((extension) => path.join(base, `index${extension}`)), ...[...SOURCE_EXTENSIONS].map((extension) => path.join(stripped, `index${extension}`))];
  return candidates.find((candidate) => knownFiles.has(path.resolve(candidate)));
}

function packageTarget(specifier, packagesByName, root) {
  const item = [...packagesByName.values()].find(({ name }) => specifier === name || specifier.startsWith(`${name}/`));
  if (!item) return undefined;
  const subpath = specifier.slice(item.name.length).replace(/^\//u, "");
  const exportKey = subpath ? `./${subpath}` : ".";
  const configured = item.manifest.exports?.[exportKey];
  const value = typeof configured === "string" ? configured : configured?.import ?? configured?.default ?? configured?.types;
  let relativeTarget = typeof value === "string" ? value.replace(/^\.\/dist\//u, "./src/") : "./src/index.ts";
  if (relativeTarget.startsWith("./dist/")) relativeTarget = relativeTarget.replace("./dist/", "./src/");
  return path.resolve(root, item.directory, relativeTarget);
}

export async function collectModuleGraph(root = ROOT) {
  const packages = await collectPackages(root);
  const modules = [];
  const packageByFile = new Map();
  for (const item of packages) {
    const sourceRoot = path.join(root, item.directory, "src");
    for (const file of await walk(sourceRoot)) {
      const absolute = path.resolve(sourceRoot, file);
      const relativePath = posix(path.relative(root, absolute));
      modules.push({ id: relativePath, package: item.name, absolute });
      packageByFile.set(absolute, item.name);
    }
  }
  modules.sort((a, b) => sort(a.id, b.id));
  const knownFiles = new Set(modules.map(({ absolute }) => absolute));
  const packagesByName = new Map(packages.map((item) => [item.name, item]));
  const edges = new Set();
  for (const module of modules) {
    const source = await readFile(module.absolute, "utf8");
    for (const specifier of importedSpecifiers(source, module.absolute)) {
      let target;
      if (specifier.startsWith(".")) target = resolveSource(path.resolve(path.dirname(module.absolute), specifier), knownFiles);
      else {
        const packagePath = packageTarget(specifier, packagesByName, root);
        if (packagePath) target = resolveSource(packagePath, knownFiles);
      }
      if (target && target !== module.absolute) edges.add(`${module.id}\0${posix(path.relative(root, target))}`);
    }
  }
  return { packages, modules, edges: [...edges].map((edge) => edge.split("\0")).sort(([a, b], [c, d]) => sort(a, c) || sort(b, d)) };
}

export function renderModuleGraph({ packages, modules, edges }) {
  const lines = [
    "<!-- Generated by `pnpm graph:modules`; edit source or generator instead. -->",
    "# Package and module graph", "",
    `Generated from ${packages.length} workspace packages, ${modules.length} source modules, and ${edges.length} resolved module import edges.`,
    "External imports and imports that do not resolve to a workspace source file are omitted.", "",
    "## Workspace package graph", "", "```mermaid", "graph TD",
  ];
  for (const item of packages) lines.push(`  ${packageId(item.name)}["${item.name}<br/>${item.directory}"]`);
  for (const item of packages) for (const dependency of item.dependencies) lines.push(`  ${packageId(item.name)} --> ${packageId(dependency)}`);
  lines.push("```", "", "## Source module graph", "", "```mermaid", "graph LR");
  for (const module of modules) lines.push(`  ${moduleId(module.id)}["${module.id}"]`);
  for (const [from, to] of edges) lines.push(`  ${moduleId(from)} --> ${moduleId(to)}`);
  lines.push("```", "", "## Module inventory", "", "| Package | Source modules |", "| --- | --- |");
  for (const item of packages) {
    const paths = modules.filter((module) => module.package === item.name).map((module) => `\`${module.id}\``);
    lines.push(`| \`${item.name}\` | ${paths.length ? paths.join(", ") : "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}

function packageId(name) { return `p_${name.replace(/[^A-Za-z0-9_]/gu, "_")}`; }
function moduleId(file) { return `m_${file.replace(/[^A-Za-z0-9_]/gu, "_")}`; }

export async function generateModuleGraph(root = ROOT, check = false) {
  const outputPath = path.join(root, OUTPUT);
  const expected = renderModuleGraph(await collectModuleGraph(root));
  let actual;
  try { actual = await readFile(outputPath, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (check) {
    if (actual !== expected) throw new Error(`${OUTPUT} is stale; run pnpm graph:modules to regenerate it.`);
    return false;
  }
  if (actual !== expected) {
    await (await import("node:fs/promises")).mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, expected);
    return true;
  }
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--check")) throw new Error(`Unknown argument: ${args.find((arg) => arg !== "--check")}`);
    const changed = await generateModuleGraph(ROOT, args.includes("--check"));
    console.log(args.includes("--check") ? "Module graph is current." : changed ? `Generated ${OUTPUT}.` : `${OUTPUT} is already current.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
