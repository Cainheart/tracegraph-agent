import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  createAgentRuntime,
  createFixtureSandboxRunner,
  JsonlSessionStore,
  sha256,
  SubagentRegistry,
} from "@tracegraph/core";
import {
  MAX_MOCK_PROVIDER_STEPS,
  ScriptedMockProvider,
  type MockProviderStep,
} from "../mock-provider.js";
import {
  createFailingTypescriptFixture,
  createSequentialIdFactory,
  createTemporaryDataDir,
} from "../fixtures.js";
import {
  MAX_RECORDED_MODEL_STEPS,
  MAX_RECORDED_SESSION_FILE_BYTES,
  MAX_RECORDED_SESSION_TOTAL_BYTES,
  MAX_RECORDED_WORKSPACE_ENTRIES,
  MAX_RECORDED_WORKSPACE_FILE_BYTES,
  MAX_RECORDED_WORKSPACE_TOTAL_BYTES,
  RecordedModelStepSchema,
  RecordedSessionCaptureSchema,
  RecordedSessionInputSchema,
  RecordedSessionManifestSchema,
  RecordedSessionResultSchema,
  type RecordedModelStep,
  type RecordedSessionCapture,
  type RecordedSessionInput,
  type RecordedSessionManifest,
  type RecordedSessionResult,
  type RecordedSessionWorkspaceEntry,
} from "./schema.js";

const SNAPSHOT_FILES = ["REDACTION.md", "expected.json", "input.json", "model-stream.jsonl", "snapshot.json"] as const;
const INPUT_FILE = "input.json";
const MODEL_STREAM_FILE = "model-stream.jsonl";
const EXPECTED_FILE = "expected.json";

export class RecordedSessionSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordedSessionSnapshotError";
    this.code = code;
  }
}

interface SnapshotContents {
  readonly directory: string;
  readonly manifest: RecordedSessionManifest;
  readonly input: RecordedSessionInput;
  readonly modelSteps: ReturnType<typeof RecordedModelStepSchema.parse>[];
  readonly expected: RecordedSessionResult;
  readonly files: Readonly<Record<(typeof SNAPSHOT_FILES)[number], string>>;
}

export interface RecordedSessionSnapshotOptions {
  readonly snapshotsRoot: string;
  readonly caseId: string;
}

export interface RecordRecordedSessionOptions extends RecordedSessionSnapshotOptions {
  readonly sourceFile: string;
  readonly write: boolean;
}

export interface RefreshRecordedSessionOptions extends RecordedSessionSnapshotOptions {
  readonly write?: boolean;
}

export interface RefreshRecordedSessionResult {
  readonly changed: boolean;
  readonly diff: string;
  readonly written: boolean;
}

export function validateSnapshotCaseId(caseId: string): readonly string[] {
  if (typeof caseId !== "string" || caseId.length > 128) {
    throw new RecordedSessionSnapshotError("snapshot_case_id_invalid", "Snapshot case id is invalid");
  }
  const segments = caseId.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(segment))) {
    throw new RecordedSessionSnapshotError("snapshot_case_id_invalid", "Snapshot case id must be profile/scenario in lowercase kebab case");
  }
  return segments;
}

/** Fail closed on content that cannot safely be checked into a snapshot. */
export function assertRecordedSessionRedacted(value: unknown): void {
  const visit = (current: unknown, pointer: string): void => {
    if (typeof current === "string") {
      if (containsSensitiveString(current)) {
        throw new RecordedSessionSnapshotError("snapshot_redaction_failed", "Snapshot content contains a credential or personal absolute path");
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        throw new RecordedSessionSnapshotError("snapshot_redaction_failed", "Snapshot content contains a credential-bearing field");
      }
      visit(child, `${pointer}/${escapePointer(key)}`);
    }
  };
  visit(value, "");
}

