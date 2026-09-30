import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stringify } from "yaml";

import { hasBoundaryCheckInCi, verifyBoundaries } from "./verify-boundaries.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_EXPORT = {
  ".": {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  },
};

test("the current workspace dependency and import graph satisfies architecture-policy.yaml", async () => {
  const outcome = await verifyBoundaries(REPOSITORY_ROOT);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.packageCount, 18);
  assert.equal(outcome.dependencyCount, 34);
  assert.ok(outcome.importCount > 0);
});

test("a forbidden reverse dependency fails", async (context) => {
  const root = await createFixture(context, [
    { name: "@tracegraph/a" },
    {
      name: "@tracegraph/b",
      dependencies: { "@tracegraph/a": "workspace:*" },
      forbidden: ["@tracegraph/a"],
      source: 'import "@tracegraph/a";\n',
    },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.ok(outcome.errors.some((error) => error.code === "BOUNDARY_EDGE_FORBIDDEN"));
});

test("a legacy package reports boundary violations without blocking and names its migration owner", async (context) => {
  const root = await createFixture(context, [
    { name: "@tracegraph/a" },
    {
      name: "@tracegraph/b",
      governance: "legacy",
      migrationOwner: "b-maintainer",
      dependencies: { "@tracegraph/a": "workspace:*" },
      forbidden: ["@tracegraph/a"],
      source: 'import "@tracegraph/a/internal.js";\n',
    },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.errors, []);
  assert.ok(outcome.warnings.some((warning) => warning.code === "BOUNDARY_EDGE_FORBIDDEN" && warning.migrationOwner === "b-maintainer"));
  assert.ok(outcome.warnings.some((warning) => warning.code === "BOUNDARY_DEEP_IMPORT" && warning.migrationOwner === "b-maintainer"));
});

test("the CLI displays legacy findings while exiting successfully", async (context) => {
  const root = await createFixture(context, [
    { name: "@tracegraph/a" },
    {
      name: "@tracegraph/b",
      governance: "legacy",
      migrationOwner: "b-maintainer",
      dependencies: { "@tracegraph/a": "workspace:*" },
      forbidden: ["@tracegraph/a"],
    },
  ]);

  const result = spawnSync(process.execPath, [join(REPOSITORY_ROOT, "scripts/verify-boundaries.mjs"), "--root", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /BOUNDARY_EDGE_FORBIDDEN/u);
  assert.match(result.stderr, /migration owner: b-maintainer/u);
  assert.match(result.stdout, /1 legacy findings reported/u);
});

test("dependency cycles made only of legacy packages are report-only", async (context) => {
  const root = await createFixture(context, [
    {
      name: "@tracegraph/a",
      governance: "legacy",
      migrationOwner: "a-maintainer",
      dependencies: { "@tracegraph/b": "workspace:*" },
      allowed: ["@tracegraph/b"],
    },
    {
      name: "@tracegraph/b",
      governance: "legacy",
      migrationOwner: "b-maintainer",
      dependencies: { "@tracegraph/a": "workspace:*" },
      allowed: ["@tracegraph/a"],
    },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.errors, []);
  assert.ok(outcome.warnings.some((warning) => warning.code === "BOUNDARY_PACKAGE_CYCLE"));
});

test("a legacy package without a migration owner is invalid policy", async (context) => {
  const root = await createFixture(context, [
    { name: "@tracegraph/a", governance: "legacy" },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.ok(outcome.errors.some((error) => error.code === "BOUNDARY_POLICY_MIGRATION_OWNER_MISSING"));
});

test("unknown package governance states are rejected", async (context) => {
  const root = await createFixture(context, [
    { name: "@tracegraph/a", governance: "migrating" },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.ok(outcome.errors.some((error) => error.code === "BOUNDARY_POLICY_GOVERNANCE_INVALID"));
});

test("managed package violations remain blocking", async (context) => {
  const root = await createFixture(context, [
    { name: "@tracegraph/a" },
    {
      name: "@tracegraph/b",
      governance: "managed",
      dependencies: { "@tracegraph/a": "workspace:*" },
      forbidden: ["@tracegraph/a"],
      source: 'import "@tracegraph/a";\n',
    },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((error) => error.code === "BOUNDARY_EDGE_FORBIDDEN"));
});

test("an import outside a package's exports fails as a deep import", async (context) => {
  const root = await createFixture(context, [
    {
      name: "@tracegraph/a",
      allowed: ["@tracegraph/b"],
      dependencies: { "@tracegraph/b": "workspace:*" },
      source: 'import "@tracegraph/b/src/internal.js";\n',
    },
    { name: "@tracegraph/b" },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.ok(outcome.errors.some((error) => error.code === "BOUNDARY_DEEP_IMPORT"));
});

test("a workspace dependency cycle fails", async (context) => {
  const root = await createFixture(context, [
    {
      name: "@tracegraph/a",
      allowed: ["@tracegraph/b"],
      dependencies: { "@tracegraph/b": "workspace:*" },
    },
    {
      name: "@tracegraph/b",
      allowed: ["@tracegraph/a"],
      dependencies: { "@tracegraph/a": "workspace:*" },
    },
  ]);

  const outcome = await verifyBoundaries(root);
  assert.ok(outcome.errors.some((error) => error.code === "BOUNDARY_PACKAGE_CYCLE"));
});

test("removing the CI boundary-check step is detected", async () => {
  const workflowPath = join(REPOSITORY_ROOT, ".github/workflows/ci.yml");
  const workflow = await readFile(workflowPath, "utf8");
  assert.equal(hasBoundaryCheckInCi(workflow), true);

  const withoutBoundaryCheck = workflow.replace(/^\s*- run: pnpm verify:boundaries\s*$/mu, "");
  assert.notEqual(withoutBoundaryCheck, workflow);
  assert.equal(hasBoundaryCheckInCi(withoutBoundaryCheck), false);
});

async function createFixture(context, packages) {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-boundaries-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "pnpm-workspace.yaml"), stringify({ packages: ["packages/*"] }));
  await writeFile(join(root, "architecture-policy.yaml"), stringify({
    version: 2,
    global: { forbid_cycles: true, forbid_deep_imports: true },
    packages: packages.map((item) => ({
      name: item.name,
      root: `packages/${item.name.slice("@tracegraph/".length)}`,
      governance: item.governance ?? "managed",
      ...(item.migrationOwner === undefined ? {} : { migration_owner: item.migrationOwner }),
      allowed: item.allowed ?? [],
      forbidden: item.forbidden ?? [],
    })),
    exceptions: [],
  }));

  for (const item of packages) {
    const rootName = `packages/${item.name.slice("@tracegraph/".length)}`;
    const packagePath = join(root, rootName);
    await mkdir(join(packagePath, "src"), { recursive: true });
    await writeFile(join(packagePath, "package.json"), JSON.stringify({
      name: item.name,
      version: "1.0.0",
      exports: item.exports ?? ROOT_EXPORT,
      dependencies: item.dependencies ?? {},
    }, null, 2));
    await writeFile(join(packagePath, "src/index.ts"), item.source ?? "export {};\n");
  }

  return root;
}
