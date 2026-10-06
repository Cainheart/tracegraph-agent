import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ToolExecutionContext } from "@tracegraph/tool";
import { createManagedWorkspaceHandle } from "../../kernel/workspace.js";
import { sha256 } from "../../kernel/crypto.js";
import { NativeSandboxRunner } from "../../seams/sandbox/runner.js";
import { executeToolDefinition } from "./executor.js";
import { DiscoverProjectCommandsInputSchema, ProjectCommandConfigSchema, RunProjectCommandInputSchema, discoverProjectCommandsTool, runProjectCommandTool } from "./project-commands.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("existing project command discovery and real execution", () => {
  it("discovers package scripts and typed argv without executing or disclosing script bodies", async () => {
    const harness = await fixture("discover");
    await writeFile(join(harness.root, "package.json"), JSON.stringify({ scripts: { test: "node command.mjs", dangerous: "printf $PRIVATE_SECRET" }, packageManager: "npm@11.0.0" }));
    const result = await discoverProjectCommandsTool.execute({ path: "." }, harness.context);
    expect(result.status).toBe("success");
    expect(result.facts).toMatchObject({ count: 3, executed: false, trust: "untrusted_project_manifest" });
    expect(result.content).not.toContain("PRIVATE_SECRET");
    expect(result.content).not.toContain("node command.mjs");
    await expect(stat(join(harness.root, "effect.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes a declared node command and returns actual separate stdout/stderr and exit", async () => {
    const harness = await fixture("real-node");
    const result = await run(harness);
    expect(result).toMatchObject({ status: "success", code: "project_command_passed", facts: { exit_code: 0, started: true, automatic_retry_allowed: false } });
    expect(JSON.parse(result.content!)).toEqual({ stdout: "BUILD_ACTUALLY_RAN\n", stderr: "REAL_STDERR\n" });
    expect(JSON.parse(await readFile(join(harness.root, "effect.json"), "utf8"))).toEqual({ built: true });
  });

  it("pages a bounded command catalog and refuses private directories", async () => {
    const harness = await fixture("paged-private");
    await writeFile(join(harness.root, "package.json"), JSON.stringify({scripts:Object.fromEntries(Array.from({length:25},(_,i)=>[`cmd${String(i).padStart(2,"0")}`,"node command.mjs"]))}));
    const first=await discoverProjectCommandsTool.execute({path:"."},harness.context);
    expect(first.facts).toMatchObject({count:20,total_count:26,truncated:true,next_offset:20});
    const second=await discoverProjectCommandsTool.execute({path:".",offset:20},harness.context);
    expect(second.facts).toMatchObject({count:6,total_count:26,truncated:false});
    await mkdir(join(harness.root,".ssh"));
    await writeFile(join(harness.root,".ssh/package.json"),JSON.stringify({scripts:{private:"node command.mjs"}}));
    expect(await discoverProjectCommandsTool.execute({path:".ssh"},harness.context)).toMatchObject({status:"failure",code:"command_scope_denied"});
  });

  it("uses actual npm script semantics, including pre/post hooks, without a fixture suite", async () => {
    const harness = await fixture("real-package");
    await writeFile(join(harness.root, "package.json"), JSON.stringify({ name: "command-proof", private: true, scripts: { preverify: "node -e \"require('fs').writeFileSync('pre.txt','pre')\"", verify: "node command.mjs", postverify: "node -e \"require('fs').writeFileSync('post.txt','post')\"" } }));
    const manifest = await readFile(join(harness.root, "package.json"));
    const result = await runProjectCommandTool.execute({ path: "package.json", command: "verify", expected_manifest_sha256: sha256(manifest), timeout_ms: 10_000 }, harness.context);
    expect(result).toMatchObject({ status: "success", code: "project_command_passed" });
    expect(await readFile(join(harness.root, "pre.txt"), "utf8")).toBe("pre");
    expect(await readFile(join(harness.root, "post.txt"), "utf8")).toBe("post");
  });

  it("rejects a changed manifest or missing entry before any disk effect", async () => {
    const harness = await fixture("manifest-cas");
    const original = sha256(await readFile(join(harness.root, "outlive.commands.json")));
    await writeFile(join(harness.root, "outlive.commands.json"), JSON.stringify({ version: 1, commands: { build: { executable: "node", args: ["command.mjs", "new-intent"] } } }));
    expect(await runProjectCommandTool.execute({ path: "outlive.commands.json", command: "build", expected_manifest_sha256: original, timeout_ms: 1_000 }, harness.context)).toMatchObject({ status: "failure", code: "command_manifest_changed", facts: { started: false } });
    expect(await run(harness, "missing")).toMatchObject({ status: "failure", code: "project_command_missing" });
    await expect(stat(join(harness.root, "effect.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never treats nonzero exit and partial disk effects as business success", async () => {
    const harness = await fixture("nonzero", "import {writeFileSync} from 'node:fs'; writeFileSync('effect.json','partial'); console.error('FAILED_REAL'); process.exit(7);");
    const result = await run(harness);
    expect(result).toMatchObject({ status: "failure", code: "project_command_failed", facts: { exit_code: 7, effects_may_have_occurred: true } });
    expect(JSON.parse(result.content!).stderr).toBe("FAILED_REAL\n");
    expect(await readFile(join(harness.root, "effect.json"), "utf8")).toBe("partial");
  });

  it("settles actual timeout and preserves partial output without automatically retrying", async () => {
    const harness = await fixture("timeout", "import {writeFileSync} from 'node:fs'; writeFileSync('ready.txt','ready'); console.log('PARTIAL_TIMEOUT'); setInterval(()=>{},1000);");
    const result = await run(harness, "build", 150);
    expect(result).toMatchObject({ status: "failure", code: "timeout", facts: { timed_out: true, automatic_retry_allowed: false } });
    expect(JSON.parse(result.content!).stdout).toBe("PARTIAL_TIMEOUT\n");
  });

  it("waits for actual child cancellation and returns real output through the executor shield", async () => {
    const harness = await fixture("cancel", "import {writeFileSync} from 'node:fs'; process.stdout.write('PARTIAL_CANCEL\\n',()=>{writeFileSync('ready.txt','ready');setInterval(()=>{},1000);});");
    const controller = new AbortController();
    const execution = run(harness, "build", 10_000, { signal: controller.signal });
    await waitForFile(join(harness.root, "ready.txt"));
    controller.abort(new Error("user stopped this test"));
    const result = await execution;
    expect(result).toMatchObject({ status: "failure", code: "tool_aborted", facts: { aborted: true, automatic_retry_allowed: false } });
    expect(JSON.parse(result.content!).stdout).toBe("PARTIAL_CANCEL\n");
  });

  it("bounds actual command output and does not claim an over-limit success", async () => {
    const harness = await fixture("output", "process.stdout.write('x'.repeat(200000)); setInterval(()=>{},1000);");
    const result = await run(harness);
    expect(result).toMatchObject({ status: "failure", code: "command_output_limit", facts: { output_truncated: true } });
    expect(Buffer.byteLength(JSON.parse(result.content!).stdout)).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps a dispatched runner exception unknown, with no fake pre-dispatch failure", async () => {
    const harness = await fixture("unknown");
    const runner = new NativeSandboxRunner();
    const result = await run(harness, "build", 1_000, { sandboxRunner: { probe: (request) => runner.probe(request), async run() { await writeFile(join(harness.root, "effect.json"), "UNCERTAIN_EXTERNAL_EFFECT"); throw new Error("unknown transport outcome"); } } });
    expect(result).toMatchObject({ status: "unknown", code: "command_outcome_unknown", facts: { start_state: "unknown", effects_may_have_occurred: true, automatic_retry_allowed: false } });
    expect(await readFile(join(harness.root, "effect.json"), "utf8")).toBe("UNCERTAIN_EXTERNAL_EFFECT");
  });

  it("fails closed when the configured restricted sandbox cannot enforce isolation", async () => {
    const harness = await fixture("unavailable");
    const result = await run(harness, "build", 1_000, { sandboxMode: "workspace-write", sandboxRunner: new NativeSandboxRunner({ platform: "linux" }) });
    expect(result).toMatchObject({ status: "failure", code: "sandbox_unavailable", facts: { started: false } });
    await expect(stat(join(harness.root, "effect.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects inside/outside symlink manifests and escaping cwd", async () => {
    const harness = await fixture("scope");
    await mkdir(join(harness.root, "nested"));
    await symlink(join(harness.root, "outlive.commands.json"), join(harness.root, "nested/outlive.commands.json"));
    expect(await discoverProjectCommandsTool.execute({ path: "nested" }, harness.context)).toMatchObject({ status: "failure", code: "command_scope_denied" });
    await rm(join(harness.root, "outlive.commands.json"));
    const outside = await mkdtemp(join(tmpdir(), "outlive-command-outside-")); roots.push(outside);
    await writeFile(join(outside, "outlive.commands.json"), JSON.stringify({ version: 1, commands: { bad: { executable: "node", args: ["x"], cwd: "." } } }));
    await symlink(join(outside, "outlive.commands.json"), join(harness.root, "outlive.commands.json"));
    expect(await discoverProjectCommandsTool.execute({ path: "." }, harness.context)).toMatchObject({ status: "failure", code: "command_scope_denied" });
    expect(ProjectCommandConfigSchema.safeParse({ version: 1, commands: { bad: { executable: "node", args: [], cwd: "../outside" } } }).success).toBe(false);
  });

  it("rejects shell/env/argv authority in model calls, unsafe config, and excessive manifests", async () => {
    const harness = await fixture("negative-schema");
    expect(RunProjectCommandInputSchema.safeParse({ path: "outlive.commands.json", command: "build", expected_manifest_sha256: sha256("x"), shell: "sudo arbitrary" }).success).toBe(false);
    expect(DiscoverProjectCommandsInputSchema.safeParse({ path: ".", executable: "node" }).success).toBe(false);
    for (const command of [{ executable: "sh", args: ["-c", "x"] }, { executable: "node", args: [], env: { TOKEN: "x" } }, { executable: "node", args: ["x\u0000y"] }]) {
      expect(ProjectCommandConfigSchema.safeParse({ version: 1, commands: { bad: command } }).success).toBe(false);
    }
    await writeFile(join(harness.root, "outlive.commands.json"), " ".repeat(65_537));
    expect(await discoverProjectCommandsTool.execute({ path: "." }, harness.context)).toMatchObject({ status: "failure", code: "command_manifest_limit" });
  });
});

async function fixture(name: string, source = "import {writeFileSync} from 'node:fs'; writeFileSync('effect.json',JSON.stringify({built:true})); console.log('BUILD_ACTUALLY_RAN'); console.error('REAL_STDERR');") {
  const root = await mkdtemp(join(tmpdir(), `outlive-project-command-${name}-`)); roots.push(root);
  await writeFile(join(root, "command.mjs"), source);
  await writeFile(join(root, "outlive.commands.json"), JSON.stringify({ version: 1, commands: { build: { executable: "node", args: ["command.mjs"], cwd: "." } } }));
  const workspace = await createManagedWorkspaceHandle({ projectId: `project:${name}`, root: await realpath(root) });
  return { root, context: { projectId: workspace.project_id, runId: `run:${name}`, workspace, sandboxMode: "danger-full-access" as const } };
}

async function run(harness: Awaited<ReturnType<typeof fixture>>, command = "build", timeout_ms = 3_000, override: Partial<ToolExecutionContext> = {}) {
  let armed = false;
  return executeToolDefinition(runProjectCommandTool, RunProjectCommandInputSchema.parse({ path: "outlive.commands.json", command, timeout_ms, expected_manifest_sha256: sha256(await readFile(join(harness.root, "outlive.commands.json"))) }), { ...harness.context, cancellationShield: { arm() { armed = true; }, isArmed() { return armed; } }, ...override });
}
async function waitForFile(path: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) { try { await stat(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
  throw new Error("actual command did not reach its readiness file");
}
