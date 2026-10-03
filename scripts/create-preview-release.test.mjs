import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createSbom, hashPreviewTree } from "./create-preview-release.mjs";
import { verifyPreviewIntegrity } from "./verify-preview-integrity.mjs";
import { publishAfterSmokeCleanup } from "./preview-smoke.mjs";

test("SBOM names pinned scoped registry packages and preserves integrity hashes", () => {
  const sbom = createSbom("0.1.0-alpha.0", { packages: { "@scope/library@1.2.3": { resolution: { integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` } } } }, [{ path: "packages/core/package.json", manifest: { name: "@tracegraph/core", version: "0.1.0-alpha.0" } }]);
  assert.equal(sbom.bomFormat, "CycloneDX");
  const registry = sbom.components.find(({ type }) => type === "library");
  assert.equal(registry.name, "@scope/library");
  assert.equal(registry.version, "1.2.3");
  assert.equal(registry.purl, "pkg:npm/%40scope/library@1.2.3");
  assert.equal(registry.hashes[0].content, "01".repeat(64));
});

test("preview inventory rejects symlink sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "outlive-preview-inventory-test-"));
  try {
    await writeFile(join(root, "real.js"), "export {};\n");
    await symlink(join(root, "real.js"), join(root, "linked.js"));
    await assert.rejects(hashPreviewTree(root), /symlink/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installer rejects modified dist bytes before running dependency installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "outlive-preview-tamper-test-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "apps/cli/dist"), { recursive: true });
    await copyFile(new URL("./preview-install.mjs", import.meta.url), join(root, "scripts/preview-install.mjs"));
    await copyFile(new URL("./verify-preview-integrity.mjs", import.meta.url), join(root, "scripts/verify-preview-integrity.mjs"));
    const intended = "console.log('reviewed artifact');\n";
    const hash = createHash("sha256").update(intended).digest("hex");
    await writeFile(join(root, "SHA256SUMS"), `${hash}  apps/cli/dist/index.js\n`);
    await writeFile(join(root, "apps/cli/dist/index.js"), "throw new Error('tampered');\n");
    const result = spawnSync(process.execPath, [join(root, "scripts/preview-install.mjs")], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Preview checksum mismatch: apps\/cli\/dist\/index.js/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("smoke refuses source directories without a release inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "outlive-preview-source-negative-"));
  try {
    await assert.rejects(verifyPreviewIntegrity(root), /source checkout is not an install artifact/u);
    await writeFile(join(root, "package.json"), "{}\n");
    const hash = createHash("sha256").update("{}\n").digest("hex");
    await writeFile(join(root, "SHA256SUMS"), `${hash}  package.json\n`);
    await assert.rejects(verifyPreviewIntegrity(root), /lacks required runtime entry/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("valid checksums never permit unlisted pnpm hooks, configs, workspace manifests or source files", async (t) => {
  for (const extra of [".pnpmfile.cjs", "apps/cli/.npmrc", "packages/injected/package.json", "apps/cli/dist/extra.js"]) {
    await t.test(extra, async () => {
      const root = await closedPreviewFixture();
      try {
        await mkdir(dirname(join(root, extra)), { recursive: true });
        await writeFile(join(root, extra), "unreviewed installation input\n");
        await assert.rejects(verifyPreviewIntegrity(root), /Unlisted preview entry/u);
        await assert.rejects(verifyPreviewIntegrity(root, { installed: true }), /Unlisted preview entry/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

test("installed smoke permits only real node_modules roots of declared workspace packages", async () => {
  const root = await closedPreviewFixture();
  try {
    await mkdir(join(root, "apps/cli/node_modules/dependency"), { recursive: true });
    await writeFile(join(root, "apps/cli/node_modules/dependency/index.js"), "export {};\n");
    await assert.rejects(verifyPreviewIntegrity(root), /Unlisted preview entry/u);
    await verifyPreviewIntegrity(root, { installed: true });
    await mkdir(join(root, "apps/cli/dist/node_modules"));
    await assert.rejects(verifyPreviewIntegrity(root, { installed: true }), /Unlisted preview entry/u);
    await rm(join(root, "apps/cli/dist/node_modules"), { recursive: true });
    await symlink(join(root, "apps/cli/node_modules"), join(root, "node_modules"));
    await assert.rejects(verifyPreviewIntegrity(root, { installed: true }), /tree symlink/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup rejection attempts remaining cleanup and never publishes passed evidence", async () => {
  const calls = [];
  await assert.rejects(publishAfterSmokeCleanup([
    async () => { calls.push("host.close"); throw new Error("injected close failure"); },
    async () => { calls.push("runtime.shutdown"); },
  ], async () => { calls.push("write passed report"); }), /no success report was written/u);
  assert.deepEqual(calls, ["host.close", "runtime.shutdown"]);
  await publishAfterSmokeCleanup([async () => { calls.push("cleanup succeeds"); }], async () => { calls.push("publish"); });
  assert.deepEqual(calls.slice(-2), ["cleanup succeeds", "publish"]);
});

async function closedPreviewFixture() {
  const root = await mkdtemp(join(tmpdir(), "outlive-preview-closed-tree-"));
  const names = ["package.json", "pnpm-lock.yaml", "apps/cli/package.json", "apps/desktop/package.json", "apps/cli/dist/index.js", "apps/desktop/dist/main.js", "apps/desktop/dist/preload.cjs", "apps/desktop/dist/renderer/index.html", "sbom.cdx.json"];
  for (const name of names) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), "{}\n"); }
  const hash = createHash("sha256").update("{}\n").digest("hex");
  await writeFile(join(root, "SHA256SUMS"), names.map((name) => `${hash}  ${name}\n`).join(""));
  await verifyPreviewIntegrity(root);
  return root;
}
