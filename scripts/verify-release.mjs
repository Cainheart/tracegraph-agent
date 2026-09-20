import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RELEASE_FILES = 4_096;
const MAX_RELEASE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RELEASE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export async function verifyRelease(root, options = {}) {
  const canonicalRoot = resolve(root);
  const rootManifest = await readJson(join(canonicalRoot, "package.json"));
  const version = requireString(rootManifest.version, "root package version");
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (rootManifest.private !== true) throw new Error("The workspace root must remain private");
  if (!/^pnpm@\d+\.\d+\.\d+$/u.test(rootManifest.packageManager ?? "")) {
    throw new Error("packageManager must pin one exact pnpm version");
  }

  const expectedTag = `v${version}`;
  if (options.tag !== undefined && options.tag !== expectedTag) {
    throw new Error(`Release tag ${options.tag} does not match ${expectedTag}`);
  }

  const changelog = await readBounded(join(canonicalRoot, "CHANGELOG.md"), 512 * 1024);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu").test(changelog)) {
    throw new Error(`CHANGELOG.md has no dated entry for ${version}`);
  }

  for (const required of ["README.md", "README.en.md", "LICENSE", "NOTICE.md", "docs/README.md"]) {
    await requireRegularFile(join(canonicalRoot, required), required);
  }

  const packageManifests = await discoverPackageManifests(canonicalRoot);
  for (const entry of packageManifests) {
    const manifest = await readJson(entry.path);
    if (manifest.private !== true) throw new Error(`${entry.relativePath} must remain private`);
    if (manifest.version !== version) {
      throw new Error(`${entry.relativePath} version ${String(manifest.version)} does not match ${version}`);
    }
    for (const target of collectDistributionTargets(manifest)) {
      await requireRegularFile(join(dirname(entry.path), target), `${entry.relativePath}:${target}`);
    }
    if (entry.relativePath === "apps/web/package.json") {
      await requireRegularFile(join(dirname(entry.path), "dist/index.html"), "apps/web/dist/index.html");
    }
  }

  const releaseManifest = await createReleaseManifest(canonicalRoot, {
    version,
    nodeEngine: rootManifest.engines?.node,
    packageManager: rootManifest.packageManager,
  }, packageManifests.map((entry) => dirname(entry.path)));

  if (options.writeManifest === true) {
    await writeReleaseBundle(canonicalRoot, releaseManifest);
    const output = join(canonicalRoot, "_tmp_release", "release-manifest.json");
    await atomicWriteJson(output, releaseManifest);
  }
  return releaseManifest;
}

