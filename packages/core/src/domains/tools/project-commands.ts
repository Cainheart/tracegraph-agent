import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RelativePathSchema, Sha256Schema, type RawToolResult, type SandboxReport, type WorkspaceHandle } from "@tracegraph/contracts";
import { type ToolDefinition, type ToolExecutionContext } from "@tracegraph/tool";
import { z } from "zod";
import { RawToolResultSchema } from "../../kernel/raw-tool-result.js";
import { redactSensitiveText, sha256 } from "../../kernel/crypto.js";
import { assertInside } from "../../kernel/workspace.js";
import { createSandboxRunner } from "../../seams/sandbox/runner.js";

const MANIFEST_MAX_BYTES = 64 * 1024;
const OUTPUT_MAX_BYTES = 64 * 1024;
const PRIVATE_COMPONENTS = new Set([".git", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".config", "node_modules"]);
const CommandNameSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
const ArgSchema = z.string().max(2_000).refine((value) => !/[\0\r\n]/u.test(value), "command arguments must not contain control characters");
const ExecutableSchema = z.enum(["node", "python3", "cargo", "go", "make", "npm", "pnpm", "yarn", "bun"]);
export const ProjectCommandConfigSchema = z.object({
  version: z.literal(1),
  commands: z.record(CommandNameSchema, z.object({
    executable: ExecutableSchema,
    args: z.array(ArgSchema).max(64),
    cwd: RelativePathSchema.default("."),
  }).strict()).refine((commands) => Object.keys(commands).length > 0 && Object.keys(commands).length <= 32, "declare between 1 and 32 commands"),
}).strict();
export const DiscoverProjectCommandsInputSchema = z.object({ path: RelativePathSchema.default("."), offset: z.number().int().min(0).max(132).optional(), limit: z.number().int().min(1).max(20).optional() }).strict();
export const RunProjectCommandInputSchema = z.object({
  /** An existing package.json or outlive.commands.json from discovery. */
  path: RelativePathSchema,
  command: CommandNameSchema,
  expected_manifest_sha256: Sha256Schema,
  timeout_ms: z.number().int().min(100).max(120_000).default(30_000),
}).strict();

type Entry = { name: string; executable: z.infer<typeof ExecutableSchema>; args: string[]; cwd: string };
type Manifest = { path: string; hash: string; entries: Entry[] };

/** A bounded catalog of existing commands. Reading a manifest never grants execution permission. */
export const discoverProjectCommandsTool: ToolDefinition<z.infer<typeof DiscoverProjectCommandsInputSchema>> = {
  name: "discover_project_commands", description: "Discover existing package.json scripts and outlive.commands.json argv commands under one project directory. Returns manifest hashes for checked execution; does not run or install anything.",
  inputSchema: DiscoverProjectCommandsInputSchema, outputSchema: RawToolResultSchema, capability: "read", requiresApproval: false,
  sideEffect: "read", concurrencySafe: true, timeoutMs: 5_000, maxResultBytes: 48 * 1024,
  presentation: { callLabel: "Discover project commands", resultLabel: "Existing project commands" },
  render(_input, output) { return output; },
  async execute(input, context) {
    try {
      await requireScopedDirectory(context.workspace, input.path);
      const manifests: Manifest[] = [];
      for (const name of ["package.json", "outlive.commands.json"]) {
        const path = projectRelative(join(input.path, name));
        const manifest = await readManifest(context.workspace, path, true);
        if (manifest !== undefined) manifests.push(manifest);
      }
      const allCommands = manifests.flatMap((manifest) => manifest.entries.map((entry) => ({
        command: entry.name, path: manifest.path, manifest_sha256: manifest.hash,
        executable: entry.executable, working_directory: entry.cwd,
      })));
      const offset = input.offset ?? 0;
      const commands = allCommands.slice(offset, offset + (input.limit ?? 20));
      const truncated = offset + commands.length < allCommands.length;
      return { status: "success", code: "project_commands_discovered", summary: `Discovered ${allCommands.length} existing project commands; returned ${commands.length}`, content: JSON.stringify({ commands }, null, 2), mimeType: "application/json", facts: { commands, count: commands.length, total_count: allCommands.length, offset, truncated, ...(truncated ? { next_offset: offset + commands.length } : {}), trust: "untrusted_project_manifest", executed: false } };
    } catch (error) { return commandError(error); }
  },
};