export async function replayRecordedSessionSnapshot(
  options: RecordedSessionSnapshotOptions,
): Promise<RecordedSessionResult> {
  const snapshot = await readSnapshot(options.snapshotsRoot, options.caseId);
  const actual = await runRecordedScenario(snapshot.input, snapshot.modelSteps);
  assertRecordedSessionRedacted(actual);
  if (!sameJson(snapshot.expected, actual)) {
    throw new RecordedSessionSnapshotError("snapshot_drift", formatSemanticDiff(snapshot.expected, actual));
  }
  return actual;
}

/** Import an explicitly selected offline capture as a review-only candidate. */
export async function recordRecordedSessionSnapshot(
  options: RecordRecordedSessionOptions,
): Promise<{ readonly candidateDirectory: string; readonly result: RecordedSessionResult }> {
  if (options.write !== true) {
    throw new RecordedSessionSnapshotError("snapshot_write_required", "Record requires explicit --write");
  }
  const caseSegments = validateSnapshotCaseId(options.caseId);
  const source = await readBoundedRegularFile(options.sourceFile, MAX_RECORDED_SESSION_FILE_BYTES);
  const rawCapture = parseJson(source.text, "capture");
  assertRecordedSessionRedacted(rawCapture);
  const capture = parseWithSchema(RecordedSessionCaptureSchema, rawCapture, "capture");
  const content = await createSnapshotContent(options.caseId, capture);
  const directory = await candidateDirectory(options.snapshotsRoot, caseSegments, true);
  await mkdir(directory, { recursive: false }).catch((error: unknown) => {
    if (isCode(error, "EEXIST")) {
      throw new RecordedSessionSnapshotError("snapshot_case_exists", "Record never overwrites an existing candidate");
    }
    throw error;
  });
  try {
    await writeSnapshotFiles(directory, content.files);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { candidateDirectory: directory, result: content.expected };
}

export async function refreshRecordedSessionSnapshot(
  options: RefreshRecordedSessionOptions,
): Promise<RefreshRecordedSessionResult> {
  const snapshot = await readSnapshot(options.snapshotsRoot, options.caseId);
  const actual = await runRecordedScenario(snapshot.input, snapshot.modelSteps);
  assertRecordedSessionRedacted(actual);
  const diff = formatSemanticDiff(snapshot.expected, actual);
  const changed = !sameJson(snapshot.expected, actual);
  if (changed && options.write === true) {
    const nextText = serializeJson(actual);
    assertRecordedSessionRedacted(nextText);
    await atomicWriteFile(join(snapshot.directory, EXPECTED_FILE), nextText);
  }
  return { changed, diff, written: changed && options.write === true };
}

export function formatSemanticDiff(
  before: RecordedSessionResult,
  after: RecordedSessionResult,
): string {
  const changes: string[] = [];
  if (before.status !== after.status) changes.push(`status: ${before.status} -> ${after.status}`);
  if (before.failure_code !== after.failure_code) changes.push("failure_code changed");
  if (!sameJson(before.outcome, after.outcome)) changes.push("outcome changed (content omitted; inspect expected.json)");
  if (!sameJson(before.events, after.events)) {
    const beforeTypes = before.events.map((event) => event.type).join(", ");
    const afterTypes = after.events.map((event) => event.type).join(", ");
    changes.push(`ordered event types: [${beforeTypes}] -> [${afterTypes}]`);
    if (sameJson(before.events.map((event) => event.type), after.events.map((event) => event.type))) {
      changes.push("event summaries changed (text omitted; inspect expected.json)");
    }
  }
  for (const phase of ["before", "after"] as const) {
    if (!sameJson(before.workspace[phase], after.workspace[phase])) {
      changes.push(`workspace ${phase} manifest changed: ${workspaceEntryDiff(before.workspace[phase], after.workspace[phase])}`);
    }
  }
  return changes.length === 0 ? "Snapshot semantics match." : `Snapshot semantic diff:\n- ${changes.join("\n- ")}`;
}

function workspaceEntryDiff(
  before: RecordedSessionResult["workspace"]["before"],
  after: RecordedSessionResult["workspace"]["after"],
): string {
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const next = new Map(after.map((entry) => [entry.path, entry]));
  const changed = [...new Set([...previous.keys(), ...next.keys()])]
    .filter((path) => !sameJson(previous.get(path), next.get(path)))
    .sort();
  return changed.length === 0 ? "entry ordering or metadata changed" : changed.slice(0, 16).join(", ");
}

async function createSnapshotContent(caseId: string, capture: RecordedSessionCapture) {
  const input = RecordedSessionInputSchema.parse({
    schema_version: "tracegraph.recorded-session.input.v1",
    scenario_id: capture.scenario_id,
    workspace_fixture: capture.workspace_fixture,
    task: capture.task,
  });
  const modelStep = RecordedModelStepSchema.parse({ kind: "response", value: capture.model_response });
  const manifest = RecordedSessionManifestSchema.parse({
    schema_version: "tracegraph.recorded-session.snapshot.v1",
    case_id: caseId,
    scenario_id: capture.scenario_id,
    format_version: 1,
    source_kind: "offline-capture-import",
    input_file: INPUT_FILE,
    model_stream_file: MODEL_STREAM_FILE,
    expected_file: EXPECTED_FILE,
  });
  const expected = await runRecordedScenario(input, [modelStep]);
  assertRecordedSessionRedacted({ manifest, input, modelStep, expected });
  const files = {
    "snapshot.json": serializeJson(manifest),
    [INPUT_FILE]: serializeJson(input),
    [MODEL_STREAM_FILE]: `${JSON.stringify(modelStep)}\n`,
    [EXPECTED_FILE]: serializeJson(expected),
    "REDACTION.md": REDACTION_CANDIDATE,
  } as const;
  assertFixtureTextRedacted(files);
  return { expected, files };
}

async function readSnapshot(root: string, caseId: string): Promise<SnapshotContents> {
  const segments = validateSnapshotCaseId(caseId);
  const directory = await safeDirectory(root, segments, false);
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (!sameJson(names, [...SNAPSHOT_FILES].sort()) || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new RecordedSessionSnapshotError("snapshot_layout_invalid", "Snapshot directory has missing, unexpected, or non-regular files");
  }

  const fileTexts = {} as Record<(typeof SNAPSHOT_FILES)[number], string>;
  let totalBytes = 0;
  for (const name of SNAPSHOT_FILES) {
    const loaded = await readBoundedRegularFile(join(directory, name), MAX_RECORDED_SESSION_FILE_BYTES);
    fileTexts[name] = loaded.text;
    totalBytes += loaded.bytes;
  }
  if (totalBytes > MAX_RECORDED_SESSION_TOTAL_BYTES) {
    throw new RecordedSessionSnapshotError("snapshot_too_large", "Snapshot exceeds the total size limit");
  }
  assertFixtureTextRedacted(fileTexts);

  const manifest = parseWithSchema(RecordedSessionManifestSchema, parseJson(fileTexts["snapshot.json"], "manifest"), "manifest");
  if (manifest.case_id !== caseId) throw new RecordedSessionSnapshotError("snapshot_case_id_mismatch", "Manifest case id does not match its directory");
  const input = parseWithSchema(RecordedSessionInputSchema, parseJson(fileTexts[INPUT_FILE], "input"), "input");
  if (input.scenario_id !== manifest.scenario_id) throw new RecordedSessionSnapshotError("snapshot_scenario_mismatch", "Input scenario does not match manifest");
  const expected = parseWithSchema(RecordedSessionResultSchema, parseJson(fileTexts[EXPECTED_FILE], "expected output"), "expected output");
  const modelSteps = parseModelStream(fileTexts[MODEL_STREAM_FILE]);
  assertRecordedSessionRedacted({ manifest, input, modelSteps, expected });
  if (modelSteps.length === 0 || modelSteps.length > MAX_RECORDED_MODEL_STEPS || modelSteps.length > MAX_MOCK_PROVIDER_STEPS) {
    throw new RecordedSessionSnapshotError("snapshot_model_script_invalid", "Recorded model script is empty or exceeds its step limit");
  }
  validateRecordedScenario(input, modelSteps);
  return { directory, manifest, input, modelSteps, expected, files: fileTexts };
}

function parseModelStream(text: string): ReturnType<typeof RecordedModelStepSchema.parse>[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length > MAX_RECORDED_MODEL_STEPS) {
    throw new RecordedSessionSnapshotError("snapshot_model_script_invalid", "Recorded model script exceeds its step limit");
  }
  const rawSteps = lines.map((line) => parseJson(line, "model stream"));
  assertRecordedSessionRedacted(rawSteps);
  return rawSteps.map((step) => parseWithSchema(RecordedModelStepSchema, step, "model stream"));
}

