#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyPreviewIntegrity } from "./verify-preview-integrity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wantsDesktop = process.argv.slice(2).includes("--desktop");
const desktopRuntimeOnly = process.argv.slice(2).includes("--desktop-runtime");
if (process.argv.slice(2).some((argument) => argument !== "--desktop" && argument !== "--desktop-runtime") || wantsDesktop && desktopRuntimeOnly) throw new Error("Usage: node scripts/preview-install.mjs [--desktop | --desktop-runtime]");
const version = Number(process.versions.node.split(".")[0]);
if (!(version === 22 && Number(process.versions.node.split(".")[1]) >= 19) && version < 24) throw new Error("Preview requires Node ^22.19.0 or >=24.0.0");
await verifyPreviewIntegrity(root, { installed: desktopRuntimeOnly });
if (!desktopRuntimeOnly) {
  await command("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]);
  await command(process.execPath,[join(root,"scripts/prepare-native.mjs")]);
}
if (wantsDesktop || desktopRuntimeOnly) {
  const require = createRequire(join(root, "apps/desktop/package.json"));
  // pnpm intentionally does not allow Electron lifecycle scripts in the workspace.
  // This flag is the user's explicit request for the pinned native runtime download.
  const installer = join(dirname(require.resolve("electron/package.json")), "install.js");
  await command(process.execPath, [installer]);
}
process.stdout.write(`Verified preview installed${wantsDesktop || desktopRuntimeOnly ? " with Electron" : " for CLI/Host; use --desktop-runtime to add the GUI runtime"}.\n`);

async function command(file, args) {
  const child = spawn(file, args, { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true" } });
  await new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? done() : reject(new Error(`${file} failed: ${code ?? signal}`))); });
}
