#!/usr/bin/env node
// Archive-only maintainer simulation. Main/Host/Runtime are imported
// exclusively from the fresh installed preview. The fixture is synthetic.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const output = resolve(process.argv[2]);
const installed = await realpath((await readFile(join(output, "install-path.txt"), "utf8")).trim());
const archiveSha = process.argv[3];
assert.match(archiveSha, /^[a-f0-9]{64}$/u);
const require = createRequire(join(installed, "apps/desktop/package.json"));
const executable = require("electron");
const { _electron } = await import("/Users/cain/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { createPlatformCredentialStore, createDisposableFixtureWorkspace } = await import(pathToFileURL(join(installed, "packages/core/dist/index.js")).href);
const { createDesktopHostRuntime } = await import(pathToFileURL(join(installed, "apps/desktop-host/dist/index.js")).href);
const scratch = await mkdtemp(join(tmpdir(), "outlive-ux086-installed-live-"));
const userData = join(scratch, "user-data");
const hostData = join(userData, "host");
const main = join(installed, "apps/desktop/dist/main.js");
const preload = join(installed, "apps/desktop/dist/preload.cjs");
const bootstrap = join(scratch, "archive-live-bootstrap.cjs");
const credentialStore = createPlatformCredentialStore({ fallbackFile: join(hostData, "credentials.json"), environment: {} });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const writeJson = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const record = {
  schema_version: "outlive.installed-desktop-live.v1", status: "running", recorded_at: new Date().toISOString(),
  participant_class: "simulated", independent_non_maintainer: false,
  archive_sha256: archiveSha, installed_root: installed, executable, compiled_main: main,
  compiled_main_sha256: createHash("sha256").update(await readFile(main)).digest("hex"),
  compiled_preload: preload, compiled_preload_sha256: createHash("sha256").update(await readFile(preload)).digest("hex"),
  bootstrap, user_data: userData,
  model_boundary: "Synthetic local HTTP provider only; actual installed Main/private Host/Runtime/workspace-write Seatbelt/test process and external file oracle. No remote Provider or user credential is consumed.",
};
let application, fixture, seed, server, stagedCredentialName, failure;
let appPid, hostPid, testPid;
let decisionCalls = 0;
const exec = promisify(execFile);
async function eventually(read, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read(); if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function absent(pid) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }
async function ownedHostProcess(parentPid) {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="]);
  const children = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match && Number(match[2]) === parentPid && match[3].includes(installed) && match[3].includes("worker")
      ? [{ pid: Number(match[1]), parent_pid: Number(match[2]), command: match[3] }] : [];
  });
  assert.equal(children.length, 1, "Expected exactly one archive-local Host worker child");
  return children[0];
}
await writeJson("installed-live.json", record);
try {
  await mkdir(hostData, { recursive: true });
  const template = join(scratch, "synthetic-template");
  await mkdir(join(template, "src"), { recursive: true });
  await mkdir(join(template, "test"), { recursive: true });
  await writeFile(join(template, "package.json"), JSON.stringify({ name: "synthetic-installed-seatbelt-fixture", version: "0.0.0", private: true, type: "module" }));
  await writeFile(join(template, "src/add.ts"), "export function add(left: number, right: number): number { return left + right; }\n");
  await writeFile(join(template, "test/run.mjs"), `import assert from 'node:assert/strict';\nimport { add } from '../src/add.ts';\nimport { writeFileSync } from 'node:fs';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-2, 2), 0);\nconsole.log('2/2 fixture assertions passed');\nwriteFileSync(new URL('../installed-sandbox-oracle.json', import.meta.url), JSON.stringify({ execPath: process.execPath, pid: process.pid, assertions: 2, value: add(2, 3), marker: 'archive-main-seatbelt-test' }));\n`);
  fixture = await createDisposableFixtureWorkspace({ projectId: "ux086-installed-sandbox", templateRoot: template });
  const source = join(fixture.handle.real_root, "src/add.ts");
  const testEntry = join(fixture.handle.real_root, "test/run.mjs");
  record.fixture = { real_root: fixture.handle.real_root, source_sha256: createHash("sha256").update(await readFile(source)).digest("hex"), test_entry_sha256: createHash("sha256").update(await readFile(testEntry)).digest("hex"), prepared_before_run: true };
  server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const part of request) body += part;
      const input = JSON.parse(body);
      const isDecision = String(input.messages?.[0]?.content).includes("decision engine");
      let content;
      if (isDecision) {
        const ordinal = ++decisionCalls;
        assert.ok(ordinal <= 2, "Synthetic script exhausted");
        content = JSON.stringify(ordinal === 1 ? {
          decision_id: "decision:installed-test", kind: "tool_call", public_reason: "Run the prepared synthetic sandbox fixture.", evidence_refs: [], risk: "medium", expected_effect: "Actual sandboxed test assertions and external oracle file.",
          tool_call: { action_id: "action:installed-test", tool_name: "run_test", arguments: { suite: "fixture" } },
        } : { decision_id: "decision:installed-finish", kind: "finish", public_reason: "The sandboxed test was verified.", evidence_refs: [], risk: "none", final_answer: "Installed synthetic sandbox test completed." });
      } else content = JSON.stringify({ summary: "Synthetic archive sandbox fixture.", candidates: [] });
      response.writeHead(200, { "content-type": input.stream ? "text/event-stream" : "application/json" });
      if (input.stream) response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      else response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  seed = await createDesktopHostRuntime({ dataDir: hostData, credentialStore });
  const project = await seed.native.registerProject({ selectedPath: fixture.handle.real_root, access: "read_write" });
  const config = await seed.native.configureModel({ provider: "custom", protocol: "openai-chat-completions", base_url: baseUrl, model: "synthetic-installed-sandbox", api_key: "synthetic-installed-sandbox-only" });
  stagedCredentialName = config.credential.name;
  await seed.close(); seed = undefined;
  await writeFile(bootstrap, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(userData)});\nimport(${JSON.stringify(pathToFileURL(main).href)});\n`);
  const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  application = await _electron.launch({ executablePath: executable, args: [bootstrap], env: environment, timeout: 20000 });
  appPid = application.process().pid; record.app_pid = appPid;
  const page = await application.firstWindow();
  await page.waitForSelector(".outlive-workbench");
  assert.match(page.url(), /\/apps\/desktop\/dist\/renderer\/index\.html$/u);
  record.frame_url = page.url();
  const hostStatus = await eventually(async () => { const value = await page.evaluate(() => window.tracegraphDesktop.getHostStatus()); return value.state === "ready" ? value : undefined; }, "installed typed private Host ready");
  assert.equal(hostStatus.identity.package_name, "@tracegraph/desktop-host");
  assert.equal(hostStatus.identity.package_version, "0.1.0-alpha.0");
  assert.equal(hostStatus.identity.protocol_version, "tracegraph.client-protocol.v2");
  record.host_status = hostStatus;
  const worker = await ownedHostProcess(appPid); hostPid = worker.pid; record.host_worker = worker;
  await eventually(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), "installed native window ready-to-show", 5000);
  const native = await application.evaluate(({ BrowserWindow, app }) => ({ main_exec_path: process.execPath, user_data: app.getPath("userData"), windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), preferences: window.webContents.getLastWebPreferences() })) }));
  record.native = native;
  record.preload_identity_basis = "Integrity-verified archived Main configures this hashed preload; functional isolated fixed bridge binds it. Electron 44 getLastWebPreferences omits preload path.";
  const rendererBoundary = await page.evaluate(() => ({ bridge_methods: Object.keys(window.tracegraphDesktop), require_type: typeof window.require, process_type: typeof window.process }));
  assert.equal(rendererBoundary.require_type, "undefined"); assert.equal(rendererBoundary.process_type, "undefined");
  for (const method of ["getHostStatus", "startRun", "getRun", "getArtifact"]) assert.ok(rendererBoundary.bridge_methods.includes(method));
  record.renderer_boundary = rendererBoundary;
  assert.equal(native.user_data, userData);
  assert.ok(native.windows.some((window) => window.visible && window.preferences.sandbox === true && window.preferences.contextIsolation === true && window.preferences.nodeIntegration === false));
  assert.ok(!worker.command.includes("Electron.app"), "Host worker must run actual supported Node, not Electron");
  record.host_worker = worker;
  const run = await page.evaluate((input) => window.tracegraphDesktop.startRun(input), { command_id: randomUUID(), project_id: project.project_id, task: "Run the prepared installed sandbox fixture", mode: "execute" });
  let last;
  const completed = await eventually(async () => { last = await page.evaluate((id) => window.tracegraphDesktop.getRun(id), run.run_id); return last.status === "completed" ? last : undefined; }, "installed sandbox Run completed").catch(async (error) => { await writeJson("installed-live-last-projection.json", last); throw error; });
  assert.ok(completed.timeline.some((event) => event.type === "sandbox.configured" && event.summary.includes("workspace-write")), "Default workspace-write sandbox remains enforced");
  const testRef = completed.timeline.flatMap((event) => event.artifact_refs).find((ref) => ref.kind === "test_log");
  assert.ok(testRef, "Actual test-log Artifact missing");
  const artifact = await page.evaluate(({ runId, artifactId }) => window.tracegraphDesktop.getArtifact({ run_id: runId, artifact_id: artifactId }), { runId: run.run_id, artifactId: testRef.artifact_id });
  assert.match(JSON.stringify(artifact), /2\/2 fixture assertions passed/u);
  const oracleBytes = await readFile(join(fixture.handle.real_root, "installed-sandbox-oracle.json"));
  const oracle = JSON.parse(oracleBytes); testPid = oracle.pid;
  assert.equal(oracle.marker, "archive-main-seatbelt-test"); assert.equal(oracle.assertions, 2); assert.equal(oracle.value, 5);
  assert.ok(!oracle.execPath.includes("Electron.app"));
  const actualNode = await realpath(oracle.execPath);
  const nodeVersion = (await exec(actualNode, ["--version"])).stdout.trim();
  const versionParts = /^v(\d+)\.(\d+)/u.exec(nodeVersion);
  assert.ok(versionParts && (Number(versionParts[1]) >= 24 || Number(versionParts[1]) === 22 && Number(versionParts[2]) >= 19), "Sandbox test Node is supported by the archive");
  record.test_node_version = nodeVersion;
  assert.ok(worker.command.startsWith(actualNode + " ") || worker.command.startsWith(oracle.execPath + " "));
  assert.equal(decisionCalls, 2);
  record.test_oracle = { ...oracle, sha256: createHash("sha256").update(oracleBytes).digest("hex"), sandbox_mode: "workspace-write", actual_node: actualNode };
  record.run = { run_id: completed.run_id, session_id: completed.session_id, status: completed.status, last_sequence: completed.last_sequence };
  await writeJson("installed-live-completed-projection.json", completed);
  await writeJson("installed-live-test-artifact.json", artifact);
  await writeFile(join(output, "installed-sandbox-oracle.json"), oracleBytes);
  await cp(join(hostData, "sessions"), join(output, "installed-live-canonical-sessions"), { recursive: true, force: false });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.screenshot({ path: join(output, "installed-live-sandbox-1440x900.png") });
  record.screenshot = "installed-live-sandbox-1440x900.png";
} catch (error) {
  failure = error; record.failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  const cleanupErrors = [];
  const cleanup = async (name, action) => { try { await action(); } catch (error) { cleanupErrors.push({ step: name, name: error.name, message: error.message }); } };
  if (application) await cleanup("native Main/Host close", () => application.close());
  if (seed) await cleanup("seed Host close", () => seed.close());
  if (server) await cleanup("synthetic Provider close", async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  if (stagedCredentialName) await cleanup("synthetic staged credential delete", async () => { await credentialStore.delete(stagedCredentialName); assert.equal(await credentialStore.get(stagedCredentialName), null); record.synthetic_credential_deleted = true; });
  for (const [name, pid] of [["native Main", appPid], ["private Host worker", hostPid], ["sandbox test", testPid]]) {
    if (pid) await cleanup(`${name} absent`, async () => { await eventually(() => absent(pid), `${name} PID ${pid} absent`, 5000); });
  }
  record.process_cleanup = { main_absent: appPid ? absent(appPid) : "not launched", worker_absent: hostPid ? absent(hostPid) : "not observed", test_absent: testPid ? absent(testPid) : "not started" };
  if (fixture) await cleanup("temporary fixture delete", () => fixture.cleanup());
  await cleanup("isolated userData/bootstrap delete", () => rm(scratch, { recursive: true, force: true }));
  if (cleanupErrors.length) { record.cleanup_errors = cleanupErrors; failure ??= new Error("Owned installed live validation resource cleanup failed"); }
  record.status = failure ? "failed" : "passed";
  record.finished_at = new Date().toISOString();
  await writeJson("installed-live.json", record);
}
if (failure) throw failure;
process.stdout.write("Installed LIVE archived Main/Node worker/Seatbelt test oracle passed after cleanup.\n");