/** Model input chooses an existing entry; it never contains an executable, argv, shell, or env. */
export const runProjectCommandTool: ToolDefinition<z.infer<typeof RunProjectCommandInputSchema>> = {
  name: "run_project_command", description: "Run one existing command returned by discover_project_commands, bound to its exact manifest SHA256. Uses current workspace permissions and OS sandbox; no shell/env/argv may be supplied by the model. A zero exit proves only this command succeeded. After timeout, cancellation, or unknown output, do not retry automatically because disk effects may have occurred.",
  inputSchema: RunProjectCommandInputSchema, outputSchema: RawToolResultSchema, capability: "run_command", requiresApproval: false,
  sideEffect: "execute", concurrencySafe: false, timeoutMs: 125_000, maxResultBytes: 96 * 1024,
  presentation: { callLabel: "Run project command", resultLabel: "Project command result" },
  render(_input, output) { return output; },
  async execute(input, context) {
    let dispatchAttempted = false;
    let sandboxReport: SandboxReport | undefined;
    try {
      const manifest = await readManifest(context.workspace, input.path, false);
      if (manifest === undefined) throw new CommandError("command_manifest_missing", "The selected project command manifest is unavailable");
      if (manifest.hash !== input.expected_manifest_sha256) throw new CommandError("command_manifest_changed", "The command manifest changed; discover commands again before executing");
      const entry = manifest.entries.find(({ name }) => name === input.command);
      if (entry === undefined) throw new CommandError("project_command_missing", "The selected command is absent from this manifest");
      const cwd = await requireScopedDirectory(context.workspace, entry.cwd);
      const executable = await resolveTrustedExecutable(entry.executable, context.workspace);
      if (context.signal?.aborted) return { status: "failure", code: "tool_aborted", summary: "Project command was stopped before dispatch", facts: { started: false } };
      const runner = context.sandboxRunner ?? createSandboxRunner();
      const mode = context.sandboxMode ?? "workspace-write";
      sandboxReport = await runner.probe({ mode, workspaceRoot: context.workspace.real_root });
      if (context.signal?.aborted) return { status: "failure", code: "tool_aborted", summary: "Project command was stopped before dispatch", facts: { started: false } };
      // Hold the wrapper open until the process boundary confirms quiescence.
      // Its signal still cancels the child and every owned process-group member.
      context.cancellationShield?.arm();
      dispatchAttempted = true;
      const result = await runner.run({
        mode, workspaceRoot: context.workspace.real_root,
        cwd, executable, args: entry.args, timeoutMs: input.timeout_ms, maxOutputBytes: OUTPUT_MAX_BYTES,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const code = !result.started || result.failureCode === "sandbox_unavailable" ? "sandbox_unavailable"
        : result.aborted ? "tool_aborted" : result.timedOut ? "timeout" : result.truncated ? "command_output_limit"
          : result.exitCode === 0 ? "project_command_passed" : result.exitCode === null ? "command_outcome_unknown" : "project_command_failed";
      return {
        status: code === "project_command_passed" ? "success" : code === "command_outcome_unknown" ? "unknown" : "failure",
        code, summary: code === "project_command_passed" ? `Project command ${input.command} exited successfully`
          : code === "sandbox_unavailable" ? "Project command was not started because sandbox enforcement is unavailable"
            : code === "timeout" ? `Project command ${input.command} exceeded its ${input.timeout_ms}ms timeout`
              : code === "tool_aborted" ? `Project command ${input.command} was stopped`
                : code === "command_output_limit" ? `Project command ${input.command} exceeded its output limit`
                  : code === "command_outcome_unknown" ? "Project command outcome is unknown; inspect its effects before any new attempt"
                    : `Project command ${input.command} failed with exit ${result.exitCode}`,
        content: redactSensitiveText(JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2)), mimeType: "application/json",
        facts: { command: input.command, path: input.path, manifest_sha256: manifest.hash, executable: entry.executable, working_directory: entry.cwd,
          exit_code: result.exitCode, timed_out: result.timedOut, aborted: result.aborted, output_truncated: result.truncated,
          started: result.started, sandbox_report: result.sandboxReport, effects_may_have_occurred: result.started,
          automatic_retry_allowed: false },
      };
    } catch (error) {
      if (!dispatchAttempted) return commandError(error);
      return { status: "unknown", code: "command_outcome_unknown", summary: "Project command dispatch did not yield a verified result; inspect its effects before any new attempt", facts: {
        command: input.command, path: input.path, manifest_sha256: input.expected_manifest_sha256,
        dispatch_attempted: true, start_state: "unknown", effects_may_have_occurred: true, automatic_retry_allowed: false,
        ...(sandboxReport === undefined ? {} : { sandbox_report: sandboxReport }),
      } };
    }
  },
};

async function readManifest(workspace: WorkspaceHandle, path: string, optional: boolean): Promise<Manifest | undefined> {
  if (!["package.json", "outlive.commands.json"].includes(path.split("/").at(-1) ?? "")) throw new CommandError("command_manifest_invalid", "Choose an existing package.json or outlive.commands.json manifest");
  let bytes: Buffer;
  try {
    const target = await requireScopedPath(workspace, path);
    const expected = await lstat(target);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (info.dev !== expected.dev || info.ino !== expected.ino || info.nlink !== 1) throw new CommandError("command_scope_denied", "Project command manifest identity changed or uses a hard link");
      if (!info.isFile() || info.size > MANIFEST_MAX_BYTES) throw new CommandError("command_manifest_limit", "Project command manifest must be a regular file at most 65536 bytes");
      const bounded = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
      if (bytesRead > MANIFEST_MAX_BYTES) throw new CommandError("command_manifest_limit", "Project command manifest exceeds its byte limit");
      bytes = bounded.subarray(0, bytesRead);
      await requireScopedPath(workspace, path);
    } finally { await handle.close(); }
  } catch (error) {
    if (optional && isMissing(error)) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const cwd = projectRelative(dirname(path));
  let entries: Entry[];
  if (path.endsWith("outlive.commands.json")) {
    const config = ProjectCommandConfigSchema.parse(value);
    entries = Object.entries(config.commands).map(([name, command]) => ({ name, executable: command.executable, args: command.args, cwd: projectRelative(join(cwd, command.cwd)) }));
  } else {
    const parsed = z.object({ scripts: z.record(CommandNameSchema, z.string().min(1).max(4_000)).optional(), packageManager: z.string().max(160).optional() }).passthrough().parse(value);
    const names = Object.keys(parsed.scripts ?? {}).sort();
    if (names.length > 100) throw new CommandError("command_manifest_limit", "Package manifest has too many scripts");
    const executable = parsed.packageManager === undefined ? "npm" : ExecutableSchema.parse(parsed.packageManager.split("@")[0]);
    if (!["npm", "pnpm", "yarn", "bun"].includes(executable)) throw new CommandError("command_manifest_invalid", "Package manager must be npm, pnpm, yarn, or bun");
    entries = names.map((name) => ({ name, executable, args: ["run", name], cwd }));
  }
  for (const entry of entries) {
    if (entry.args.some((arg) => isAbsolute(arg))) throw new CommandError("command_manifest_invalid", "Declared command argv must not contain absolute paths");
    if (Buffer.byteLength(JSON.stringify(entry.args), "utf8") > 16 * 1024) throw new CommandError("command_manifest_limit", "Declared command argv exceeds its byte limit");
    await requireScopedDirectory(workspace, entry.cwd);
  }
  return { path, hash: sha256(bytes), entries };
}

async function requireScopedPath(workspace: WorkspaceHandle, path: string): Promise<string> {
  const parsed = RelativePathSchema.parse(path);
  if (parsed.split("/").some((part) => PRIVATE_COMPONENTS.has(part.toLowerCase()) || /^\.env(?:\.|$)/iu.test(part))) throw new CommandError("command_scope_denied", "Project command paths must not read private or dependency directories");
  const root = await realpath(workspace.real_root);
  const candidate = resolve(root, parsed);
  assertInside(root, candidate);
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new CommandError("command_scope_denied", "Project command paths must not follow symbolic links");
  }
  const canonical = await realpath(candidate);
  assertInside(root, canonical);
  return canonical;
}

