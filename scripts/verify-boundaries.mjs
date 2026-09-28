import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript/unstable/ast";
import { parseDocument } from "yaml";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = "architecture-policy.yaml";
const WORKSPACE_PATH = "pnpm-workspace.yaml";
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".tracegraph", ".turbo", ".vite", "coverage", "dist", "node_modules",
]);

export async function verifyBoundaries(root = REPOSITORY_ROOT, options = {}) {
  const repositoryRoot = resolve(root);
  const errors = [];
  const warnings = [];
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const policy = await readYaml(repositoryRoot, POLICY_PATH, errors);
  const workspace = await readYaml(repositoryRoot, WORKSPACE_PATH, errors);
  if (policy === undefined || workspace === undefined) {
    return result(errors, warnings, 0, 0, 0);
  }

  const parsedPolicy = validatePolicy(policy, errors);
  const workspaceRoots = await discoverWorkspacePackages(repositoryRoot, workspace, errors);
  const packages = await readWorkspacePackages(repositoryRoot, workspaceRoots, errors);
  const packagesByName = new Map();
  for (const item of packages) {
    if (packagesByName.has(item.name)) {
      addError(errors, "BOUNDARY_PACKAGE_NAME_DUPLICATE", item.manifestPath, `Duplicate workspace package name ${item.name}`);
    } else {
      packagesByName.set(item.name, item);
    }
  }

  const policyByName = new Map(parsedPolicy.packages.map((item) => [item.name, item]));
  validatePackageInventory(packages, parsedPolicy.packages, policyByName, errors);
  validatePolicyReferences(parsedPolicy, packagesByName, errors);
  const exceptions = await validateExceptions(parsedPolicy.exceptions, repositoryRoot, packagesByName, today, errors);
  const graph = new Map(packages.map((item) => [item.name, new Set()]));
  const declaredEdges = new Set();

  for (const source of packages) {
    const workspaceDependencies = collectWorkspaceDependencies(source.manifest, packagesByName);
    for (const dependency of workspaceDependencies) {
      const edgeKey = edgeId(source.name, dependency);
      declaredEdges.add(edgeKey);
      graph.get(source.name)?.add(dependency);
      checkEdge(source.name, dependency, source.manifestPath, parsedPolicy, exceptions, errors, warnings, "manifest dependency");
    }
  }

  if (parsedPolicy.global.forbid_cycles) {
    const cycle = findCycle(graph);
    if (cycle !== undefined) {
      const message = `Workspace dependency cycle: ${cycle.join(" -> ")}`;
      for (const name of new Set(cycle.slice(0, -1))) {
        reportPackageIssue(policyByName.get(name), errors, warnings, "BOUNDARY_PACKAGE_CYCLE", POLICY_PATH, message);
      }
    }
  }

  let importCount = 0;
  for (const source of packages) {
    const files = await collectSourceFiles(source.rootPath);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const sourceErrors = [];
      const specifiers = collectModuleSpecifiers(text, file, sourceErrors, repositoryRoot);
      for (const error of sourceErrors) {
        reportPackageIssue(policyByName.get(source.name), errors, warnings, error.code, error.location, error.message);
      }
      for (const item of specifiers) {
        importCount += 1;
        const target = resolveWorkspaceSpecifier(item.specifier, packagesByName);
        if (target !== undefined) {
          if (parsedPolicy.global.forbid_deep_imports && !isPublicExport(target.manifest.exports, target.subpath)) {
            reportPackageIssue(
              policyByName.get(source.name), errors, warnings,
              "BOUNDARY_DEEP_IMPORT",
              item.location,
              `${item.specifier} subpath ${target.subpath} is not declared by ${target.name}'s package exports (keys: ${Object.keys(target.manifest.exports ?? {}).join(",")})`,
            );
          }
          if (target.name === source.name) {
            reportPackageIssue(policyByName.get(source.name), errors, warnings, "BOUNDARY_SELF_PACKAGE_IMPORT", item.location, `${source.name} must use package-relative imports within itself`);
          } else {
            checkEdge(source.name, target.name, item.location, parsedPolicy, exceptions, errors, warnings, "source import");
            if (!declaredEdges.has(edgeId(source.name, target.name))) {
              reportPackageIssue(
                policyByName.get(source.name), errors, warnings,
                "BOUNDARY_DEPENDENCY_UNDECLARED",
                item.location,
                `${source.name} imports ${target.name} without declaring it as a workspace dependency`,
              );
            }
          }
          continue;
        }

        if (item.specifier.startsWith("@tracegraph/")) {
          reportPackageIssue(policyByName.get(source.name), errors, warnings, "BOUNDARY_WORKSPACE_PACKAGE_UNKNOWN", item.location, `Unknown workspace import ${item.specifier}`);
          continue;
        }

        if (isRelativeSpecifier(item.specifier)) {
          const resolved = resolve(dirname(file), item.specifier);
          const targetPackage = containingPackage(resolved, packages);
          if (targetPackage !== undefined && targetPackage.name !== source.name) {
            reportPackageIssue(
              policyByName.get(source.name), errors, warnings,
              "BOUNDARY_CROSS_PACKAGE_RELATIVE_IMPORT",
              item.location,
              `${source.name} reaches ${targetPackage.name} by relative path; import its public package export instead`,
            );
          }
        }
      }
    }
  }

  return result(errors, warnings, packages.length, declaredEdges.size, importCount);
}

