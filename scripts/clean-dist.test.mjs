import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanDistributionDirectories } from "./clean-dist.mjs";

test("clean-dist removes only generated directories owned by manifests", async () => {
  const root = await fixture();
  try {
    const removed = await cleanDistributionDirectories(root);
    assert.deepEqual(removed, ["apps/web/dist", "packages/core/dist"]);
    await assert.rejects(lstat(join(root, "apps/web/dist")), { code: "ENOENT" });
    await assert.rejects(lstat(join(root, "packages/core/dist")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "packages/rogue/dist/keep.txt"), "utf8"), "keep\n");
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "source\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean-dist rejects a symlink target without touching its destination", async () => {
  const root = await fixture({ webDist: false });
  const external = await mkdtemp(join(tmpdir(), "tracegraph-clean-external-"));
  try {
    await writeFile(join(external, "keep.txt"), "external\n", "utf8");
    await symlink(external, join(root, "apps/web/dist"));
    await assert.rejects(cleanDistributionDirectories(root), /unsafe dist target/u);
    assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("clean-dist preflights every target before deleting an earlier directory", async () => {
  const root = await fixture({ coreDist: false });
  const external = await mkdtemp(join(tmpdir(), "tracegraph-clean-external-"));
  try {
    await writeFile(join(external, "keep.txt"), "external\n", "utf8");
    await symlink(external, join(root, "packages/core/dist"));
    await assert.rejects(cleanDistributionDirectories(root), /unsafe dist target/u);
    assert.equal(await readFile(join(root, "apps/web/dist/output.js"), "utf8"), "export {};\n");
    assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-clean-dist-"));
  for (const scope of ["apps", "packages"]) await mkdir(join(root, scope), { recursive: true });
  await createPackage(root, "apps/web", options.webDist !== false);
  await createPackage(root, "packages/core", options.coreDist !== false);
  await mkdir(join(root, "packages/rogue/dist"), { recursive: true });
  await writeFile(join(root, "packages/rogue/dist/keep.txt"), "keep\n", "utf8");
  await writeFile(join(root, "source.txt"), "source\n", "utf8");
  return root;
}

async function createPackage(root, relativePath, withDist) {
  const packageRoot = join(root, relativePath);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: `@fixture/${relativePath.replace("/", "-")}` })}\n`, "utf8");
  if (withDist) {
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "dist/output.js"), "export {};\n", "utf8");
  }
}
