import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** Verify the extracted, prebuilt inventory before installation or smoke. */
export async function verifyPreviewIntegrity(root, { installed = false } = {}) {
  const canonicalRoot = await realpath(root);
  let checksums;
  try {
    const info = await lstat(join(root, "SHA256SUMS"));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Checksum inventory must be a regular file");
    checksums = await readFile(join(root, "SHA256SUMS"), "utf8");
  }
  catch (error) { throw new Error("An extracted preview SHA256SUMS inventory is required; source checkout is not an install artifact", { cause: error }); }
  if (Buffer.byteLength(checksums) > 1024 * 1024) throw new Error("Preview checksum inventory is too large");
  const lines = checksums.trim().split("\n");
  if (lines.length > 4_096) throw new Error("Preview checksum inventory exceeds 4096 entries");
  const names = new Set();
  let total = 0;
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    if (match === null || match[2].startsWith("/") || match[2].includes("\\") || match[2].split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error("Invalid preview checksum entry");
    if (names.has(match[2])) throw new Error("Duplicate preview checksum entry");
    names.add(match[2]);
    const path = join(root, match[2]);
    const stat = await lstat(path), canonical = await realpath(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !canonical.startsWith(canonicalRoot + sep)) throw new Error(`Unsafe preview file: ${match[2]}`);
    if (stat.size > 32 * 1024 * 1024 || (total += stat.size) > 256 * 1024 * 1024) throw new Error("Preview inventory byte limit exceeded");
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== match[1]) throw new Error(`Preview checksum mismatch: ${match[2]}`);
  }
  for (const path of ["package.json", "pnpm-lock.yaml", "apps/cli/dist/index.js", "apps/desktop/dist/main.js", "apps/desktop/dist/preload.cjs", "apps/desktop/dist/renderer/index.html", "sbom.cdx.json"]) {
    if (!names.has(path)) throw new Error(`Preview inventory lacks required runtime entry: ${path}`);
  }
  const directories = new Set();
  const dependencyRoots = new Set(["node_modules"]);
  for (const name of names) {
    for (let parent = dirname(name); parent !== "."; parent = dirname(parent)) directories.add(parent);
    if (/^(?:apps|packages|examples)\/[^/]+\/package\.json$/u.test(name)) dependencyRoots.add(`${dirname(name)}/node_modules`);
  }
  await assertClosedTree(root, "", names, directories, installed ? dependencyRoots : new Set());
  return { file_count: names.size, total_bytes: total };
}

async function assertClosedTree(root, prefix, names, directories, dependencyRoots) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unsafe preview tree symlink: ${path}`);
    if (dependencyRoots.has(path) && entry.isDirectory()) continue;
    if (entry.isDirectory() && directories.has(path)) {
      await assertClosedTree(root, path, names, directories, dependencyRoots);
    } else if (entry.isFile() && (names.has(path) || path === "SHA256SUMS")) {
      continue;
    } else {
      throw new Error(`Unlisted preview entry: ${path}`);
    }
  }
}
