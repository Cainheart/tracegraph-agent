import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifySupplyChain } from "./verify-lockfile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "fixtures/supply-chain-valid");
let root;

async function materializeFixture() {
  root = await mkdtemp(join(tmpdir(), "tracegraph-supply-chain-"));
  await cp(fixture, root, { recursive: true });
  const files = [
    ".npmrc.fixture",
    "package.json.fixture",
    "pnpm-lock.yaml.fixture",
    "pnpm-workspace.yaml.fixture",
    "packages/app/package.json.fixture",
    "packages/lib/package.json.fixture",
  ];
  for (const source of files) {
    const contents = await readFile(join(root, source), "utf8");
    await writeFile(join(root, source.replace(/\.fixture$/, "")), contents);
    await rm(join(root, source));
  }
}

function expectIssue(result, code) {
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((found) => found.code === code), JSON.stringify(result.issues, null, 2));
}

beforeEach(materializeFixture);
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("supply-chain lockfile guard", () => {
  it("accepts exact dependencies, workspace:* and a synchronized pnpm 11 lockfile", () => {
    const result = verifySupplyChain(root);
    assert.deepEqual(result.issues, []);
    assert.equal(result.ok, true);
    assert.equal(result.manifestCount, 3);
  });

  it("fails closed when a production dependency introduces a range", async () => {
    const path = join(root, "packages/app/package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.dependencies.unpinned = "^1.2.3";
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    expectIssue(verifySupplyChain(root), "SC_DEP_NOT_EXACT");
  });

  it("rejects git, HTTP, file, and link dependency sources", async () => {
    const values = ["git+https://example.invalid/repo.git", "https://example.invalid/pkg.tgz", "file:../pkg", "link:../pkg"];
    for (const [index, value] of values.entries()) {
      const path = join(root, "packages/app/package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.devDependencies = { [`forbidden-${index}`]: value };
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      expectIssue(verifySupplyChain(root), "SC_EXOTIC_SOURCE");
    }
  });

  it("requires internal dependencies to use workspace:* and resolve to a real package", async () => {
    const path = join(root, "packages/app/package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.dependencies["@fixture/lib"] = "workspace:^";
    manifest.dependencies["@fixture/missing"] = "workspace:*";
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = verifySupplyChain(root);
    expectIssue(result, "SC_WORKSPACE_PROTOCOL");
    expectIssue(result, "SC_WORKSPACE_TARGET_MISSING");
  });

  it("rejects a packageManager/lockfile format mismatch", async () => {
    const path = join(root, "pnpm-lock.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'"));
    expectIssue(verifySupplyChain(root), "SC_LOCKFILE_VERSION");
  });

  it("detects a manifest change that was not written to the lockfile", async () => {
    const extraDirectory = join(root, "packages/extra");
    await cp(join(root, "packages/lib"), extraDirectory, { recursive: true });
    const extraPath = join(extraDirectory, "package.json");
    const extra = JSON.parse(await readFile(extraPath, "utf8"));
    extra.name = "@fixture/extra";
    await writeFile(extraPath, `${JSON.stringify(extra, null, 2)}\n`);
    const appPath = join(root, "packages/app/package.json");
    const app = JSON.parse(await readFile(appPath, "utf8"));
    app.dependencies["@fixture/extra"] = "workspace:*";
    await writeFile(appPath, `${JSON.stringify(app, null, 2)}\n`);
    expectIssue(verifySupplyChain(root), "SC_FROZEN_LOCKFILE");
  });

  it("rejects weakening the 24-hour release-age policy", async () => {
    const path = join(root, "pnpm-workspace.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace("minimumReleaseAge: 1440", "minimumReleaseAge: 60"));
    expectIssue(verifySupplyChain(root), "SC_CONFIG_POLICY");
  });

  it("rejects broad release-age exclusions", async () => {
    const path = join(root, "pnpm-workspace.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(path, `${source}\nminimumReleaseAgeExclude:\n  - '@fixture/*'\n`);
    expectIssue(verifySupplyChain(root), "SC_RELEASE_AGE_EXCEPTION");
  });

  it("rejects ranged or exotic pnpm overrides", async () => {
    const path = join(root, "pnpm-workspace.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(path, `${source}\noverrides:\n  unsafe: ^1.0.0\n`);
    expectIssue(verifySupplyChain(root), "SC_OVERRIDE_POLICY");
  });
});
