#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPreviewIntegrity } from "./verify-preview-integrity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function main() {
  const inventory = await verifyPreviewIntegrity(root, { installed: true });
  const canonicalRoot = await realpath(root);
  const temporary = await mkdtemp(join(tmpdir(), "outlive-installed-smoke-"));
  for (const name of ["@tracegraph/core", "@tracegraph/contracts", "@tracegraph/host", "@tracegraph/sdk"]) {
    const resolution = await run(process.execPath, ["--input-type=module", "--eval", "process.stdout.write(import.meta.resolve(process.argv[1]));", "--", name], join(root, "apps/cli"));
    assert.equal(resolution.code, 0, resolution.stderr);
    const resolved = await realpath(fileURLToPath(resolution.stdout));
    assert.ok(resolved.startsWith(canonicalRoot + sep), `Installed package ${name} escaped the extracted archive`);
  }
  const { startLocalHost } = await import("../packages/host/dist/index.js");
  const { TraceGraphClient } = await import("../packages/sdk/dist/index.js");
  const { launchDesktopHostProcess } = await import("../apps/desktop-host/dist/index.js");
  const profileRoot = join(temporary, "profile");
  let host, desktop;
  try {
    host = await startLocalHost({ profileRoot, httpPort: 0, credentialBackend: "private-file" });
    const sharedStatus = host.status;
    const gateway = new TraceGraphClient({ baseUrl: sharedStatus.http_address });
    await gateway.bootstrap();
    const gatewayResult = await gateway.listSessions();
    const cli = await run(process.execPath, [join(root, "apps/cli/dist/index.js"), "sessions", "list", "--profile-root", profileRoot, "--json"]);
    assert.equal(cli.code, 0, cli.stderr);
    const cliResult = JSON.parse(cli.stdout);
    assert.deepEqual(cliResult.sessions, []);
    assert.deepEqual(cliResult.sessions, gatewayResult.sessions);
    desktop = await launchDesktopHostProcess({ dataDir: join(temporary, "desktop-data") });
    const sessionReply = await desktop.client.query({ operation: "session.list", input: { view: "roots", limit: 20 } });
    assert.equal(sessionReply.resource, "sessions");
    assert.deepEqual(sessionReply.value.sessions, []);
    const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
    assert.equal(desktop.identity.package_version, version);
    const identity = desktop.identity, pid = desktop.childProcess.pid;
    const exit = await desktop.close(); desktop = undefined;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
    const report = { schema_version: "tracegraph.preview-smoke.v1", status: "passed", recorded_at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, version,
      evidence_scope: "extracted preview on the current machine; clean-machine and independent-user context must be supplied by the verifier",
      cli: { command: "sessions list --profile-root <isolated> --json", transport: "authenticated private local channel", exit_code: cli.code, session_count: cliResult.sessions.length }, shared_host: { profile_id: sharedStatus.profile_id, protocol_version: sharedStatus.protocol_version, gateway_same_sessions: true }, desktop_host: { mode: "legacy framed compatibility seam", identity, exit, child_absent: true },
      desktop_gui: "not tested by this headless smoke; launch separately", package_resolution: "within extracted archive", inventory,
    };
    await publishAfterSmokeCleanup([
      async () => { await host.close(); host = undefined; await assert.rejects(() => gateway.listSessions()); },
    ], async () => {
      await writeFile(join(temporary, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ ...report, report_path: join(temporary, "report.json") }, null, 2)}\n`);
    });
  } finally {
    // Failure cleanup is best-effort and cannot manufacture a success receipt.
    await Promise.allSettled([desktop?.close(), host?.close()]);
  }
}

/** A success receipt exists only after every owned resource is settled. */
export async function publishAfterSmokeCleanup(cleanups, publish) {
  const failures = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Installed smoke cleanup failed; no success report was written");
  await publish();
}

async function run(file, args, cwd = root) {
  const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const child = spawn(file, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  return new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); }); });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
