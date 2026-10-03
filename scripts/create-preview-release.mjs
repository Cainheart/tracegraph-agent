#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { verifyRelease } from "./verify-release.mjs";

const self = fileURLToPath(import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function createPreviewRelease(root, output) {
  root = resolve(root);
  const release = await verifyRelease(root);
  const destination = output === undefined ? await mkdtemp(join(tmpdir(), "outlive-preview-release-")) : resolve(output);
  if (output !== undefined) await mkdir(destination, { recursive: false, mode: 0o700 });
  const name = `outlive-agent-${release.version}-preview`;
  const stage = join(destination, name);
  await mkdir(stage, { mode: 0o700 });
  const copies = new Set(release.files.map(({ path }) => path));
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "docs/releases/README.md", "docs/releases/KNOWN-LIMITATIONS.md", "scripts/prepare-native.mjs", "scripts/preview-install.mjs", "scripts/preview-smoke.mjs", "scripts/verify-preview-integrity.mjs", "demos/proofs.mjs"]) copies.add(path);
  // Bounded public fixture resources are consumed by the installed Test Support
  // helper. They are data for reproducible workflows, not application source.
  for (const path of ["README.md", "README.zh.md", "tsconfig.json", "src/add.ts", "src/index.ts", "test/run.mjs"]) copies.add(`examples/failing-typescript-repo/${path}`);
  const manifests = [];
  for (const scope of ["apps", "packages", "examples"]) {
    for (const entry of await readdir(join(root, scope), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = `${scope}/${entry.name}/package.json`;
      try {
        const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
        manifests.push({ path, manifest }); copies.add(path);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  for (const path of copies) {
    const source = join(root, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe release input: ${path}`);
    const target = join(stage, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    const expected = release.files.find((entry) => entry.path === path);
    if (expected !== undefined) {
      const bytes = await readFile(target);
      if (bytes.length !== expected.byte_length || sha256(bytes) !== expected.sha256) throw new Error(`Build output changed while staging: ${path}`);
    }
  }
  // Imported scripts remain the exact workspace versions; no generated runtime code.
  await writeFile(join(stage, "INSTALL.txt"), "Read docs/releases/README.md. Run node scripts/preview-install.mjs (CLI/Host), or add --desktop to explicitly download Electron. Then run node scripts/preview-smoke.mjs. This unsigned private preview is not a clean-machine certification.\n");
  const lock = parse(await readFile(join(root, "pnpm-lock.yaml"), "utf8"));
  const sbom = createSbom(release.version, lock, manifests);
  await writeFile(join(stage, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
  const inventory = await hashPreviewTree(stage);
  await writeFile(join(stage, "SHA256SUMS"), inventory.map(({ path, sha256: hash }) => `${hash}  ${path}`).join("\n") + "\n");
  await writeFile(join(destination, "release-manifest.json"), `${JSON.stringify({
    schema_version: "tracegraph.preview-release.v1", version: release.version,
    distribution_mode: "private-installable-workspace-preview", archive_root: name,
    supported_smoke: "fresh-directory install on maintainer machine; clean-machine and non-maintainer acceptance remain separate",
    artifact_files: inventory.length + 1, files: inventory,
    limitations: "docs/releases/KNOWN-LIMITATIONS.md", sbom: "sbom.cdx.json",
  }, null, 2)}\n`);
  const archive = `${name}.tar.gz`;
  await command("tar", [...(process.platform === "darwin" ? ["--no-mac-metadata"] : []), "-czf", join(destination, archive), "-C", destination, name], destination);
  const archiveHash = sha256(await readFile(join(destination, archive)));
  await writeFile(join(destination, "SHA256SUMS"), `${archiveHash}  ${archive}\n${sha256(await readFile(join(destination, "release-manifest.json")))}  release-manifest.json\n`);
  return { directory: destination, archive: join(destination, archive), stage, sha256: archiveHash, version: release.version };
}

export function createSbom(version, lock, manifests) {
  const components = [];
  for (const { path, manifest } of manifests) components.push({ type: "application", "bom-ref": `workspace:${manifest.name}`, name: manifest.name, version: manifest.version, properties: [{ name: "outlive:workspace-manifest", value: path }] });
  for (const [identity, entry] of Object.entries(lock.packages ?? {})) {
    const split = identity.lastIndexOf("@");
    if (split <= 0) throw new Error(`Unrecognized registry lock identity: ${identity}`);
    const name = identity.slice(0, split), dependencyVersion = identity.slice(split + 1);
    const integrity = entry.resolution?.integrity;
    const hashes = typeof integrity === "string" && /^sha512-[A-Za-z0-9+/=]+$/u.test(integrity) ? [{ alg: "SHA-512", content: Buffer.from(integrity.slice(7), "base64").toString("hex") }] : [];
    components.push({ type: "library", "bom-ref": `npm:${identity}`, name, version: dependencyVersion, purl: `pkg:npm/${name.replace("@", "%40")}@${dependencyVersion}`, ...(hashes.length ? { hashes } : {}) });
  }
  components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  return { bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: { component: { type: "application", name: "outlive-agent-private-preview", version }, properties: [
      { name: "outlive:inventory-scope", value: "all pinned pnpm lockfile packages including dev/optional dependencies and workspace packages" },
      { name: "outlive:external-runtime", value: "Node.js, pnpm, and optionally the Electron platform binary are installed separately; no complete OS/native-binary inventory claim" },
    ] }, components };
}

export async function hashPreviewTree(root, prefix = "") {
  const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Preview source contains symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await hashPreviewTree(root, path));
    else if (entry.isFile()) { const bytes = await readFile(join(root, path)); files.push({ path, byte_length: bytes.length, sha256: sha256(bytes) }); }
    else throw new Error(`Preview source is not a regular file: ${path}`);
  }
  return files;
}
async function command(file, args, cwd) { const child = spawn(file, args, { cwd, stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } }); await new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? done() : reject(new Error(`${file} failed: ${code ?? signal}`))); }); }

if (resolve(process.argv[1] ?? "") === self) {
  if (process.argv.length > 4 || (process.argv[2] !== undefined && process.argv[2] !== "--output")) throw new Error("Usage: node scripts/create-preview-release.mjs [--output NEW_DIRECTORY]");
  process.stdout.write(`${JSON.stringify(await createPreviewRelease(process.cwd(), process.argv[3]), null, 2)}\n`);
}
