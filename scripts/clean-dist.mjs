#!/usr/bin/env node

import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const MAX_PACKAGES = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;

export async function cleanDistributionDirectories(rootDirectory = DEFAULT_ROOT) {
  const root = await realpath(resolve(rootDirectory));
  const targets = [];
  for (const scope of ["apps", "packages"]) {
    const scopeRoot = join(root, scope);
    const entries = await readdir(scopeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const packageRoot = join(scopeRoot, entry.name);
      if (!await hasSafeManifest(packageRoot)) continue;
      const target = join(packageRoot, "dist");
      assertScopedTarget(root, target);
      targets.push(target);
      if (targets.length > MAX_PACKAGES) throw new Error(`Refusing to clean more than ${MAX_PACKAGES} workspace dist directories`);
    }
  }

  const existingTargets = [];
  for (const target of targets) {
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing unsafe dist target: ${display(root, target)}`);
    }
    existingTargets.push(target);
  }

  const removed = [];
  for (const target of existingTargets) {
    await rm(target, { recursive: true, force: false, maxRetries: 2 });
    removed.push(display(root, target));
  }
  return removed;
}

async function hasSafeManifest(packageRoot) {
  const path = join(packageRoot, "package.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return false;
    const manifest = JSON.parse(await readFile(path, "utf8"));
    return typeof manifest.name === "string" && manifest.name.length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertScopedTarget(root, target) {
  const path = display(root, target);
  if (!/^(?:apps|packages)\/[^/]+\/dist$/u.test(path)) {
    throw new Error(`Dist target escapes the workspace package boundary: ${path}`);
  }
}

function display(root, path) {
  return relative(root, path).split(sep).join("/");
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    const removed = await cleanDistributionDirectories(process.cwd());
    process.stdout.write(`[clean-dist] removed ${removed.length} generated director${removed.length === 1 ? "y" : "ies"}\n`);
  } catch (error) {
    process.stderr.write(`[clean-dist] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
