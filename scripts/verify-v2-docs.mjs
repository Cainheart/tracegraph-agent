import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readYaml(file, label, issues) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    issues.push({ code: "V2DOC_FILE_MISSING", message: `${label}: ${error.message}` });
    return undefined;
  }

  try {
    return parse(source, { uniqueKeys: true, maxAliasCount: 100 });
  } catch (error) {
    issues.push({ code: "V2DOC_YAML_INVALID", message: `${label}: ${error.message}` });
    return undefined;
  }
}

function checkPath(root, baseDirectory, value, label, issues) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ code: "V2DOC_PATH_INVALID", message: `${label}: expected a non-empty relative path` });
    return;
  }
  if (path.isAbsolute(value)) {
    issues.push({ code: "V2DOC_PATH_INVALID", message: `${label}: absolute paths are not allowed (${value})` });
    return;
  }

  const resolved = path.resolve(baseDirectory, value);
  const fromRoot = path.relative(root, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    issues.push({ code: "V2DOC_PATH_INVALID", message: `${label}: path escapes the repository (${value})` });
    return;
  }
  return resolved;
}

async function checkExistingPath(root, baseDirectory, value, label, issues) {
  const resolved = checkPath(root, baseDirectory, value, label, issues);
  if (!resolved) return;
  try {
    await stat(resolved);
  } catch {
    issues.push({ code: "V2DOC_PATH_MISSING", message: `${label}: ${value} does not exist` });
  }
}

async function checkManifest(root, manifest, issues) {
  const manifestDirectory = path.join(root, "docs/outlive-agent-v2");
  if (!isRecord(manifest)) {
    issues.push({ code: "V2DOC_MANIFEST_SHAPE", message: "manifest.yaml: expected a mapping" });
    return;
  }

  const statuses = manifest.state_vocabulary?.document;
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((status) => typeof status !== "string" || !status)) {
    issues.push({ code: "V2DOC_STATUS_VOCABULARY", message: "manifest.yaml: state_vocabulary.document must be a non-empty list of status strings" });
  }
  const allowedStatuses = new Set(Array.isArray(statuses) ? statuses : []);

  for (const key of ["canonical_entry", "design_index"]) {
    await checkExistingPath(root, manifestDirectory, manifest[key], `manifest.${key}`, issues);
  }

  if (!isRecord(manifest.truth_sources)) {
    issues.push({ code: "V2DOC_MANIFEST_SHAPE", message: "manifest.truth_sources: expected a mapping" });
  } else {
    for (const [group, paths] of Object.entries(manifest.truth_sources)) {
      if (group === "note") continue;
      if (!Array.isArray(paths)) {
        issues.push({ code: "V2DOC_MANIFEST_SHAPE", message: `manifest.truth_sources.${group}: expected a list` });
        continue;
      }
      for (const sourcePath of paths) {
        await checkExistingPath(root, manifestDirectory, sourcePath, `manifest.truth_sources.${group}`, issues);
      }
    }
  }

  if (!Array.isArray(manifest.documents)) {
    issues.push({ code: "V2DOC_MANIFEST_SHAPE", message: "manifest.documents: expected a list" });
    return;
  }

  const documentIds = new Set();
  for (const [index, document] of manifest.documents.entries()) {
    const label = `manifest.documents[${index}]`;
    if (!isRecord(document)) {
      issues.push({ code: "V2DOC_MANIFEST_SHAPE", message: `${label}: expected a mapping` });
      continue;
    }
    if (typeof document.id !== "string" || !document.id.trim()) {
      issues.push({ code: "V2DOC_MANIFEST_SHAPE", message: `${label}.id: expected a non-empty string` });
    } else if (documentIds.has(document.id)) {
      issues.push({ code: "V2DOC_DOCUMENT_ID_DUPLICATE", message: `${label}.id: duplicate document id ${document.id}` });
    } else {
      documentIds.add(document.id);
    }
    if (!allowedStatuses.has(document.status)) {
      issues.push({ code: "V2DOC_STATUS_INVALID", message: `${label}.status: unsupported document status ${JSON.stringify(document.status)}` });
    }
    await checkExistingPath(root, manifestDirectory, document.path, `${label}.path`, issues);
    if (document.subdocuments !== undefined) {
      if (!Array.isArray(document.subdocuments)) {
        issues.push({ code: "V2DOC_MANIFEST_SHAPE", message: `${label}.subdocuments: expected a list` });
      } else {
        for (const subdocument of document.subdocuments) {
          await checkExistingPath(root, manifestDirectory, subdocument, `${label}.subdocuments`, issues);
        }
      }
    }
  }
}