async function runRecordedScenario(
  input: RecordedSessionInput,
  steps: readonly ReturnType<typeof RecordedModelStepSchema.parse>[],
): Promise<RecordedSessionResult> {
  validateRecordedScenario(input, steps);
  const fixture = await createFailingTypescriptFixture("snapshot-failing-typescript");
  const data = await createTemporaryDataDir();
  let tick = 0;
  const startTime = Date.parse("2026-01-01T00:00:00.000Z");
  const now = () => new Date(startTime + tick++ * 5);
  const idFactory = createSequentialIdFactory();
  const runtimes: Array<Awaited<ReturnType<typeof createAgentRuntime>>> = [];
  const provider = new ScriptedMockProvider({ decisions: steps.map(toMockProviderStep) });
  const sessionRoot = join(data.path, "sessions");
  const sessionStore = input.scenario_id === "recovery"
    ? new JsonlSessionStore(sessionRoot, {
      now,
      pid: 2_147_483_646,
      staleLeaseTimeoutMs: 120_000,
      heartbeatIntervalMs: 60_000,
    })
    : undefined;
  try {
    let runtime = await createScenarioRuntime({
      dataDir: data.path,
      ...(sessionStore === undefined ? {} : { sessionStore }),
      model: provider,
      idFactory,
      now,
      input,
    });
    runtimes.push(runtime);
    const before = await snapshotWorkspace(fixture.handle.real_root);
    if (input.scenario_id === "memory-recall") {
      const scope = { allowedScopeIds: [fixture.handle.project_id] };
      const memory = await runtime.createMemoryCandidate({
        command_id: "command:snapshot-memory-create",
        kind: "fact",
        claim: "The synthetic TraceGraph fixture uses reviewed V2 Memory recall.",
        normalized_key: "synthetic tracegraph reviewed v2 memory recall",
        project_id: fixture.handle.project_id,
        allow_model_use: true,
      }, scope);
      await runtime.reviewMemory(memory.record.memoryId, {
        command_id: "command:snapshot-memory-activate",
        expected_sequence: 0,
        action: "review_activate",
      }, scope);
    }
    const started = await runtime.startRun({
      command_id: "command:snapshot-start",
      project_id: fixture.handle.project_id,
      task: input.task,
      mode: "execute",
      workspace: fixture.handle,
    });

    let projection;
    if (input.scenario_id === "recovery") {
      await waitForStableStatus(runtime, started.run_id, "awaiting_approval");
      runtime = await createScenarioRuntime({
        dataDir: data.path,
        sessionStore: new JsonlSessionStore(sessionRoot, {
          now,
          staleLeaseTimeoutMs: 120_000,
          heartbeatIntervalMs: 60_000,
        }),
        model: provider,
        idFactory,
        now,
        input,
      });
      runtimes.push(runtime);
      await runtime.markRunInterrupted({
        sessionId: started.session_id!,
        runId: started.run_id,
        projectId: started.project_id,
        reason: "snapshot_host_restart",
      });
      projection = await runtime.resumeRun({
        sessionId: started.session_id!,
        runId: started.run_id,
        projectId: started.project_id,
        commandId: "command:snapshot-resume",
        workspace: fixture.handle,
      });
      const approval = projection.pending_approval;
      if (approval === undefined) {
        throw new RecordedSessionSnapshotError("snapshot_recovery_failed", "Recovered approval is unavailable");
      }
      await runtime.approve({
        type: "approve",
        command_id: "command:snapshot-approve",
        project_id: started.project_id,
        run_id: started.run_id,
        approval_id: approval.approval_id,
        action_id: approval.action_id,
      });
      projection = await waitForStatus(runtime, started.run_id, (status) => status === "completed");
    } else if (input.scenario_id === "cancel") {
      await waitForProviderCalls(provider, 1);
      await runtime.submitUserInput({
        type: "submit_user_input",
        command_id: "command:snapshot-cancel",
        input_id: "input:snapshot-cancel",
        project_id: started.project_id,
        run_id: started.run_id,
        kind: "cancel",
        body: "Cancel the synthetic recorded run.",
        actor: "user",
      });
      projection = await waitForStatus(runtime, started.run_id, (status) => status === "cancelled");
    } else {
      projection = await waitForStatus(runtime, started.run_id, (status) => (
        status === "completed" || status === "failed" || status === "cancelled"
      ));
    }

    const after = await snapshotWorkspace(fixture.handle.real_root);
    const result = RecordedSessionResultSchema.parse({
      schema_version: "tracegraph.recorded-session.result.v2",
      status: projection.status,
      outcome: projection.outcome ?? null,
      failure_code: projection.failure_code ?? null,
      events: projection.timeline.map((event) => ({ type: event.type, summary: event.summary ?? "" })),
      workspace: { before, after },
    });
    assertRecordedSessionRedacted(result);
    return result;
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.shutdownBackgroundWork?.()));
    await Promise.all([fixture.cleanup(), data.cleanup()]);
  }
}

