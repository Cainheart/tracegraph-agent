import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serializeReleaseManifest, verifyRelease } from "./verify-release.mjs";

test("release manifest serialization is explicitly bounded", () => {
  assert.throws(
    () => serializeReleaseManifest({ padding: "x".repeat(1024 * 1024) }),
    /manifest exceeds/u,
  );
});

test("release verification writes a deterministic bounded manifest", async () => {
  const root = await fixture();
  try {
    const first = await verifyRelease(root, { tag: "v0.1.0-alpha.0", writeManifest: true });
    const second = await verifyRelease(root, { tag: "v0.1.0-alpha.0" });
    assert.deepEqual(first, second);
    assert.equal(first.schema_version, "tracegraph.release-manifest.v1");
    assert.equal(first.distribution_mode, "private-workspace-build-artifact");
    assert.equal(first.bundle_root, "bundle");
    assert.ok(first.files.every((entry) => !entry.path.startsWith("/") && /^[a-f0-9]{64}$/u.test(entry.sha256)));
    assert.equal(first.files.some((entry) => entry.path.includes("packages/rogue/")), false);
    assert.equal(await readFile(join(root, "_tmp_release/bundle/apps/cli/dist/index.js"), "utf8"), "export {};\n");
    await assert.rejects(lstat(join(root, "_tmp_release/bundle/packages/rogue")), { code: "ENOENT" });
    const written = JSON.parse(await readFile(join(root, "_tmp_release/release-manifest.json"), "utf8"));
    assert.deepEqual(written, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release verification fails closed on tag, changelog, and output drift", async (t) => {
  await t.test("tag mismatch", async () => {
    const root = await fixture();
    try {
      await assert.rejects(verifyRelease(root, { tag: "v9.9.9" }), /does not match/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("missing changelog entry", async () => {
    const root = await fixture();
    try {
      await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n", "utf8");
      await assert.rejects(verifyRelease(root), /no dated entry/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("missing declared build output", async () => {
    const root = await fixture();
    try {
      await rm(join(root, "apps/cli/dist/index.js"));
      await assert.rejects(verifyRelease(root), /dist\/index\.js/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("non-dist export or bin target", async () => {
    const root = await fixture();
    try {
      const path = join(root, "apps/cli/package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.bin.tracegraph = "./src/index.js";
      await writeJson(path, manifest);
      await assert.rejects(verifyRelease(root), /normalized \.\/dist path/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-release-test-"));
  await mkdir(join(root, "apps/cli/dist"), { recursive: true });
  await mkdir(join(root, "apps/web/dist"), { recursive: true });
  await mkdir(join(root, "packages/core/dist"), { recursive: true });
  await mkdir(join(root, "packages/rogue/dist"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  const version = "0.1.0-alpha.0";
  await writeJson(join(root, "package.json"), {
    name: "tracegraph-agent",
    version,
    private: true,
    packageManager: "pnpm@11.19.0",
    engines: { node: ">=22.19.0" },
  });
  await writeJson(join(root, "apps/cli/package.json"), {
    name: "@tracegraph/cli",
    version,
    private: true,
    bin: { tracegraph: "./dist/index.js" },
  });
  await writeJson(join(root, "apps/web/package.json"), {
    name: "@tracegraph/web",
    version,
    private: true,
  });
  await writeJson(join(root, "packages/core/package.json"), {
    name: "@tracegraph/core",
    version,
    private: true,
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  });
  for (const path of ["README.md", "README.en.md", "LICENSE", "NOTICE.md", "docs/README.md"]) {
    await writeFile(join(root, path), `${path}\n`, "utf8");
  }
  await writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## [${version}] - 2026-09-19\n\n- Test release.\n`, "utf8");
  await writeFile(join(root, "apps/cli/dist/index.js"), "export {};\n", "utf8");
  await writeFile(join(root, "apps/web/dist/index.html"), "<!doctype html>\n", "utf8");
  await writeFile(join(root, "packages/core/dist/index.js"), "export {};\n", "utf8");
  await writeFile(join(root, "packages/core/dist/index.d.ts"), "export {};\n", "utf8");
  await writeFile(join(root, "packages/rogue/dist/must-not-ship.js"), "throw new Error('rogue');\n", "utf8");
  return root;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