export async function createReleaseManifest(root, metadata, packageDirectories) {
  const files = [];
  for (const directory of packageDirectories) {
    await collectFiles(root, join(directory, "dist"), files);
  }
  for (const path of ["README.md", "README.en.md", "CHANGELOG.md", "LICENSE", "NOTICE.md"]) {
    await addFile(root, join(root, path), files);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = files.reduce((sum, entry) => sum + entry.byte_length, 0);
  if (files.length > MAX_RELEASE_FILES) throw new Error(`Release exceeds ${MAX_RELEASE_FILES} files`);
  if (totalBytes > MAX_RELEASE_TOTAL_BYTES) throw new Error(`Release exceeds ${MAX_RELEASE_TOTAL_BYTES} bytes`);
  return {
    schema_version: "tracegraph.release-manifest.v1",
    version: metadata.version,
    node_engine: metadata.nodeEngine,
    package_manager: metadata.packageManager,
    distribution_mode: "private-workspace-build-artifact",
    bundle_root: "bundle",
    file_count: files.length,
    total_bytes: totalBytes,
    files,
  };
}

async function discoverPackageManifests(root) {
  const result = [];
  for (const scope of ["apps", "packages"]) {
    const scopeRoot = join(root, scope);
    for (const name of await sortedDirectoryNames(scopeRoot)) {
      const path = join(scopeRoot, name, "package.json");
      try {
        await requireRegularFile(path, `${scope}/${name}/package.json`);
        result.push({ path, relativePath: `${scope}/${name}/package.json` });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return result;
}

function collectDistributionTargets(manifest) {
  const targets = new Set();
  collectExportStrings(manifest.exports, targets);
  if (typeof manifest.bin === "string") targets.add(manifest.bin);
  if (manifest.bin !== null && typeof manifest.bin === "object") {
    for (const value of Object.values(manifest.bin)) if (typeof value === "string") targets.add(value);
  }
  for (const target of targets) {
    if (!target.startsWith("./dist/")
      || target === "./dist/"
      || target.includes("\\")
      || target.split("/").includes("..")) {
      throw new Error(`Published bin/export target must be a normalized ./dist path: ${target}`);
    }
  }
  return [...targets];
}

function collectExportStrings(value, targets) {
  if (typeof value === "string") {
    targets.add(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) collectExportStrings(child, targets);
}

async function collectFiles(root, directory, result) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Release directory is unsafe: ${safeRelative(root, directory)}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release contains symlink: ${safeRelative(root, path)}`);
    if (entry.isDirectory()) await collectFiles(root, path, result);
    else if (entry.isFile()) await addFile(root, path, result);
  }
}

async function addFile(root, path, result) {
  if (result.length >= MAX_RELEASE_FILES) throw new Error(`Release exceeds ${MAX_RELEASE_FILES} files`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release entry is not a regular file: ${safeRelative(root, path)}`);
  if (info.size > MAX_RELEASE_FILE_BYTES) throw new Error(`Release file exceeds ${MAX_RELEASE_FILE_BYTES} bytes: ${safeRelative(root, path)}`);
  const bytes = await readFile(path);
  const relativePath = safeRelative(root, path);
  if (relativePath.length > 512 || /[\u0000-\u001f\u007f]/u.test(relativePath)) {
    throw new Error(`Release path is not bounded and printable: ${relativePath.slice(0, 80)}`);
  }
  result.push({
    path: relativePath,
    byte_length: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function sortedDirectoryNames(path) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readJson(path) {
  return JSON.parse(await readBounded(path, MAX_MANIFEST_BYTES));
}

async function readBounded(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-regular file: ${path}`);
  if (info.size > limit) throw new Error(`File exceeds ${limit} bytes: ${path}`);
  return readFile(path, "utf8");
}

async function requireRegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Missing safe release file: ${label}`);
  return stat(path);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${label}`);
  return value;
}

function safeRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../")) throw new Error(`Path escapes release root: ${path}`);
  return value;
}

async function atomicWriteJson(path, value) {
  await ensureSafeDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, serializeReleaseManifest(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function serializeReleaseManifest(value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RELEASE_MANIFEST_BYTES) {
    throw new Error(`Release manifest exceeds ${MAX_RELEASE_MANIFEST_BYTES} bytes`);
  }
  return serialized;
}

async function writeReleaseBundle(root, manifest) {
  const outputRoot = join(root, "_tmp_release");
  await ensureSafeDirectory(outputRoot);
  const finalRoot = join(outputRoot, manifest.bundle_root);
  const temporaryRoot = join(outputRoot, `bundle.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(temporaryRoot, { mode: 0o700 });
  try {
    for (const entry of manifest.files) {
      const source = join(root, entry.path);
      const destination = join(temporaryRoot, entry.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      const bytes = await readFile(destination);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== entry.byte_length || digest !== entry.sha256) {
        throw new Error(`Release source changed while staging: ${entry.path}`);
      }
    }
    try {
      const existing = await lstat(finalRoot);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error("Refusing unsafe existing release bundle target");
      }
      await rm(finalRoot, { recursive: true, force: false });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(temporaryRoot, finalRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function ensureSafeDirectory(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing unsafe directory: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing unsafe directory: ${path}`);
  }
}

function parseArguments(argv) {
  const options = { writeManifest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write-manifest") options.writeManifest = true;
    else if (argument === "--check") options.writeManifest = false;
    else if (argument === "--tag") options.tag = argv[++index];
    else throw new Error(`Unknown release argument: ${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = await verifyRelease(process.cwd(), options);
    process.stdout.write(`Release verification passed for v${manifest.version} (${manifest.file_count} files, ${manifest.total_bytes} bytes)\n`);
  } catch (error) {
    process.stderr.write(`Release verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