export function hasBoundaryCheckInCi(workflowText) {
  try {
    const document = parseDocument(workflowText, { uniqueKeys: true });
    if (document.errors.length > 0) return false;
    const jobs = document.toJS()?.jobs;
    const steps = jobs?.typecheck?.steps;
    return Array.isArray(steps) && steps.some((step) => (
      step !== null && typeof step === "object" && step.run === "pnpm verify:boundaries"
    ));
  } catch {
    return false;
  }
}

function result(errors, warnings, packageCount, dependencyCount, importCount) {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    packageCount,
    dependencyCount,
    importCount,
  };
}

async function readYaml(root, path, errors) {
  const absolutePath = join(root, path);
  let source;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    addError(errors, "BOUNDARY_FILE_READ", path, `Cannot read ${path}: ${messageOf(error)}`);
    return undefined;
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      addError(errors, "BOUNDARY_YAML_INVALID", path, error.message);
    }
    return undefined;
  }
  return document.toJS();
}

function validatePolicy(value, errors) {
  if (!isRecord(value)) {
    addError(errors, "BOUNDARY_POLICY_INVALID", POLICY_PATH, "Policy root must be a YAML mapping");
    return { global: { forbid_cycles: true, forbid_deep_imports: true }, packages: [], exceptions: [] };
  }
  validateKeys(value, ["version", "global", "packages", "exceptions"], ["version", "global", "packages", "exceptions"], POLICY_PATH, errors);
  if (value.version !== 2) addError(errors, "BOUNDARY_POLICY_VERSION", POLICY_PATH, "version must be 2");

  const global = value.global;
  if (!isRecord(global)) {
    addError(errors, "BOUNDARY_POLICY_GLOBAL_INVALID", POLICY_PATH, "global must be a YAML mapping");
  } else {
    validateKeys(global, ["forbid_cycles", "forbid_deep_imports"], ["forbid_cycles", "forbid_deep_imports"], POLICY_PATH, errors);
    if (global.forbid_cycles !== true || global.forbid_deep_imports !== true) {
      addError(errors, "BOUNDARY_POLICY_GLOBAL_INVALID", POLICY_PATH, "forbid_cycles and forbid_deep_imports must both be true");
    }
  }

  const packages = [];
  if (!Array.isArray(value.packages)) {
    addError(errors, "BOUNDARY_POLICY_PACKAGES_INVALID", POLICY_PATH, "packages must be a sequence");
  } else {
    for (const [index, entry] of value.packages.entries()) {
      const location = `${POLICY_PATH}:packages[${index}]`;
      if (!isRecord(entry)) {
        addError(errors, "BOUNDARY_POLICY_PACKAGE_INVALID", location, "Each package entry must be a mapping");
        continue;
      }
      validateKeys(entry, ["name", "root", "allowed", "forbidden", "governance"], ["name", "root", "allowed", "forbidden", "governance", "migration_owner"], location, errors);
      if (!isNonEmptyString(entry.name) || !entry.name.startsWith("@tracegraph/")) {
        addError(errors, "BOUNDARY_POLICY_PACKAGE_INVALID", location, "Package name must be a non-empty @tracegraph/* identifier");
        continue;
      }
      const packageRoot = safeRepoRelativePath(entry.root);
      if (packageRoot === undefined) addError(errors, "BOUNDARY_POLICY_PACKAGE_INVALID", location, "root must be a safe repository-relative path");
      const allowed = stringList(entry.allowed, location, "allowed", errors);
      const forbidden = stringList(entry.forbidden, location, "forbidden", errors);
      const governance = entry.governance === "legacy" || entry.governance === "managed" ? entry.governance : "managed";
      if (entry.governance !== "legacy" && entry.governance !== "managed") {
        addError(errors, "BOUNDARY_POLICY_GOVERNANCE_INVALID", location, "governance must be either managed or legacy");
      }
      const migrationOwner = entry.migration_owner;
      if (governance === "legacy" && !isNonEmptyString(migrationOwner)) {
        addError(errors, "BOUNDARY_POLICY_MIGRATION_OWNER_MISSING", location, "legacy packages require a non-empty migration_owner");
      }
      if (governance === "managed" && Object.hasOwn(entry, "migration_owner")) {
        addError(errors, "BOUNDARY_POLICY_MIGRATION_OWNER_UNEXPECTED", location, "migration_owner is only valid for legacy packages");
      }
      for (const dependency of allowed) {
        if (dependency === entry.name) addError(errors, "BOUNDARY_POLICY_SELF_EDGE", location, `${entry.name} cannot allow a self dependency`);
        if (forbidden.includes(dependency)) addError(errors, "BOUNDARY_POLICY_EDGE_CONFLICT", location, `${dependency} is both allowed and forbidden`);
      }
      packages.push({
        name: entry.name,
        root: packageRoot ?? "",
        allowed,
        forbidden,
        governance,
        ...(governance === "legacy" && isNonEmptyString(migrationOwner) ? { migrationOwner: migrationOwner.trim() } : {}),
        location,
      });
    }
  }

  const exceptions = [];
  if (!Array.isArray(value.exceptions)) {
    addError(errors, "BOUNDARY_POLICY_EXCEPTIONS_INVALID", POLICY_PATH, "exceptions must be a sequence");
  } else {
    for (const [index, entry] of value.exceptions.entries()) {
      const location = `${POLICY_PATH}:exceptions[${index}]`;
      if (!isRecord(entry)) {
        addError(errors, "BOUNDARY_POLICY_EXCEPTION_INVALID", location, "Each exception must be a mapping");
        continue;
      }
      validateKeys(entry, ["id", "from", "to", "owner", "note", "expires_on"], ["id", "from", "to", "owner", "note", "expires_on"], location, errors);
      const note = safeRepoRelativePath(entry.note);
      if (!isNonEmptyString(entry.id) || !isNonEmptyString(entry.from) || !isNonEmptyString(entry.to)
        || !isNonEmptyString(entry.owner) || note === undefined || !isNonEmptyString(entry.expires_on)) {
        addError(errors, "BOUNDARY_POLICY_EXCEPTION_INVALID", location, "Exception requires id, from, to, owner, safe note path, and expires_on");
        continue;
      }
      exceptions.push({
        id: entry.id,
        from: entry.from,
        to: entry.to,
        owner: entry.owner,
        note,
        expires_on: entry.expires_on,
        location,
      });
    }
  }

  return {
    global: isRecord(global)
      ? { forbid_cycles: global.forbid_cycles === true, forbid_deep_imports: global.forbid_deep_imports === true }
      : { forbid_cycles: true, forbid_deep_imports: true },
    packages,
    exceptions,
  };
}