function validateRecordedScenario(
  input: RecordedSessionInput,
  steps: readonly RecordedModelStep[],
): void {
  const first = steps[0];
  const firstDecision = first?.kind === "response" ? first.value : undefined;
  const finishAt = (index: number) => steps[index]?.kind === "response"
    && steps[index].value.kind === "finish";
  const supported = (() => {
    switch (input.scenario_id) {
      case "minimal-completion":
      case "memory-recall":
        return steps.length === 1 && finishAt(0);
      case "recovery":
        return steps.length === 2
          && firstDecision?.kind === "tool_call"
          && firstDecision.tool_call?.tool_name === "preview_patch"
          && finishAt(1);
      case "cancel":
        return steps.length === 1 && first?.kind === "timeout";
      case "subagent":
        return steps.length === 3
          && firstDecision?.kind === "tool_call"
          && firstDecision.tool_call?.tool_name === "spawn_subagent"
          && finishAt(1)
          && finishAt(2);
    }
  })();
  if (!supported) {
    throw new RecordedSessionSnapshotError(
      "snapshot_scenario_unsupported",
      `Model script does not match the bounded ${input.scenario_id} scenario`,
    );
  }
}

function toMockProviderStep(step: RecordedModelStep): MockProviderStep {
  return step.kind === "timeout"
    ? { kind: "timeout", timeoutMs: step.timeout_ms }
    : { kind: "response", value: step.value };
}

