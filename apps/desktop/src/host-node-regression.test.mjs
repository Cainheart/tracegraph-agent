import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import electronExecutable from "electron";

test("real Electron-origin Host uses independent Node for sandboxed builtin tests", {
  timeout: 40_000, skip: process.platform !== "darwin" && "the enabled native workspace-write backend is macOS Seatbelt",
}, async () => {
  const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "LANG", "LC_ALL"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const child = fork(fileURLToPath(new URL("../../desktop-host/src/electron-origin-regression.mjs", import.meta.url)), [], {
    execPath: electronExecutable, execArgv: [], env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let receipt;
  child.on("message", (message) => { receipt = message; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Electron regression timed out")), 35_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Electron regression failed (${String(code)}): ${stderr}`)); });
    });
    assert.ok(receipt?.electron);
    assert.notEqual(receipt.selected_node, receipt.parent_executable);
    assert.equal(receipt.builtin_node, receipt.selected_node);
    assert.equal(receipt.status, "completed");
    assert.match(receipt.test_log, /2\/2 fixture assertions passed/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
