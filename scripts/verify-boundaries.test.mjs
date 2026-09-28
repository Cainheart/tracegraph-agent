import assert from "node:assert/strict";
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
  assert.equal(outcome.packageCount, 12);
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
    version: 1,
    global: { forbid_cycles: true, forbid_deep_imports: true },
    packages: packages.map((item) => ({
      name: item.name,
      root: `packages/${item.name.slice("@tracegraph/".length)}`,
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