async function createScenarioRuntime(options: {
  readonly dataDir: string;
  readonly sessionStore?: InstanceType<typeof JsonlSessionStore>;
  readonly model: ScriptedMockProvider;
  readonly idFactory: (prefix: string) => string;
  readonly now: () => Date;
  readonly input: RecordedSessionInput;
}) {
  const base = {
    dataDir: options.dataDir,
    ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
    model: options.model,
    idFactory: options.idFactory,
    now: options.now,
    sandboxMode: "danger-full-access" as const,
    sandboxRunner: createFixtureSandboxRunner(),
    maxTurns: 4,
  };
  if (options.input.scenario_id === "memory-recall") {
    return createAgentRuntime({
      ...base,
      memoryControlOwnerId: "owner:snapshot-fixture",
      v2MemoryRecallEnabled: true,
    });
  }
  if (options.input.scenario_id === "subagent") {
    return createAgentRuntime({
      ...base,
      subagentRegistry: SubagentRegistry.withReadonlyDefault(options.model),
      maxParallelSubagents: 1,
      maxSubagentDepth: 1,
    });
  }
  return createAgentRuntime(base);
}

async function waitForProviderCalls(provider: ScriptedMockProvider, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (provider.calls().filter((call) => call.channel === "decision").length >= count) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new RecordedSessionSnapshotError("snapshot_model_timeout", "Recorded provider did not consume the expected script step");
}