function checkRoadmap(roadmap, issues) {
  if (!isRecord(roadmap) || !Array.isArray(roadmap.tasks)) {
    issues.push({ code: "V2DOC_ROADMAP_SHAPE", message: "roadmap.yaml: expected a mapping with a tasks list" });
    return;
  }
  const phases = new Set(Array.isArray(roadmap.phases) ? roadmap.phases.map((phase) => phase?.id).filter((id) => typeof id === "string") : []);
  const counts = new Map();
  for (const task of roadmap.tasks) {
    if (typeof task?.id === "string" && task.id.trim()) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) issues.push({ code: "V2DOC_TASK_ID_DUPLICATE", message: `roadmap.yaml: task id ${id} appears ${count} times` });
  }

  const tasks = new Map();
  for (const [index, task] of roadmap.tasks.entries()) {
    if (!isRecord(task) || typeof task.id !== "string" || !task.id.trim()) {
      issues.push({ code: "V2DOC_ROADMAP_SHAPE", message: `roadmap.tasks[${index}].id: expected a non-empty string` });
      continue;
    }
    if (task.phase !== undefined && phases.size > 0 && !phases.has(task.phase)) {
      issues.push({ code: "V2DOC_PHASE_UNKNOWN", message: `${task.id}: unknown phase ${JSON.stringify(task.phase)}` });
    }
    if (task.depends_on !== undefined && (!Array.isArray(task.depends_on) || task.depends_on.some((id) => typeof id !== "string" || !id.trim()))) {
      issues.push({ code: "V2DOC_DEPENDENCY_INVALID", message: `${task.id}.depends_on: expected a list of task IDs` });
      continue;
    }
    tasks.set(task.id, task);
  }

  const graph = new Map();
  for (const [id, task] of tasks) {
    const dependencies = Array.isArray(task.depends_on) ? task.depends_on : [];
    const uniqueDependencies = new Set(dependencies);
    if (uniqueDependencies.size !== dependencies.length) {
      issues.push({ code: "V2DOC_DEPENDENCY_DUPLICATE", message: `${id}.depends_on: duplicate dependency ID` });
    }
    for (const dependency of dependencies) {
      if (!tasks.has(dependency)) {
        issues.push({ code: "V2DOC_DEPENDENCY_UNKNOWN", message: `${id}.depends_on: unknown task ${dependency}` });
      }
    }
    graph.set(id, dependencies.filter((dependency) => tasks.has(dependency)));
  }

  const visited = new Set();
  const visiting = new Set();
  const stack = [];
  const reportedCycles = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const canonical = [...cycle.slice(0, -1)].sort().join("|");
      if (!reportedCycles.has(canonical)) {
        reportedCycles.add(canonical);
        issues.push({ code: "V2DOC_DEPENDENCY_CYCLE", message: `roadmap.yaml: dependency cycle ${cycle.join(" -> ")}` });
      }
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
}

export async function verifyV2Docs(root = repositoryRoot) {
  const resolvedRoot = path.resolve(root);
  const issues = [];
  const manifest = await readYaml(path.join(resolvedRoot, "docs/outlive-agent-v2/manifest.yaml"), "manifest.yaml", issues);
  const roadmap = await readYaml(path.join(resolvedRoot, "docs/outlive-agent-v2/roadmap.yaml"), "roadmap.yaml", issues);
  if (manifest !== undefined) await checkManifest(resolvedRoot, manifest, issues);
  if (roadmap !== undefined) checkRoadmap(roadmap, issues);
  return {
    ok: issues.length === 0,
    issues,
    documentCount: Array.isArray(manifest?.documents) ? manifest.documents.length : 0,
    taskCount: Array.isArray(roadmap?.tasks) ? roadmap.tasks.length : 0,
  };
}

function parseArguments(argv) {
  let root = repositoryRoot;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) {
      root = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return root;
}

async function main() {
  let root;
  try {
    root = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error("Usage: node scripts/verify-v2-docs.mjs [--root <repository-root>]");
    process.exitCode = 2;
    return;
  }

  const result = await verifyV2Docs(root);
  for (const issue of result.issues) console.error(`[${issue.code}] ${issue.message}`);
  if (!result.ok) {
    console.error(`V2 docs verification failed with ${result.issues.length} issue(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`V2 docs verified: ${result.documentCount} manifest documents, ${result.taskCount} roadmap tasks.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
