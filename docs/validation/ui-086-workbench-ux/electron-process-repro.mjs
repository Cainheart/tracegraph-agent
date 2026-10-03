/** Narrow negative oracle: an embedded Electron binary is not a Node tool runtime. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createSandboxRunner } from "../../../packages/core/dist/index.js";
import { createFailingTypescriptFixture } from "../../../packages/test-support/dist/index.js";

assert.ok(process.versions.electron, "Run this negative oracle under Electron with ELECTRON_RUN_AS_NODE=1");
const output = process.argv[2];
assert.ok(output, "Provide a JSON receipt path");
const fixture = await createFailingTypescriptFixture("ux086-electron-runtime-repro");
try {
  const source = join(fixture.handle.real_root, "src/add.ts");
  await writeFile(source, (await readFile(source, "utf8")).replace("return left - right;", "return left + right;"));
  const installed = (await promisify(execFile)("node", ["-p", "process.execPath"], { env: { PATH: process.env.PATH }, shell: false })).stdout.trim();
  const run = (executable) => createSandboxRunner().run({ mode: "workspace-write", workspaceRoot: fixture.handle.real_root, cwd: fixture.handle.real_root, executable, args: [join(fixture.handle.real_root, "test/run.mjs")], timeoutMs: 3_000, maxOutputBytes: 16_000 });
  const embedded = await run(process.execPath);
  const node = await run(installed);
  assert.equal(embedded.started, true); assert.notEqual(embedded.exitCode, 0);
  assert.equal(node.exitCode, 0); assert.match(node.stdout, /2\/2 fixture assertions passed/);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ recorded_at: new Date().toISOString(), boundary: "Synthetic fixture, real Seatbelt/processes; same patched files and policy for both executables", electron_version: process.versions.electron, embedded_executable: process.execPath, installed_node_executable: installed, embedded, node }, null, 2) + "\n");
} finally { await fixture.cleanup(); }