async function snapshotWorkspace(root: string): Promise<RecordedSessionWorkspaceEntry[]> {
  const entries: RecordedSessionWorkspaceEntry[] = [];
  let totalBytes = 0;
  const walk = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = relativeDirectory.length === 0
      ? root
      : join(root, ...relativeDirectory.split("/"));
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => compareStableText(left.name, right.name));
    for (const child of children) {
      const path = relativeDirectory.length === 0 ? child.name : `${relativeDirectory}/${child.name}`;
      if (child.isSymbolicLink()) {
        throw new RecordedSessionSnapshotError("snapshot_workspace_unsafe", "Workspace fixture contains a symbolic link");
      }
      if (child.isDirectory()) {
        entries.push({ path, kind: "directory", content_hash: null });
        if (entries.length > MAX_RECORDED_WORKSPACE_ENTRIES) {
          throw new RecordedSessionSnapshotError("snapshot_workspace_too_large", "Workspace fixture exceeds its entry limit");
        }
        await walk(path);
        continue;
      }
      if (!child.isFile()) {
        throw new RecordedSessionSnapshotError("snapshot_workspace_unsafe", "Workspace fixture contains a non-file entry");
      }
      const absolutePath = join(root, ...path.split("/"));
      const file = await lstat(absolutePath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_RECORDED_WORKSPACE_FILE_BYTES) {
        throw new RecordedSessionSnapshotError("snapshot_workspace_too_large", "Workspace fixture contains an unsafe or oversized file");
      }
      totalBytes += file.size;
      if (totalBytes > MAX_RECORDED_WORKSPACE_TOTAL_BYTES) {
        throw new RecordedSessionSnapshotError("snapshot_workspace_too_large", "Workspace fixture exceeds its byte limit");
      }
      const content = await readFile(absolutePath);
      entries.push({ path, kind: "file", content_hash: sha256(content) });
      if (entries.length > MAX_RECORDED_WORKSPACE_ENTRIES) {
        throw new RecordedSessionSnapshotError("snapshot_workspace_too_large", "Workspace fixture exceeds its entry limit");
      }
    }
  };
  await walk("");
  entries.sort((left, right) => compareStableText(left.path, right.path));
  return entries;
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function waitForStatus(
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
  runId: string,
  matches: (status: string) => boolean,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (matches(projection.status)) return projection;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new RecordedSessionSnapshotError("snapshot_run_timeout", "Recorded snapshot run did not reach the expected state");
}

async function waitForStableStatus(
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
  runId: string,
  expectedStatus: string,
) {
  const deadline = Date.now() + 10_000;
  let previousSignature: string | undefined;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status !== expectedStatus) {
      previousSignature = undefined;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      continue;
    }
    const signature = `${projection.status}:${projection.timeline.length}:${projection.timeline.at(-1)?.event_id ?? ""}`;
    if (signature === previousSignature) return projection;
    previousSignature = signature;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new RecordedSessionSnapshotError("snapshot_run_timeout", "Recorded snapshot state did not become stable");
}

async function candidateDirectory(root: string, caseSegments: readonly string[], create: boolean): Promise<string> {
  const parent = await safeDirectory(root, ["candidates", ...caseSegments.slice(0, 1)], create);
  const target = join(parent, caseSegments[1]!);
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new RecordedSessionSnapshotError("snapshot_path_unsafe", "Candidate path is not a regular directory");
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  return target;
}

