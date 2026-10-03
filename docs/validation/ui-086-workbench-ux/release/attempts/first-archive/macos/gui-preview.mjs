#!/usr/bin/env node
// Maintainer Agent simulation: loads the immutable archive's compiled Main;
// the helper only isolates Electron userData and records actual native UI.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const output = dirname(fileURLToPath(import.meta.url));
const installed = await realpath((await readFile(join(output, "install-path.txt"), "utf8")).trim());
const require = createRequire(join(installed, "apps/desktop/package.json"));
const executable = require("electron");
const { _electron } = await import("/Users/cain/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const scratch = await mkdtemp(join(tmpdir(), "outlive-ux086-installed-gui-"));
const userData = join(scratch, "user-data");
const main = join(installed, "apps/desktop/dist/main.js");
const preload = join(installed, "apps/desktop/dist/preload.cjs");
const bootstrap = join(scratch, "archive-preview-bootstrap.cjs");
await writeFile(bootstrap, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(userData)});\nimport(${JSON.stringify(pathToFileURL(main).href)});\n`);
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
const application = await _electron.launch({ executablePath: executable, args: [bootstrap, "--preview"], env: environment, timeout: 20000 });
const pid = application.process().pid;
const record = { schema_version: "outlive.installed-desktop-preview.v1", status: "observing", participant_class: "simulated", independent_non_maintainer: false, archive_sha256: "584cabba81055cd973b1fabc0e70bb517477f69c50c93184cabcce8002dcc53a", executable, installed_root: installed, compiled_main: main, compiled_main_sha256: createHash("sha256").update(await readFile(main)).digest("hex"), compiled_preload: preload, compiled_preload_sha256: createHash("sha256").update(await readFile(preload)).digest("hex"), bootstrap, user_data: userData, pid, data_boundary: "Actual unsigned native Electron Preview; synthetic deterministic data; no Host or model started", screenshots: [], recorded_at: new Date().toISOString() };
const serialize = () => writeFile(join(output, "gui-preview.json"), JSON.stringify(record, null, 2) + "\n");
let failure;
try {
  const page = await application.firstWindow();
  await page.waitForSelector(".outlive-workbench");
  await page.getByText("Preview", { exact: true }).first().waitFor();
  assert.match(page.url(), /\/apps\/desktop\/dist\/renderer\/index\.html\?preview=1$/u);
  const windows = await application.evaluate(({ BrowserWindow, app }) => ({ userData: app.getPath("userData"), windows: BrowserWindow.getAllWindows().map((window) => ({ title: window.getTitle(), visible: window.isVisible(), preferences: window.webContents.getLastWebPreferences() })) }));
  assert.equal(windows.userData, userData);
  assert.ok(windows.windows.some((window) => window.visible && window.preferences.preload === preload && window.preferences.sandbox === true && window.preferences.contextIsolation === true && window.preferences.nodeIntegration === false));
  record.native_window = windows;
  record.frame_url = page.url();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.screenshot({ path: join(output, "installed-preview-1440x900.png") });
  record.screenshots.push("installed-preview-1440x900.png");
  await serialize();
  process.stdout.write(JSON.stringify({ ready_for_native_observation: true, pid, executable, compiled_main: main, frame_url: page.url() }) + "\n");
  const deadline = Date.now() + 180000;
  let observed = false;
  while (Date.now() < deadline) {
    try { await access(join(output, "gui-observation-done.txt")); observed = true; break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  record.native_observation_marker = observed;
  assert.equal(observed, true, "Native GUI observation was not acknowledged before the bounded timeout");
  await page.locator('.preview-control select').selectOption("ready_for_review");
  await page.locator('.changes-view').waitFor();
  await page.screenshot({ path: join(output, "installed-preview-review-1440x900.png") });
  record.screenshots.push("installed-preview-review-1440x900.png");
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, readOnlyGatePresent: document.querySelector('.compact-gate') !== null }));
  assert.equal(layout.width, 1440); assert.equal(layout.height, 900); assert.ok(layout.scrollWidth <= layout.width); assert.equal(layout.readOnlyGatePresent, false);
  record.review_layout = layout;
} catch (error) {
  failure = error;
  record.failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  try {
    await application.close();
    try { process.kill(pid, 0); throw new Error("Owned installed Electron process remains after close"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    record.owned_process_absent = true;
  } catch (error) {
    record.cleanup_failure = { name: error.name, message: error.message };
    failure ??= error;
  }
  record.status = failure ? "failed" : "passed";
  record.finished_at = new Date().toISOString();
  await serialize();
}
if (failure) throw failure;
process.stdout.write("Installed native Preview evidence completed after process cleanup.\n");