async function requireScopedDirectory(workspace: WorkspaceHandle, path: string): Promise<string> {
  const canonical = await requireScopedPath(workspace, path);
  if (!(await lstat(canonical)).isDirectory()) throw new CommandError("command_scope_denied", "Project command working directory is not a scoped directory");
  return canonical;
}

async function resolveTrustedExecutable(name: z.infer<typeof ExecutableSchema>, workspace: WorkspaceHandle): Promise<string> {
  if (name === "node") return realpath(process.execPath);
  const root = await realpath(workspace.real_root);
  // Do not resolve executable names from a project-controlled or relative PATH.
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = resolve(directory, process.platform === "win32" ? `${name}.exe` : name);
    try {
      const canonical = await realpath(candidate);
      const fromRoot = relative(root, canonical);
      if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) continue;
      if (!(await lstat(canonical)).isFile()) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch { /* Try the next host-owned PATH entry. */ }
  }
  throw new CommandError("command_runtime_unavailable", `The ${name} command runtime is unavailable; install it or declare an existing node command`);
}

function projectRelative(path: string): string { return RelativePathSchema.parse(path.split(sep).join("/")); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
class CommandError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function commandError(error: unknown): RawToolResult {
  return { status: "failure", code: error instanceof CommandError ? error.code : "command_manifest_invalid", summary: error instanceof CommandError ? error.message : "Project command configuration is invalid or outside the workspace", facts: { started: false, automatic_retry_allowed: false } };
}