function validateKeys(value, required, allowed, location, errors) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) addError(errors, "BOUNDARY_POLICY_FIELD_MISSING", location, `Missing required field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addError(errors, "BOUNDARY_POLICY_FIELD_UNKNOWN", location, `Unknown policy field ${key}`);
  }
}

function stringList(value, location, field, errors) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    addError(errors, "BOUNDARY_POLICY_LIST_INVALID", location, `${field} must be a sequence of non-empty strings`);
    return [];
  }
  if (new Set(value).size !== value.length) addError(errors, "BOUNDARY_POLICY_LIST_DUPLICATE", location, `${field} contains duplicates`);
  return value;
}

async function discoverWorkspacePackages(root, workspace, errors) {
  if (!isRecord(workspace) || !Array.isArray(workspace.packages)) {
    addError(errors, "BOUNDARY_WORKSPACE_INVALID", WORKSPACE_PATH, "pnpm-workspace.yaml must declare a packages sequence");
    return [];
  }
  const included = new Set();
  const excluded = new Set();
  for (const rawPattern of workspace.packages) {
    if (!isNonEmptyString(rawPattern)) {
      addError(errors, "BOUNDARY_WORKSPACE_PATTERN_INVALID", WORKSPACE_PATH, "Workspace patterns must be non-empty strings");
      continue;
    }
    const isExclusion = rawPattern.startsWith("!");
    const pattern = isExclusion ? rawPattern.slice(1) : rawPattern;
    const match = /^([A-Za-z0-9._-]+)\/\*$/u.exec(pattern);
    if (match === null) {
      addError(errors, "BOUNDARY_WORKSPACE_PATTERN_UNSUPPORTED", WORKSPACE_PATH, `Unsupported workspace pattern ${rawPattern}; expected a safe top-level directory/* pattern`);
      continue;
    }
    const base = join(root, match[1]);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      addError(errors, "BOUNDARY_WORKSPACE_READ", match[1], `Cannot enumerate workspace root: ${messageOf(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const packageRoot = `${match[1]}/${entry.name}`;
      const manifestPath = join(root, packageRoot, "package.json");
      try {
        const manifestInfo = await lstat(manifestPath);
        if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) continue;
        (isExclusion ? excluded : included).add(packageRoot);
      } catch (error) {
        if (error?.code !== "ENOENT") addError(errors, "BOUNDARY_WORKSPACE_READ", packageRoot, `Cannot inspect package manifest: ${messageOf(error)}`);
      }
    }
  }
  return [...included].filter((path) => !excluded.has(path)).sort();
}

async function readWorkspacePackages(root, roots, errors) {
  const packages = [];
  for (const packageRoot of roots) {
    const manifestPath = join(root, packageRoot, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!isNonEmptyString(manifest.name)) {
        addError(errors, "BOUNDARY_PACKAGE_NAME_MISSING", relative(root, manifestPath), "Workspace package.json must have a name");
        continue;
      }
      packages.push({
        name: manifest.name,
        root: packageRoot,
        rootPath: join(root, packageRoot),
        manifest,
        manifestPath: relative(root, manifestPath).split(sep).join("/"),
      });
    } catch (error) {
      addError(errors, "BOUNDARY_PACKAGE_MANIFEST_INVALID", relative(root, manifestPath), `Cannot parse package manifest: ${messageOf(error)}`);
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function validatePackageInventory(packages, policyPackages, policyByName, errors) {
  const foundNames = new Set(packages.map(({ name }) => name));
  for (const item of packages) {
    const policyPackage = policyByName.get(item.name);
    if (policyPackage === undefined) {
      addError(errors, "BOUNDARY_POLICY_PACKAGE_MISSING", POLICY_PATH, `Workspace package ${item.name} is not governed by the architecture policy`);
    } else if (policyPackage.root !== item.root) {
      addError(errors, "BOUNDARY_POLICY_ROOT_MISMATCH", policyPackage.location, `${item.name} is at ${item.root}, but policy declares ${policyPackage.root}`);
    }
  }
  for (const entry of policyPackages) {
    if (!foundNames.has(entry.name)) addError(errors, "BOUNDARY_POLICY_PACKAGE_UNKNOWN", entry.location, `Policy package ${entry.name} is not in pnpm workspace`);
  }
  if (new Set(policyPackages.map(({ name }) => name)).size !== policyPackages.length) {
    addError(errors, "BOUNDARY_POLICY_PACKAGE_DUPLICATE", POLICY_PATH, "Policy package names must be unique");
  }
  if (new Set(policyPackages.map(({ root }) => root)).size !== policyPackages.length) {
    addError(errors, "BOUNDARY_POLICY_ROOT_DUPLICATE", POLICY_PATH, "Policy package roots must be unique");
  }
}

function validatePolicyReferences(policy, packagesByName, errors) {
  for (const entry of policy.packages) {
    for (const dependency of [...entry.allowed, ...entry.forbidden]) {
      if (!packagesByName.has(dependency)) {
        addError(errors, "BOUNDARY_POLICY_EDGE_UNKNOWN", entry.location, `${entry.name} references unknown workspace package ${dependency}`);
      }
    }
  }
  const seenIds = new Set();
  const seenEdges = new Set();
  for (const exception of policy.exceptions) {
    if (seenIds.has(exception.id)) addError(errors, "BOUNDARY_POLICY_EXCEPTION_DUPLICATE", exception.location, `Duplicate exception id ${exception.id}`);
    seenIds.add(exception.id);
    const key = edgeId(exception.from, exception.to);
    if (seenEdges.has(key)) addError(errors, "BOUNDARY_POLICY_EXCEPTION_DUPLICATE", exception.location, `Duplicate exception for ${exception.from} -> ${exception.to}`);
    seenEdges.add(key);
    if (!packagesByName.has(exception.from) || !packagesByName.has(exception.to)) {
      addError(errors, "BOUNDARY_POLICY_EXCEPTION_EDGE_UNKNOWN", exception.location, "Exception endpoints must name known workspace packages");
    }
  }
}

async function validateExceptions(exceptions, root, packagesByName, today, errors) {
  const active = new Set();
  for (const exception of exceptions) {
    if (!isValidDate(exception.expires_on)) {
      addError(errors, "BOUNDARY_EXCEPTION_EXPIRY_INVALID", exception.location, "expires_on must be a real YYYY-MM-DD date");
      continue;
    }
    if (exception.expires_on < today) {
      addError(errors, "BOUNDARY_EXCEPTION_EXPIRED", exception.location, `Exception ${exception.id} expired on ${exception.expires_on}`);
      continue;
    }
    const notePath = join(root, exception.note);
    try {
      const info = await lstat(notePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        addError(errors, "BOUNDARY_EXCEPTION_NOTE_INVALID", exception.location, `Exception note ${exception.note} must be a regular, non-symlink file`);
        continue;
      }
    } catch {
      addError(errors, "BOUNDARY_EXCEPTION_NOTE_MISSING", exception.location, `Exception note ${exception.note} does not exist`);
      continue;
    }
    if (packagesByName.has(exception.from) && packagesByName.has(exception.to)) {
      active.add(edgeId(exception.from, exception.to));
    }
  }
  return active;
}

function collectWorkspaceDependencies(manifest, packagesByName) {
  const dependencies = new Set();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const values = manifest[field];
    if (!isRecord(values)) continue;
    for (const name of Object.keys(values)) {
      if (packagesByName.has(name)) dependencies.add(name);
    }
  }
  return [...dependencies].sort();
}

function checkEdge(from, to, location, policy, exceptions, errors, warnings, source) {
  const fromPolicy = policy.packages.find((item) => item.name === from);
  if (fromPolicy === undefined) {
    addError(errors, "BOUNDARY_POLICY_PACKAGE_MISSING", location, `No architecture policy entry for ${from}`);
    return;
  }
  if (fromPolicy.forbidden.includes(to)) {
    reportPackageIssue(fromPolicy, errors, warnings, "BOUNDARY_EDGE_FORBIDDEN", location, `${source} ${from} -> ${to} is explicitly forbidden`);
    return;
  }
  if (fromPolicy.allowed.includes(to) || exceptions.has(edgeId(from, to))) return;
  reportPackageIssue(fromPolicy, errors, warnings, "BOUNDARY_EDGE_NOT_ALLOWED", location, `${source} ${from} -> ${to} is not allowed by ${POLICY_PATH}`);
}

function reportPackageIssue(policyPackage, errors, warnings, code, location, message) {
  const diagnostic = { code, location, message };
  if (policyPackage?.governance === "legacy") {
    warnings.push({ ...diagnostic, migrationOwner: policyPackage.migrationOwner });
    return;
  }
  errors.push(diagnostic);
}

function findCycle(graph) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  let found;
  const visit = (node) => {
    if (found !== undefined) return;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (!visited.has(next)) visit(next);
      else if (active.has(next)) {
        const start = stack.indexOf(next);
        found = [...stack.slice(start), next];
        return;
      }
    }
    stack.pop();
    active.delete(node);
  };
  for (const node of [...graph.keys()].sort()) {
    if (!visited.has(node)) visit(node);
    if (found !== undefined) break;
  }
  return found;
}

async function collectSourceFiles(packageRoot) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  await visit(packageRoot);
  return files.sort();
}

function collectModuleSpecifiers(text, file, errors, root) {
  const result = [];
  const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, text);
  const tokens = [];
  const templateExpressionBraceDepths = [];
  let previousStart = -1;
  let previousToken;
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFile) {
    if (kind === ts.SyntaxKind.SlashToken && regexMayStartAfter(previousToken)) {
      kind = scanner.reScanSlashToken();
    }
    const tokenStart = scanner.getTokenStart();
    if (tokenStart >= text.length) {
      // The TypeScript 7 unstable scanner uses `EndOfFile` (not the legacy
      // `EndOfFileToken`) and can return a non-EOF token on repeated scans.
      break;
    }
    if (tokenStart <= previousStart) {
      if (file.endsWith(".tsx") && kind === ts.SyntaxKind.PrivateIdentifier
        && scanner.getTokenEnd() === tokenStart) {
        scanner.resetTokenState(tokenStart + 1);
        kind = scanner.scan();
        continue;
      }
      addError(errors, "BOUNDARY_SOURCE_SCAN_FAILED", relative(root, file).split(sep).join("/"), `TypeScript scanner did not advance (token ${kind}, offset ${tokenStart}, previous ${previousStart})`);
      break;
    }
    previousStart = tokenStart;
    if (kind === ts.SyntaxKind.CloseBraceToken && templateExpressionBraceDepths.at(-1) === 0) {
      kind = scanner.reScanTemplateToken(false);
      const templateTokenStart = scanner.getTokenStart();
      if (scanner.getTokenEnd() <= templateTokenStart) {
        addError(errors, "BOUNDARY_SOURCE_SCAN_FAILED", relative(root, file).split(sep).join("/"), "TypeScript scanner could not resume a template literal");
        break;
      }
      previousStart = templateTokenStart;
      tokens.push({
        kind,
        text: scanner.getTokenText(),
        value: scanner.getTokenValue(),
        pos: templateTokenStart,
        lineBreakBefore: scanner.hasPrecedingLineBreak(),
      });
      previousToken = tokens.at(-1);
      if (kind === ts.SyntaxKind.TemplateTail) templateExpressionBraceDepths.pop();
      kind = scanner.scan();
      continue;
    }
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
      pos: scanner.getTokenStart(),
      lineBreakBefore: scanner.hasPrecedingLineBreak(),
    });
    previousToken = tokens.at(-1);
    if (kind === ts.SyntaxKind.TemplateHead) templateExpressionBraceDepths.push(0);
    else if (templateExpressionBraceDepths.length > 0 && kind === ts.SyntaxKind.OpenBraceToken) {
      templateExpressionBraceDepths[templateExpressionBraceDepths.length - 1] += 1;
    } else if (templateExpressionBraceDepths.length > 0 && kind === ts.SyntaxKind.CloseBraceToken) {
      templateExpressionBraceDepths[templateExpressionBraceDepths.length - 1] -= 1;
    } else if (kind === ts.SyntaxKind.TemplateTail) templateExpressionBraceDepths.pop();
    kind = scanner.scan();
  }
  const locationAt = (position) => {
    const prefix = text.slice(0, position);
    const line = prefix.split("\n").length;
    return `${relative(root, file).split(sep).join("/")}:${line}`;
  };
  const add = (token) => result.push({ specifier: token.value, location: locationAt(token.pos) });

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const afterNext = tokens[index + 2];
    if (token.kind === ts.SyntaxKind.ImportKeyword) {
      if (next?.kind === ts.SyntaxKind.DotToken) continue;
      if (next?.kind === ts.SyntaxKind.StringLiteral || next?.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        add(next);
        continue;
      }
      if (next?.kind === ts.SyntaxKind.OpenParenToken) {
        if ((afterNext?.kind === ts.SyntaxKind.StringLiteral || afterNext?.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
          && tokens[index + 3]?.kind === ts.SyntaxKind.CloseParenToken) {
          add(afterNext);
        } else {
          addError(errors, "BOUNDARY_DYNAMIC_IMPORT_NON_LITERAL", locationAt(token.pos), "Non-literal import() cannot be checked against package boundaries");
        }
        continue;
      }
      const imported = findFromSpecifier(tokens, index);
      if (imported !== undefined) add(imported);
    } else if (token.kind === ts.SyntaxKind.ExportKeyword) {
      const exported = findFromSpecifier(tokens, index);
      if (exported !== undefined) add(exported);
    } else if (token.kind === ts.SyntaxKind.Identifier && token.text === "require" && next?.kind === ts.SyntaxKind.OpenParenToken) {
      if (afterNext?.kind === ts.SyntaxKind.StringLiteral || afterNext?.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        add(afterNext);
      } else {
        addError(errors, "BOUNDARY_DYNAMIC_IMPORT_NON_LITERAL", locationAt(token.pos), "Non-literal require() cannot be checked against package boundaries");
      }
    }
  }

  for (const match of text.matchAll(/^\s*\/\/\/\s*<reference\s+path=["']([^"']+)["']/gmu)) {
    const referencedPath = resolve(dirname(file), match[1]);
    result.push({
      specifier: relative(dirname(file), referencedPath),
      location: locationAt(match.index ?? 0),
    });
  }
  return result;
}

function regexMayStartAfter(token) {
  if (token === undefined) return true;
  if ([
    ts.SyntaxKind.OpenParenToken,
    ts.SyntaxKind.OpenBraceToken,
    ts.SyntaxKind.OpenBracketToken,
    ts.SyntaxKind.CommaToken,
    ts.SyntaxKind.SemicolonToken,
    ts.SyntaxKind.ColonToken,
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.EqualsGreaterThanToken,
    ts.SyntaxKind.ExclamationToken,
    ts.SyntaxKind.QuestionToken,
    ts.SyntaxKind.BarToken,
    ts.SyntaxKind.AmpersandToken,
  ].includes(token.kind)) return true;
  return ["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await"]
    .includes(token.text);
}

function findFromSpecifier(tokens, start) {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const atTopLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
    if (atTopLevel && token.kind === ts.SyntaxKind.SemicolonToken) return undefined;
    if (atTopLevel && token.lineBreakBefore && (
      token.kind === ts.SyntaxKind.ImportKeyword || token.kind === ts.SyntaxKind.ExportKeyword
      || token.text === "const" || token.text === "let" || token.text === "var"
      || token.text === "function" || token.text === "class" || token.text === "return"
    )) return undefined;
    if (atTopLevel && token.text === "from" && (
      tokens[index + 1]?.kind === ts.SyntaxKind.StringLiteral
      || tokens[index + 1]?.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    )) return tokens[index + 1];

    if (token.kind === ts.SyntaxKind.OpenBraceToken) braceDepth += 1;
    else if (token.kind === ts.SyntaxKind.CloseBraceToken) braceDepth = Math.max(0, braceDepth - 1);
    else if (token.kind === ts.SyntaxKind.OpenParenToken) parenDepth += 1;
    else if (token.kind === ts.SyntaxKind.CloseParenToken) parenDepth = Math.max(0, parenDepth - 1);
    else if (token.kind === ts.SyntaxKind.OpenBracketToken) bracketDepth += 1;
    else if (token.kind === ts.SyntaxKind.CloseBracketToken) bracketDepth = Math.max(0, bracketDepth - 1);

  }
  return undefined;
}

function resolveWorkspaceSpecifier(specifier, packagesByName) {
  const match = [...packagesByName.values()]
    .filter((item) => specifier === item.name || specifier.startsWith(`${item.name}/`))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (match === undefined) return undefined;
  const subpath = specifier === match.name ? "." : `./${specifier.slice(match.name.length + 1)}`;
  return { ...match, subpath };
}

function isPublicExport(exportsField, subpath) {
  if (exportsField === undefined) return false;
  const keys = isRecord(exportsField)
    ? Object.keys(exportsField).filter((key) => key === "." || key.startsWith("./"))
    : ["."];
  return keys.some((key) => exportKeyMatches(key, subpath));
}

function exportKeyMatches(key, subpath) {
  if (key === subpath) return true;
  if (!key.includes("*")) return false;
  const escaped = key.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "u").test(subpath);
}

function containingPackage(path, packages) {
  return packages
    .filter((item) => isPathInside(item.rootPath, path))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
}

function isPathInside(parent, target) {
  const rel = relative(resolve(parent), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function safeRepoRelativePath(value) {
  if (!isNonEmptyString(value) || value.includes("\\") || isAbsolute(value)) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function edgeId(from, to) {
  return `${from}\u0000${to}`;
}

function addError(errors, code, location, message) {
  errors.push({ code, location, message });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runCli(args) {
  const rootIndex = args.indexOf("--root");
  if (rootIndex !== -1 && (args.length !== rootIndex + 2 || args[rootIndex + 1].startsWith("--"))) {
    process.stderr.write("Usage: node scripts/verify-boundaries.mjs [--root <repository>]");
    process.exitCode = 2;
    return;
  }
  if (args.some((argument, index) => argument.startsWith("--") && (index !== rootIndex || argument !== "--root"))) {
    process.stderr.write("Usage: node scripts/verify-boundaries.mjs [--root <repository>]\n");
    process.exitCode = 2;
    return;
  }
  const root = rootIndex === -1 ? REPOSITORY_ROOT : resolve(args[rootIndex + 1]);
  const outcome = await verifyBoundaries(root);
  for (const warning of outcome.warnings) {
    process.stderr.write(`[${warning.code}] ${warning.location}: ${warning.message} (legacy report-only; migration owner: ${warning.migrationOwner})\n`);
  }
  if (outcome.ok) {
    process.stdout.write(`Architecture boundaries verified: ${outcome.packageCount} packages, ${outcome.dependencyCount} workspace dependencies, ${outcome.importCount} import references; ${outcome.warnings.length} legacy findings reported.\n`);
    return;
  }
  for (const error of outcome.errors) process.stderr.write(`[${error.code}] ${error.location}: ${error.message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}