async function safeDirectory(root: string, segments: readonly string[], create: boolean): Promise<string> {
  if (isAbsolute(root) === false) {
    throw new RecordedSessionSnapshotError("snapshot_root_invalid", "Snapshot root must be an absolute path");
  }
  if (create) await mkdir(root, { recursive: true });
  let canonicalRoot: string;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new Error("not_directory");
    canonicalRoot = await realpath(root);
  } catch {
    throw new RecordedSessionSnapshotError("snapshot_root_missing", "Snapshot root does not exist or is not a directory");
  }
  let current = canonicalRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const currentStat = await lstat(current);
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        throw new RecordedSessionSnapshotError("snapshot_path_unsafe", "Snapshot path contains a non-directory or symbolic link");
      }
    } catch (error) {
      if (!isCode(error, "ENOENT") || !create) throw error;
      await mkdir(current, { recursive: false });
    }
  }
  const fromRoot = relative(canonicalRoot, current);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new RecordedSessionSnapshotError("snapshot_path_unsafe", "Snapshot path escapes the configured root");
  }
  return current;
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<{ text: string; bytes: number }> {
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new RecordedSessionSnapshotError("snapshot_file_unsafe", "Snapshot input must be a regular file");
    }
    if (fileStat.size > maxBytes) throw new RecordedSessionSnapshotError("snapshot_file_too_large", "Snapshot file exceeds its size limit");
    const text = await readFile(path, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) throw new RecordedSessionSnapshotError("snapshot_file_too_large", "Snapshot file exceeds its size limit");
    return { text, bytes };
  } catch (error) {
    if (error instanceof RecordedSessionSnapshotError) throw error;
    throw new RecordedSessionSnapshotError("snapshot_file_unreadable", "Snapshot file could not be read");
  }
}

async function writeSnapshotFiles(directory: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const name of SNAPSHOT_FILES) {
    const text = files[name];
    if (text === undefined) throw new RecordedSessionSnapshotError("snapshot_layout_invalid", "Snapshot writer omitted a required file");
    await writeFile(join(directory, name), text, { encoding: "utf8", flag: "wx", mode: 0o644 });
  }
}

async function atomicWriteFile(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${EXPECTED_FILE}.refresh-${randomUUID()}`);
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RecordedSessionSnapshotError("snapshot_json_invalid", `${label} is not valid JSON`);
  }
}

function parseWithSchema<T>(schema: { parse(value: unknown): T }, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch {
    throw new RecordedSessionSnapshotError("snapshot_schema_invalid", `${label} does not match the strict snapshot schema`);
  }
}

function assertFixtureTextRedacted(files: Readonly<Record<string, string>>): void {
  let totalBytes = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_RECORDED_SESSION_FILE_BYTES) throw new RecordedSessionSnapshotError("snapshot_file_too_large", `${name} exceeds its size limit`);
    totalBytes += bytes;
    assertRecordedSessionRedacted(text);
  }
  if (totalBytes > MAX_RECORDED_SESSION_TOTAL_BYTES) {
    throw new RecordedSessionSnapshotError("snapshot_too_large", "Snapshot exceeds the total size limit");
  }
}

function containsSensitiveString(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    || PERSONAL_ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(value))
    || URL_CREDENTIAL_PATTERN.test(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const SENSITIVE_FIELD_PATTERN = /(?:^|[_-])(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|password|secret|credential|private[_-]?key|cookie)(?:$|[_-])/iu;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/u,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];
const PERSONAL_ABSOLUTE_PATH_PATTERNS = [
  /\/Users\/[^/\s"'`]+/u,
  /\/home\/[^/\s"'`]+/u,
  /[A-Z]:\\Users\\[^\\\s]+/iu,
];
const URL_CREDENTIAL_PATTERN = /[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|signature)=([^&#\s]+)/iu;

const REDACTION_CANDIDATE = `# Redaction review\n\n- Source: explicitly selected offline capture JSON.\n- Automated gate: strict schema, size bound, credential-field/token scan, and personal absolute-path scan.\n- Promotion: this directory is a candidate under \`snapshots/candidates/\`; review content, license, and semantic anchors before moving it into the replay suite.\n`;
