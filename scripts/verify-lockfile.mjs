#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_MANIFESTS = 512;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const REQUIRED_PNPM_MAJOR = 11;
const EXPECTED_LOCKFILE_VERSION = "9.0";
const DIRECT_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const ALL_DEPENDENCY_FIELDS = [...DIRECT_DEPENDENCY_FIELDS, "peerDependencies"];
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tracegraph",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXOTIC_SOURCE = /^(?:git(?:\+[^:]+)?|https?|file|link|github|gitlab|bitbucket|ssh):|^git@|\.git(?:#|$)/i;

function issue(code, file, message) {
  return { code, file, message };
}

function posixPath(value) {
  return value.split(sep).join("/");
}

function readBounded(path, maxBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  if (stat.size > maxBytes) throw new Error(`${path} exceeds ${maxBytes} bytes`);
  return readFileSync(path, "utf8");
}

function parseJson(path) {
  return JSON.parse(readBounded(path, MAX_MANIFEST_BYTES));
}

function parseTopLevelScalar(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`^${escaped}:\\s*([^#\\r\\n]+?)\\s*$`, "gm"))];
  if (matches.length !== 1) return undefined;
  const raw = matches[0][1].trim().replace(/^(['"])(.*)\1$/, "$2");
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

function runPnpm(root, args) {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: { ...process.env, CI: "true" },
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: (result.stdout ?? "").slice(0, MAX_COMMAND_OUTPUT_BYTES),
    stderr: (result.stderr ?? "").slice(0, MAX_COMMAND_OUTPUT_BYTES),
  };
}

function workspacePatternToRegex(pattern) {
  let input = pattern.replace(/^\.\//, "").replace(/\\/g, "/");
  let output = "^";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "*" && input[index + 1] === "*") {
      output += ".*";
      index += 1;
    } else if (char === "*") {
      output += "[^/]*";
    } else if (char === "?") {
      output += "[^/]";
    } else {
      output += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${output}$`);
}

function isWorkspacePath(path, patterns) {
  const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negatives = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  return positives.some((pattern) => workspacePatternToRegex(pattern).test(path))
    && !negatives.some((pattern) => workspacePatternToRegex(pattern).test(path));
}

function collectManifestPaths(root) {
  const output = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith("_tmp_")) continue;
        walk(resolve(directory, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name === "package.json") {
        output.push(resolve(directory, entry.name));
        if (output.length > MAX_MANIFESTS) throw new Error(`workspace exceeds ${MAX_MANIFESTS} manifests`);
      }
    }
  };
  walk(root);
  return output.sort();
}

function resolveCatalogSpecifier(name, specifier, config) {
  if (specifier === "catalog:") return config.catalog?.[name];
  const catalogName = specifier.slice("catalog:".length);
  return config.catalogs?.[catalogName]?.[name];
}

function checkDirectSpecifier({ name, specifier, field, manifestPath, packageNames, config }) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    return issue("SC_INVALID_SPECIFIER", manifestPath, `${field}.${name} must be a non-empty string`);
  }
  if (EXOTIC_SOURCE.test(specifier)) {
    return issue("SC_EXOTIC_SOURCE", manifestPath, `${field}.${name} uses forbidden source ${JSON.stringify(specifier)}`);
  }
  if (specifier.startsWith("workspace:")) {
    if (!packageNames.has(name)) {
      return issue("SC_WORKSPACE_TARGET_MISSING", manifestPath, `${field}.${name} targets no workspace package`);
    }
    if (specifier !== "workspace:*") {
      return issue("SC_WORKSPACE_PROTOCOL", manifestPath, `${field}.${name} must use workspace:*; found ${JSON.stringify(specifier)}`);
    }
    return undefined;
  }
  if (packageNames.has(name)) {
    return issue("SC_WORKSPACE_PROTOCOL", manifestPath, `${field}.${name} is internal and must use workspace:*`);
  }
  if (specifier.startsWith("catalog:")) {
    const resolved = resolveCatalogSpecifier(name, specifier, config);
    if (typeof resolved !== "string" || !EXACT_SEMVER.test(resolved)) {
      return issue("SC_CATALOG_NOT_EXACT", manifestPath, `${field}.${name} resolves through ${specifier} to a non-exact or missing catalog entry`);
    }
    return undefined;
  }
  if (!EXACT_SEMVER.test(specifier)) {
    return issue("SC_DEP_NOT_EXACT", manifestPath, `${field}.${name} must be an exact semver, catalog reference, or workspace:*; found ${JSON.stringify(specifier)}`);
  }
  return undefined;
}

function checkPeerSpecifier({ name, specifier, field, manifestPath, packageNames }) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    return issue("SC_INVALID_SPECIFIER", manifestPath, `${field}.${name} must be a non-empty string`);
  }
  if (EXOTIC_SOURCE.test(specifier)) {
    return issue("SC_EXOTIC_SOURCE", manifestPath, `${field}.${name} uses forbidden source ${JSON.stringify(specifier)}`);
  }
  if (specifier.startsWith("workspace:") && (!packageNames.has(name) || specifier !== "workspace:*")) {
    return issue("SC_WORKSPACE_PROTOCOL", manifestPath, `${field}.${name} has an invalid workspace protocol`);
  }
  return undefined;
}

function parsePackageManager(value) {
  const match = /^pnpm@(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  return { version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) };
}

function parseLockfileVersion(source) {
  const match = /^lockfileVersion:\s*['"]?([^'"\s#]+)['"]?\s*$/m.exec(source);
  return match?.[1];
}

function isExactReleaseAgeExclusion(value) {
  if (typeof value !== "string" || value.includes("||") || value.includes("*")) return false;
  const separator = value.lastIndexOf("@");
  return separator > 0 && EXACT_SEMVER.test(value.slice(separator + 1));
}

function readEffectiveConfig(root, issues) {
  const result = runPnpm(root, ["config", "list", "--location", "project", "--json"]);
  if (result.error || result.status !== 0) {
    issues.push(issue("SC_PNPM_CONFIG_UNREADABLE", "pnpm-workspace.yaml", `pnpm config failed: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`));
    return {};
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    issues.push(issue("SC_PNPM_CONFIG_UNREADABLE", "pnpm-workspace.yaml", `pnpm config returned invalid JSON: ${error.message}`));
    return {};
  }
}

function checkProjectConfig(root, workspaceSource, effectiveConfig, issues) {
  const required = [
    ["saveExact", true],
    ["resolutionMode", "time-based"],
    ["minimumReleaseAgeStrict", true],
    ["minimumReleaseAgeIgnoreMissingTime", false],
    ["trustLockfile", false],
    ["blockExoticSubdeps", true],
  ];
  for (const [key, expected] of required) {
    const declared = parseTopLevelScalar(workspaceSource, key);
    if (declared !== expected || effectiveConfig[key] !== expected) {
      issues.push(issue("SC_CONFIG_POLICY", "pnpm-workspace.yaml", `${key} must be declared and effectively resolve to ${JSON.stringify(expected)}`));
    }
  }
  const declaredAge = parseTopLevelScalar(workspaceSource, "minimumReleaseAge");
  if (typeof declaredAge !== "number" || declaredAge < 1440 || Number(effectiveConfig.minimumReleaseAge) < 1440) {
    issues.push(issue("SC_CONFIG_POLICY", "pnpm-workspace.yaml", "minimumReleaseAge must be at least 1440 minutes"));
  }
  const exclusions = effectiveConfig.minimumReleaseAgeExclude ?? [];
  if (!Array.isArray(exclusions) || exclusions.some((entry) => !isExactReleaseAgeExclusion(entry))) {
    issues.push(issue("SC_RELEASE_AGE_EXCEPTION", "pnpm-workspace.yaml", "minimumReleaseAgeExclude entries must pin one exact package version; names, ranges, patterns, and disjunctions are forbidden"));
  }
  const overrides = effectiveConfig.overrides ?? {};
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    issues.push(issue("SC_OVERRIDE_POLICY", "pnpm-workspace.yaml", "overrides must be an object when present"));
  } else {
    for (const [selector, value] of Object.entries(overrides)) {
      if (typeof value !== "string" || EXOTIC_SOURCE.test(value) || (value !== "-" && !EXACT_SEMVER.test(value))) {
        issues.push(issue("SC_OVERRIDE_POLICY", "pnpm-workspace.yaml", `override ${selector} must be an exact semver or the removal marker; found ${JSON.stringify(value)}`));
      }
    }
  }

  const npmrcPath = resolve(root, ".npmrc");
  try {
    const npmrc = readBounded(npmrcPath, MAX_CONFIG_BYTES);
    const exactEntries = [...npmrc.matchAll(/^save-exact\s*=\s*([^#\r\n]+?)\s*$/gm)];
    if (exactEntries.length !== 1 || exactEntries[0][1].trim() !== "true") {
      issues.push(issue("SC_NPMRC_POLICY", ".npmrc", "save-exact=true must appear exactly once as the npm compatibility fallback"));
    }
  } catch (error) {
    issues.push(issue("SC_NPMRC_POLICY", ".npmrc", error.message));
  }
}

function checkManifests(root, manifestPaths, workspacePatterns, config, issues) {
  const manifests = [];
  const packageNames = new Set();
  for (const path of manifestPaths) {
    const displayPath = posixPath(relative(root, path)) || "package.json";
    try {
      const manifest = parseJson(path);
      manifests.push({ path: displayPath, manifest });
      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        issues.push(issue("SC_MANIFEST_NAME", displayPath, "workspace manifest requires a non-empty name"));
      } else if (packageNames.has(manifest.name)) {
        issues.push(issue("SC_DUPLICATE_PACKAGE", displayPath, `duplicate workspace package name ${manifest.name}`));
      } else {
        packageNames.add(manifest.name);
      }
      const directory = posixPath(relative(root, resolve(path, ".."))) || ".";
      if (directory !== "." && !isWorkspacePath(directory, workspacePatterns)) {
        issues.push(issue("SC_MANIFEST_OUTSIDE_WORKSPACE", displayPath, `${directory} is not selected by pnpm workspace patterns`));
      }
    } catch (error) {
      issues.push(issue("SC_MANIFEST_UNREADABLE", displayPath, error.message));
    }
  }

  for (const { path, manifest } of manifests) {
    for (const field of ALL_DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (dependencies === undefined) continue;
      if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
        issues.push(issue("SC_INVALID_DEPENDENCY_MAP", path, `${field} must be an object`));
        continue;
      }
      for (const [name, specifier] of Object.entries(dependencies)) {
        const found = field === "peerDependencies"
          ? checkPeerSpecifier({ name, specifier, field, manifestPath: path, packageNames })
          : checkDirectSpecifier({ name, specifier, field, manifestPath: path, packageNames, config });
        if (found) issues.push(found);
      }
    }
  }
  return manifests;
}

export function verifySupplyChain(rootDirectory = process.cwd(), options = {}) {
  const root = realpathSync(resolve(rootDirectory));
  const issues = [];
  let workspaceSource = "";
  let lockfileSource = "";
  let rootManifest = {};
  try {
    workspaceSource = readBounded(resolve(root, "pnpm-workspace.yaml"), MAX_CONFIG_BYTES);
  } catch (error) {
    issues.push(issue("SC_WORKSPACE_UNREADABLE", "pnpm-workspace.yaml", error.message));
  }
  try {
    lockfileSource = readBounded(resolve(root, "pnpm-lock.yaml"), MAX_LOCKFILE_BYTES);
  } catch (error) {
    issues.push(issue("SC_LOCKFILE_UNREADABLE", "pnpm-lock.yaml", error.message));
  }
  try {
    rootManifest = parseJson(resolve(root, "package.json"));
  } catch (error) {
    issues.push(issue("SC_MANIFEST_UNREADABLE", "package.json", error.message));
  }

  const config = workspaceSource ? readEffectiveConfig(root, issues) : {};
  if (workspaceSource) checkProjectConfig(root, workspaceSource, config, issues);
  const workspacePatterns = Array.isArray(config.packages) ? config.packages : [];
  if (workspacePatterns.length === 0 || workspacePatterns.some((entry) => typeof entry !== "string")) {
    issues.push(issue("SC_WORKSPACE_PATTERNS", "pnpm-workspace.yaml", "packages must contain at least one string pattern"));
  }

  let manifestPaths = [];
  try {
    manifestPaths = collectManifestPaths(root);
  } catch (error) {
    issues.push(issue("SC_MANIFEST_SCAN", ".", error.message));
  }
  const manifests = checkManifests(root, manifestPaths, workspacePatterns, config, issues);

  const packageManager = parsePackageManager(rootManifest.packageManager);
  if (!packageManager || packageManager.major !== REQUIRED_PNPM_MAJOR) {
    issues.push(issue("SC_PACKAGE_MANAGER", "package.json", `packageManager must pin pnpm ${REQUIRED_PNPM_MAJOR}.x as pnpm@x.y.z`));
  }
  const lockfileVersion = parseLockfileVersion(lockfileSource);
  if (lockfileVersion !== EXPECTED_LOCKFILE_VERSION) {
    issues.push(issue("SC_LOCKFILE_VERSION", "pnpm-lock.yaml", `pnpm ${REQUIRED_PNPM_MAJOR}.x requires reviewed lockfileVersion ${EXPECTED_LOCKFILE_VERSION}; found ${JSON.stringify(lockfileVersion)}`));
  }
  if (packageManager) {
    const versionResult = runPnpm(root, ["--version"]);
    if (versionResult.error || versionResult.status !== 0 || versionResult.stdout.trim() !== packageManager.version) {
      issues.push(issue("SC_PNPM_VERSION", "package.json", `active pnpm must equal packageManager ${packageManager.version}; found ${JSON.stringify(versionResult.stdout.trim() || versionResult.error?.message || versionResult.stderr.trim())}`));
    }
  }

  if (issues.length === 0 && options.frozenLockfile !== false) {
    const frozenResult = runPnpm(root, [
      "install",
      "--lockfile-only",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--trust-lockfile",
    ]);
    if (frozenResult.error || frozenResult.status !== 0) {
      const detail = frozenResult.error?.message ?? frozenResult.stderr.trim() ?? frozenResult.stdout.trim() ?? `exit ${frozenResult.status}`;
      issues.push(issue("SC_FROZEN_LOCKFILE", "pnpm-lock.yaml", `offline frozen-lockfile verification failed: ${detail.slice(0, 2000)}`));
    }
  }

  return {
    ok: issues.length === 0,
    root,
    packageManager: packageManager?.version,
    lockfileVersion,
    manifestCount: manifests.length,
    issues,
  };
}

function parseArguments(argv) {
  const output = { root: process.cwd(), json: false, frozenLockfile: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") output.json = true;
    else if (argument === "--skip-frozen") output.frozenLockfile = false;
    else if (argument === "--root" && argv[index + 1]) output.root = argv[++index];
    else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return output;
}

function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
    if (!existsSync(args.root)) throw new Error(`root does not exist: ${args.root}`);
    const result = verifySupplyChain(args.root, { frozenLockfile: args.frozenLockfile });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`[supply-chain] PASS: ${result.manifestCount} manifests, pnpm ${result.packageManager}, lockfile ${result.lockfileVersion}\n`);
    } else {
      process.stderr.write(`[supply-chain] FAIL: ${result.issues.length} policy violation(s)\n`);
      for (const found of result.issues) {
        process.stderr.write(`- ${found.code} ${found.file}: ${found.message}\n`);
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`[supply-chain] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
