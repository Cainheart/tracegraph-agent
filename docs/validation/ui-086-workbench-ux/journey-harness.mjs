#!/usr/bin/env node
/**
 * UX-086 executable product acceptance. All model content is synthetic;
 * HTTP Host, Electron/private RPC, Runtime, ledger, files and test processes
 * are real. Never connects to a remote model or reads user credentials.
 * Requires pnpm build and a Playwright module supplied by the caller.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createReadonlyWorkspaceHandle, createPlatformCredentialStore,
} from "../../../packages/core/dist/index.js";
import { TraceGraphClient } from "../../../packages/sdk/dist/index.js";
import { createFailingTypescriptFixture } from "../../../packages/test-support/dist/index.js";
import { createDesktopHostRuntime } from "../../../apps/desktop-host/dist/index.js";

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, "../../..");
const viewportSizes = [[1440, 900], [1280, 800], [1024, 768]];
const playwrightPath = process.env.OUTLIVE_PLAYWRIGHT_MODULE;
if (!playwrightPath) throw new Error("Set OUTLIVE_PLAYWRIGHT_MODULE to the Playwright package's index.mjs");
const { chromium, _electron } = await import(pathToFileURL(resolve(playwrightPath)).href);
const output = resolve(process.argv[2] ?? join(directory, "evidence"));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "outlive-ux086-"));
const report = {
  recorded_at: new Date().toISOString(), task_id: "UX-086", node: process.version,
  platform: process.platform, model_boundary: "Synthetic deterministic local HTTP provider; real live clients/Hosts/Runtime/ledger/files/processes. This is not provider-quality or external-user acceptance.",
  screenshots: [], journeys: [], errors: [],
};
report.status = "running"; await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
const cleanups = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
let decisionOrdinal = 0;
function finish(text) {
  return { decision_id: `decision:ux086-${++decisionOrdinal}`, kind: "finish", public_reason: "Return the synthetic acceptance result.", evidence_refs: [], risk: "none", final_answer: text };
}
function tool(name, args, held = false) {
  return { held, decision: { decision_id: `decision:ux086-${++decisionOrdinal}`, kind: "tool_call", public_reason: `Synthetic acceptance: ${name}.`, evidence_refs: [], risk: name === "preview_patch" ? "high" : name === "run_test" ? "medium" : "low", expected_effect: `Establish a real ${name} receipt.`, tool_call: { action_id: `action:ux086-${decisionOrdinal}`, tool_name: name, arguments: args } } };
}
function fixtureScript() {
  return [tool("search", { pattern: "return left - right;" }, true), tool("read_file", { path: "src/add.ts" }, true), tool("preview_patch", { path: "src/add.ts", expected: "return left - right;", replacement: "return left + right;" }), tool("run_test", { suite: "fixture" }), { decision: finish("Synthetic acceptance completed. Inspect the real patch and test receipts.") }];
}

async function listen(server) {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
async function eventually(read, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function provider() {
  let steps = [], cursor = 0, release;
  const server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const part of request) body += part;
      const input = JSON.parse(body);
      const isDecision = String(input.messages?.[0]?.content).includes("decision engine");
      let content;
      if (isDecision) {
        const step = steps[cursor++];
        assert.ok(step, "Synthetic decision script exhausted");
        if (step.held) await new Promise((done) => { release = done; });
        content = JSON.stringify(step.decision);
      } else {
        // Runtime background extraction is deliberately empty. It must not
        // consume decision steps or manufacture durable candidate claims.
        content = JSON.stringify({ summary: "Synthetic acceptance fixture.", candidates: [] });
      }
      response.writeHead(200, { "content-type": input.stream ? "text/event-stream" : "application/json" });
      if (input.stream) response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      else response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  const baseUrl = await listen(server);
  cleanups.push(() => closeServer(server));
  return {
    baseUrl, set(script) { steps = script; cursor = 0; release = undefined; },
    calls: () => cursor,
    async release() { await eventually(() => release, "synthetic held request"); const done = release; release = undefined; done(); },
  };
}

async function capture(page, surface, state, readRun, resize) {
  for (const [width, height] of viewportSizes) {
    if (resize) await resize(width, height); else await page.setViewportSize({ width, height });
    await delay(120);
    const interactions = [];
    if (state === "empty") {
      await keyboard(page);
      const composer = page.getByRole("textbox", { name: "Plain chat message" });
      await composer.fill("Viewport keyboard probe");
      assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(), true);
      await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, isComposing: true });
      assert.equal(await composer.isEnabled(), true, "IME composition Enter must not submit");
      assert.equal(await composer.inputValue(), "Viewport keyboard probe", "IME Enter must preserve unsent input");
      await composer.press("Shift+Enter");
      assert.ok((await composer.inputValue()).includes("\n"), "Shift+Enter must insert a new line");
      await composer.fill("");
      interactions.push("keyboard navigation/search/settings", "enabled submit after input", "IME Enter does not submit", "Shift+Enter inserts newline");
    }
    if (state === "active-run") {
      const composer = page.getByRole("textbox", { name: "Steer this run" });
      await composer.fill("Viewport steering probe");
      assert.equal(await page.getByRole("button", { name: "Queue input", exact: true }).isEnabled(), true);
      assert.equal(await page.getByRole("button", { name: "Cancel run safely", exact: true }).isEnabled(), true);
      await composer.fill("");
      interactions.push("steering input and queue control enabled", "cancel control enabled");
    }
    if (state === "tool-result") {
      await page.getByRole("button", { name: "Conversation", exact: true }).click();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      interactions.push("conversation/activity navigation");
    }
    if (state === "change-review") {
      const filesTab = page.getByRole("button", { name: "Files", exact: true, includeHidden: true });
      if (await filesTab.isVisible()) {
        await filesTab.click();
        const filesVisible = await page.locator(".changed-files-pane").isVisible();
        if (!filesVisible) await page.screenshot({ path: join(output, `responsive-files-failure-${surface}-${width}x${height}.png`), animations: "disabled", scale: "css" });
        assert.equal(filesVisible, true, "Files tab must expose file selection");
        assert.equal(await page.locator(".diff-pane").isVisible(), false, "Files view must hide the narrow diff panel");
        await page.locator(".changed-file-list button").filter({ hasText: "add.ts" }).click();
        assert.equal(await page.locator(".diff-pane").isVisible(), true, "File selection must expose its diff");
        await page.getByRole("button", { name: "Architecture", exact: true }).click();
        assert.equal(await page.locator(".graph-pane").isVisible(), true, "Architecture tab must expose its evidence panel");
        assert.equal(await page.locator(".diff-pane").isVisible(), false, "Architecture view must hide the narrow diff panel");
        await page.getByRole("button", { name: "Diff", exact: true }).click();
        interactions.push("responsive files/architecture/diff review navigation with visible panels");
      } else {
        assert.equal(await page.locator(".changed-files-pane").isVisible(), true);
        assert.equal(await page.locator(".graph-pane").isVisible(), true);
        await page.locator(".changed-file-list button").filter({ hasText: "add.ts" }).click();
        interactions.push("wide review file selection with simultaneous diff and architecture panels");
      }
      await eventually(() => page.getByRole("table", { name: "Diff for src/add.ts" }).count(), "responsive review panel navigation");
    }
    if (state === "tool-result") await page.locator(".event-row.event-tool.state-succeeded").last().scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth, readOnlyGate: !!document.querySelector(".compact-readonly-gate"),
      enabledInputs: [...document.querySelectorAll("textarea,input,button")].filter((element) => !element.disabled && element.getBoundingClientRect().width > 0).length,
    }));
    assert.equal(layout.width, width); assert.equal(layout.height, height);
    assert.ok(layout.documentWidth <= width + 1 && layout.bodyWidth <= width + 1, `${surface}/${state}/${width}: document overflow ${JSON.stringify(layout)}`);
    assert.equal(layout.readOnlyGate, false); assert.ok(layout.enabledInputs > 0);
    const file = `${surface}-${state}-${width}x${height}.png`;
    await page.screenshot({ path: join(output, file), animations: "disabled", scale: "css" });
    const run = readRun ? await readRun() : undefined;
    const bytes = await readFile(join(output, file));
    report.screenshots.push({ surface, state, file, sha256: createHash("sha256").update(bytes).digest("hex"), layout, interactions, ...(run ? { run_id: run.run_id, status: run.status, last_sequence: run.last_sequence } : {}) });
  }
  if (resize) await resize(1440, 900); else await page.setViewportSize({ width: 1440, height: 900 });
}
async function keyboard(page) {
  await page.keyboard.press("ControlOrMeta+k");
  await eventually(() => page.getByRole("searchbox", { name: "Search sessions" }).evaluate((element) => element === document.activeElement), "keyboard search focus");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+b");
  await eventually(() => page.getByRole("button", { name: "Show navigation" }).count(), "keyboard hide navigation");
  await page.keyboard.press("ControlOrMeta+b");
  await eventually(() => page.getByRole("button", { name: "Hide navigation" }).count(), "keyboard show navigation");
  await page.keyboard.press("ControlOrMeta+,");
  await eventually(() => page.getByRole("dialog").count(), "keyboard settings");
  await page.keyboard.press("Escape");
}
async function latestRun(adapter) {
  const list = await adapter.listSessions();
  const latest = [...list.sessions].filter((session) => session.run_ids.length > 0).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!latest) return undefined;
  try { return await adapter.getRun(latest.run_ids.at(-1)); }
  catch (error) { if (error.statusCode === 404 || error.message === "Run is unavailable") return undefined; throw error; }
}
async function pollStatus(adapter, expected, excludedRun) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  let last;
  try { return await eventually(async () => { const run = await latestRun(adapter); last = run; return run && statuses.includes(run.status) && run.run_id !== excludedRun ? run : undefined; }, `live Run status ${expected}`); }
  catch (error) {
    if (last) {
      await json(join(output, "poll-failure-projection.json"), last);
      const test = last.timeline.flatMap((event) => event.artifact_refs).find((ref) => ref.kind === "test_log");
      if (test && adapter.getArtifact) await json(join(output, "poll-failure-test-artifact.json"), await adapter.getArtifact(last.run_id, test.artifact_id));
    }
    throw new Error(`${error.message}; last canonical status=${last?.status}; outcome=${last?.outcome ?? "unavailable"}`);
  }
}
async function uiJourney({ page, surface, model, adapter, selectProject, restart, resize, source }) {
  process.stdout.write(`${surface}: empty and keyboard\n`);
  await eventually(() => page.locator(".plain-chat-composer textarea").isEnabled(), "initial renderer startup completes");
  await page.waitForLoadState("load");
  await page.evaluate(() => { localStorage.setItem("tracegraph.language", "en"); localStorage.setItem("tracegraph.theme", "light"); });
  await page.reload();
  await eventually(() => page.getByRole("textbox", { name: "Plain chat message" }).isEnabled(), "live empty composer");
  await capture(page, surface, "empty", undefined, resize);
  await keyboard(page);
  model.set([{ decision: finish("Synthetic plain chat acceptance answer.") }]);
  const chat = page.getByRole("textbox", { name: "Plain chat message" });
  await chat.fill("UX-086 synthetic plain chat"); await chat.press("Enter");
  const chatRun = await pollStatus(adapter, "completed");
  assert.match(chatRun.outcome, /Synthetic plain chat/);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await selectProject();
  process.stdout.write(`${surface}: active task, Todo and steering\n`);
  model.set(fixtureScript());
  const task = page.getByRole("textbox", { name: "Task", exact: true });
  await task.fill("UX-086 synthetic fixture repair"); await task.press("Enter");
  const active = await pollStatus(adapter, ["indexing", "running"], chatRun.run_id);
  await capture(page, surface, "active-run", () => adapter.getRun(active.run_id), resize);
  await page.getByRole("textbox", { name: "Steer this run" }).fill("Keep changes inside src/add.ts.");
  await page.getByRole("textbox", { name: "Steer this run" }).press("Enter");
  await eventually(async () => (await adapter.getRun(active.run_id)).timeline.some((event) => event.type === "user.input_queued"), "durable steering receipt");
  await model.release();
  await eventually(() => model.calls() >= 2, "read request after real search");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await capture(page, surface, "tool-result", () => adapter.getRun(active.run_id), resize);
  await model.release();
  const waiting = await pollStatus(adapter, "awaiting_approval");
  assert.ok(waiting.pending_approval); assert.match(await readFile(source, "utf8"), /return left - right;/);
  await adapter.writeTodo(active.run_id, { input: { operation: "create", todo_id: "todo:ux086", title: "Review the synthetic fixture", state: "pending" } });
  await page.getByRole("combobox", { name: "Todo state: Review the synthetic fixture" }).selectOption("in_progress");
  await eventually(async () => (await adapter.getTodos(active.run_id)).items.some((todo) => todo.todo_id === "todo:ux086" && todo.state === "in_progress"), "real Todo mutation from UI");
  await restart(waiting);
  const recovered = await pollStatus(adapter, "interrupted");
  assert.match(await readFile(source, "utf8"), /return left - right;/);
  await page.getByRole("button", { name: new RegExp("UX-086 synthetic fixture repair") }).first().click();
  await page.getByRole("button", { name: "Resume session", exact: true }).click();
  const resumed = await pollStatus(adapter, "awaiting_approval");
  assert.notEqual(resumed.pending_approval.approval_id, waiting.pending_approval.approval_id);
  await eventually(() => page.getByRole("button", { name: "Allow once", exact: true }).isEnabled(), "verified approval diff");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  const completed = await pollStatus(adapter, "completed");
  assert.match(await readFile(source, "utf8"), /return left \+ right;/);
  assert.ok(completed.timeline.some((event) => event.type === "patch.applied" && event.data.verified === true));
  const tested = completed.timeline.find((event) => event.type === "test.completed");
  assert.ok(tested, "The repaired fixture must execute its actual tests");
  assert.equal(tested.data.receipt.business_status, "success");
  assert.equal(tested.data.receipt.code, "tests_passed");
  await page.getByRole("button", { name: /^Changes/ }).click();
  await eventually(() => page.getByRole("table", { name: "Diff for src/add.ts" }).count(), "real diff artifact");
  await capture(page, surface, "change-review", () => adapter.getRun(active.run_id), resize);
  await json(join(output, `${surface}-completed-projection.json`), completed);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.getByRole("button", { name: "Test / raw log", exact: true }).click();
  await eventually(async () => (await page.locator(".bottom-drawer pre").textContent()).includes("2/2 fixture assertions passed"), "actual passing test-log Artifact content");
  await page.getByRole("button", { name: "Close log", exact: true }).last().click();
  model.set([{ decision: finish("Synthetic follow-up acceptance answer.") }]);
  const followup = page.getByRole("textbox", { name: "New task", exact: true });
  await followup.fill("UX-086 synthetic follow-up"); await followup.press("Enter");
  const followed = await pollStatus(adapter, "completed", completed.run_id);
  assert.notEqual(followed.run_id, completed.run_id); assert.equal(followed.session_id, completed.session_id);
  // Switching historical sessions reconstructs the ledger without a dispatch.
  const callsBeforeSwitch = model.calls();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("button", { name: /UX-086 synthetic plain chat/ }).first().click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("button", { name: /UX-086 synthetic fixture repair/ }).first().click();
  assert.equal(model.calls(), callsBeforeSwitch);
  model.set([tool("search", { pattern: "return left" }, true), { decision: finish("This decision must be cancelled before dispatch.") }]);
  await followup.fill("UX-086 synthetic cancellation"); await followup.press("Enter");
  const cancelling = await pollStatus(adapter, ["indexing", "running"], followed.run_id);
  await eventually(() => model.calls() >= 1, "provider request is in flight before cancellation");
  await page.getByRole("button", { name: "Cancel run safely", exact: true }).click();
  await model.release();
  const cancelled = await pollStatus(adapter, "cancelled");
  assert.equal(model.calls(), 1, "Cancellation must prevent the second decision dispatch");
  report.journeys.push({ surface, assertions: ["live empty composer", "keyboard navigation/search/settings/submission", "plain chat", "project selection", "task", "canonical Todo mutation from UI", "durable steering", "real search tool receipt", "Host restart recovery without write", "explicit resume with fresh approval", "schema-bound approval", "real patch/file oracle", "test receipt", "Artifact-backed diff", "same-session follow-up", "session switching without dispatch", "safe cancellation prevents new dispatch"], chat_run_id: chatRun.run_id, task_run_id: completed.run_id, followup_run_id: followed.run_id, cancelled_run_id: cancelled.run_id, recovery_sequence: recovered.last_sequence, test_evidence: completed.timeline.filter((event) => event.type.includes("test") || JSON.stringify(event.data).includes("run_test")).map((event) => ({ type: event.type, sequence: event.sequence, summary: event.summary })) });
}

try {
  const model = await provider();
  const fixture = await createFailingTypescriptFixture("ux086-web-project");
  cleanups.push(fixture.cleanup);
  const chatRoot = join(scratch, "chat"); await mkdir(chatRoot);
  const chatBase = await createReadonlyWorkspaceHandle({ projectId: "ux086-chat", root: chatRoot });
  const chatWorkspace = { ...chatBase, capabilities: Object.fromEntries(Object.keys(chatBase.capabilities).map((key) => [key, false])) };
  const dataDir = join(scratch, "web-data");
  let hostProcess, hostAddress, sdk;
  let staticAddress;
  const staticServer = createServer(async (request, response) => {
    try {
      if (request.url.startsWith("/api")) {
        const target = new URL(request.url, hostAddress);
        const upstream = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host, origin: staticAddress } }, (result) => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
        response.once("close", () => upstream.destroy());
        upstream.on("error", (error) => { if (!response.headersSent) response.writeHead(502); response.end(String(error)); }); request.pipe(upstream); return;
      }
      const path = request.url.split("?")[0];
      const file = join(repository, "apps/web/dist", path === "/" ? "index.html" : path);
      assert.ok(file.startsWith(join(repository, "apps/web/dist")));
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
      const bytes = await readFile(file);
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }); response.end(bytes);
    } catch { if (!response.headersSent) response.writeHead(404); response.end("Not found"); }
  });
  staticAddress = await listen(staticServer); cleanups.push(() => closeServer(staticServer));
  async function startWebHost() {
    const inputFile = join(scratch, "web-host-input.json");
    await json(inputFile, { dataDir, fixture: fixture.handle, chatWorkspace, staticAddress, modelBase: model.baseUrl });
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
    hostProcess = fork(join(directory, "host-worker.mjs"), [inputFile], { execArgv: [], env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; hostProcess.stderr.on("data", (part) => { stderr += part; });
    hostAddress = await new Promise((done, reject) => { hostProcess.once("message", (message) => done(message.address)); hostProcess.once("error", reject); hostProcess.once("exit", (code) => reject(new Error(`HTTP Host child exited ${code}: ${stderr}`))); });
    sdk = new TraceGraphClient({ baseUrl: hostAddress, nodeOrigin: staticAddress }); await sdk.bootstrap();
  }
  async function endWebHost(crash = false) {
    const child = hostProcess;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise((done) => child.once("exit", done));
    if (crash) child.kill("SIGKILL"); else child.send({ type: "close" });
    await exit;
  }
  await startWebHost(); cleanups.push(() => endWebHost());
  const browser = await chromium.launch({ executablePath: process.env.OUTLIVE_CHROME_BINARY ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  cleanups.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => report.errors.push({ surface: "web", message: error.message }));
  await page.goto(staticAddress);
  await uiJourney({ page, surface: "web", model, adapter: { listSessions: () => sdk.listSessions({ view: "roots", limit: 50 }), getRun: (id) => sdk.getRun(id), writeTodo: (id, request) => sdk.writeTodo(id, request), getTodos: (id) => sdk.getTodos(id), getArtifact: (id, artifactId) => sdk.getArtifact(id, artifactId) }, selectProject: () => page.getByRole("button", { name: "UX-086 fixture project", exact: true }).click(), restart: async () => { await page.goto("about:blank"); await endWebHost(true); await startWebHost(); await page.goto(staticAddress); }, source: join(fixture.handle.real_root, "src/add.ts") });

  if (process.env.OUTLIVE_SKIP_DESKTOP !== "1") {
    const desktopFixture = await createFailingTypescriptFixture("ux086-desktop-source"); cleanups.push(desktopFixture.cleanup);
    const userData = join(scratch, "desktop-user-data"); const desktopData = join(userData, "host"); await mkdir(desktopData, { recursive: true });
    const credentials = createPlatformCredentialStore({ fallbackFile: join(desktopData, "credentials.json"), environment: {} });
    const seed = await createDesktopHostRuntime({ dataDir: desktopData, credentialStore: credentials });
    const project = await seed.native.registerProject({ selectedPath: desktopFixture.handle.real_root, access: "read_write" });
    const config = await seed.native.configureModel({ provider: "custom", protocol: "openai-chat-completions", base_url: model.baseUrl, model: "synthetic-ux086-local", api_key: "synthetic-ux086-key" });
    cleanups.push(() => credentials.delete(config.credential.name)); await seed.close();
    const bootstrap = join(scratch, "electron-bootstrap.cjs");
    await writeFile(bootstrap, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(userData)});\nimport(${JSON.stringify(pathToFileURL(join(repository, "apps/desktop/dist/main.js")).href)});\n`);
    let desktop;
    async function launchDesktop() {
      const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({ executablePath: process.env.OUTLIVE_ELECTRON_BINARY ?? join(repository, "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [bootstrap], env, timeout: 20_000 });
      return desktop.firstWindow();
    }
    let desktopPage = await launchDesktop(); cleanups.push(() => desktop.close());
    desktopPage.on("pageerror", (error) => report.errors.push({ surface: "desktop", message: error.message }));
    const adapter = {
      listSessions: () => desktopPage.evaluate(() => window.tracegraphDesktop.listSessions({ view: "roots", limit: 50 })),
      getRun: (id) => desktopPage.evaluate((runId) => window.tracegraphDesktop.getRun(runId), id),
      writeTodo: (id, request) => desktopPage.evaluate(({ id, request }) => window.tracegraphDesktop.writeTodo({ run_id: id, input: { ...request, command_id: crypto.randomUUID() } }), { id, request }),
      getTodos: (id) => desktopPage.evaluate((runId) => window.tracegraphDesktop.getTodos(runId), id),
      getArtifact: (id, artifactId) => desktopPage.evaluate(({ id, artifactId }) => window.tracegraphDesktop.getArtifact({ run_id: id, artifact_id: artifactId }), { id, artifactId }),
    };
    // Restart creates a new Page object. Proxy the operations used by the
    // journey so the same scenario follows the real replacement window.
    const pageProxy = new Proxy({}, { get(_target, key) { const value = desktopPage[key]; return typeof value === "function" ? value.bind(desktopPage) : value; } });
    const resize = (width, height) => desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
    await uiJourney({ page: pageProxy, surface: "desktop", model, adapter, selectProject: () => desktopPage.getByRole("button", { name: new RegExp(desktopFixture.handle.real_root.split("/").at(-1)) }).first().click(), restart: async () => { await desktop.close(); desktopPage = await launchDesktop(); desktopPage.on("pageerror", (error) => report.errors.push({ surface: "desktop", message: error.message })); await resize(1440, 900); }, resize, source: join(desktopFixture.handle.real_root, "src/add.ts") });
    assert.equal(project.location.kind, "linked_directory");
    // Preview uses the same shipped renderer, an explicitly different client.
    await desktop.close();
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: process.env.OUTLIVE_ELECTRON_BINARY ?? join(repository, "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [bootstrap, "--preview"], env });
    desktopPage = await desktop.firstWindow();
    await eventually(() => desktopPage.getByText(/Demo data|Preview|synthetic/i).count(), "observable Preview marker");
    await resize(1440, 900); await desktopPage.screenshot({ path: join(output, "desktop-preview-boundary.png"), animations: "disabled", scale: "css" });
    report.preview_boundary = "Shipped Electron Preview renderer started separately and displayed its explicit synthetic-data marker.";
  }
  assert.equal(report.errors.length, 0, "Unexpected renderer errors");
  await Promise.all(["poll-failure-projection.json", "poll-failure-test-artifact.json"].map((file) => rm(join(output, file), { force: true })));
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  report.cleanup = { status: "pending" }; await json(join(output, "report.json"), report);
} finally {
  const cleanupErrors = [];
  for (const cleanup of cleanups.reverse()) { try { await Promise.race([cleanup(), delay(10_000).then(() => { throw new Error("Resource cleanup exceeded 10 seconds"); })]); } catch (error) { cleanupErrors.push(error.message); } }
  try { await rm(scratch, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error.message); }
  report.cleanup = { status: cleanupErrors.length ? "failed" : "passed", errors: cleanupErrors };
  if (cleanupErrors.length) { report.status = "failed"; process.exitCode = 1; }
  await json(join(output, "report.json"), report);
  process.stdout.write(`${report.status}: ${output}/report.json\n`);
}
