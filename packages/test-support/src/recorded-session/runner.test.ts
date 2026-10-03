import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  recordRecordedSessionSnapshot,
  refreshRecordedSessionSnapshot,
  replayRecordedSessionSnapshot,
} from "./runner.js";
import { MAX_RECORDED_SESSION_FILE_BYTES } from "./schema.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "../../../../");
const ACCEPTED_CASE = join(REPOSITORY_ROOT, "snapshots/runtime/minimal-completion");
const ACCEPTED_CASES = [
  "runtime/recovery",
  "runtime/cancel",
  "memory/memory-recall",
  "runtime/subagent",
] as const;
const COMPILED_CLI = join(REPOSITORY_ROOT, "packages/test-support/dist/recorded-session/cli.js");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("recorded-session snapshot harness", () => {
  it("replays the accepted case in a credential-free child process without changing files", async () => {
    const before = await readTree(ACCEPTED_CASE);
    const child = spawnSync(process.execPath, [COMPILED_CLI, "replay", "--case", "runtime/minimal-completion"], {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: "C",
        LC_ALL: "C",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toMatch(/Replayed runtime\/minimal-completion: completed;/u);
    expect(await readTree(ACCEPTED_CASE)).toEqual(before);
  }, 40_000);

  it.each(ACCEPTED_CASES)("replays %s with event and workspace outcome assertions", async (caseId) => {
    const result = await replayRecordedSessionSnapshot({
      snapshotsRoot: join(REPOSITORY_ROOT, "snapshots"),
      caseId,
    });
    const eventTypes = result.events.map(({ type }) => type);
    if (caseId === "runtime/recovery") {
      expect(result.status).toBe("completed");
      expect(eventTypes).toContain("run.interrupted");
      expect(eventTypes).toContain("run.resumed");
      expect(eventTypes.filter((type) => type === "approval.requested")).toHaveLength(2);
      expect(eventTypes).toContain("patch.applied");
      expect(eventTypes).toContain("run.completed");
      const beforeSource = result.workspace.before.find(({ path }) => path === "src/add.ts");
      const afterSource = result.workspace.after.find(({ path }) => path === "src/add.ts");
      expect(afterSource?.content_hash).not.toBe(beforeSource?.content_hash);
    } else if (caseId === "runtime/cancel") {
      expect(result.status).toBe("cancelled");
      expect(eventTypes).toContain("user.input_queued");
      expect(eventTypes).toContain("user.input_consumed");
      expect(eventTypes).toContain("run.cancelled");
      expect(eventTypes).not.toContain("tool.started");
      expect(result.workspace.after).toEqual(result.workspace.before);
    } else if (caseId === "memory/memory-recall") {
      expect(result.status).toBe("completed");
      expect(result.events.filter(({ type }) => type === "memory.use_status")).toHaveLength(3);
      expect(result.workspace.after).toEqual(result.workspace.before);
    } else {
      expect(result.status).toBe("completed");
      expect(eventTypes).toContain("subagent.started");
      expect(eventTypes).toContain("subagent.completed");
      expect(result.workspace.after).toEqual(result.workspace.before);
    }
  }, 40_000);

  it("rejects missing or unknown modes before creating the requested snapshot root", async () => {
    const root = await temporaryDirectory("snapshot-cli-mode-");
    for (const argv of [[], ["unknown"], ["replay", "--case", "runtime/minimal-completion"], ["record", "--case", "runtime/minimal-completion"]]) {
      const child = spawnSync(process.execPath, [COMPILED_CLI, ...argv, "--root", root], {
        cwd: REPOSITORY_ROOT,
        env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.status).not.toBe(0);
    }
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("requires explicit writes, rejects sensitive captures, and never replaces a candidate", async () => {
    const root = await temporaryDirectory("snapshot-record-");
    const source = join(root, "capture.json");
    await writeFile(source, JSON.stringify(validCapture()), "utf8");

    await expect(recordRecordedSessionSnapshot({
      snapshotsRoot: join(root, "snapshots"),
      caseId: "runtime/recorded-case",
      sourceFile: source,
      write: false,
    })).rejects.toMatchObject({ code: "snapshot_write_required" });

    await writeFile(source, JSON.stringify({ ...validCapture(), api_key: "should-never-be-written" }), "utf8");
    await expect(recordRecordedSessionSnapshot({
      snapshotsRoot: join(root, "snapshots"),
      caseId: "runtime/unsafe-case",
      sourceFile: source,
      write: true,
    })).rejects.toMatchObject({ code: "snapshot_redaction_failed" });

    await writeFile(source, JSON.stringify(validCapture("Inspect /Users/alice/private-project safely.")), "utf8");
    await expect(recordRecordedSessionSnapshot({
      snapshotsRoot: join(root, "snapshots"),
      caseId: "runtime/path-case",
      sourceFile: source,
      write: true,
    })).rejects.toMatchObject({ code: "snapshot_redaction_failed" });

    await writeFile(source, "x".repeat(MAX_RECORDED_SESSION_FILE_BYTES + 1), "utf8");
    await expect(recordRecordedSessionSnapshot({
      snapshotsRoot: join(root, "snapshots"),
      caseId: "runtime/oversized-case",
      sourceFile: source,
      write: true,
    })).rejects.toMatchObject({ code: "snapshot_file_too_large" });

    await writeFile(source, JSON.stringify(validCapture("Review the fixture task.")), "utf8");
    const recorded = await recordRecordedSessionSnapshot({
      snapshotsRoot: join(root, "snapshots"),
      caseId: "runtime/recorded-case",
      sourceFile: source,
      write: true,
    });
    expect(recorded.result.status).toBe("completed");
    await expect(recordRecordedSessionSnapshot({
      snapshotsRoot: join(root, "snapshots"),
      caseId: "runtime/recorded-case",
      sourceFile: source,
      write: true,
    })).rejects.toMatchObject({ code: "snapshot_case_exists" });
    await expect(readFile(join(root, "snapshots/candidates/runtime/recorded-case/expected.json"), "utf8")).resolves.toContain('"status": "completed"');
  }, 40_000);

  it("refreshes only expected output when explicitly requested", async () => {
    const root = await temporaryDirectory("snapshot-refresh-");
    const caseDirectory = join(root, "runtime/minimal-completion");
    await mkdir(dirname(caseDirectory), { recursive: true });
    await cp(ACCEPTED_CASE, caseDirectory, { recursive: true });
    const expectedFile = join(caseDirectory, "expected.json");
    const originalExpected = await readFile(expectedFile, "utf8");
    const originalInput = await readFile(join(caseDirectory, "input.json"), "utf8");
    const originalStream = await readFile(join(caseDirectory, "model-stream.jsonl"), "utf8");
    const altered = JSON.parse(originalExpected) as { events: Array<{ summary: string }> };
    altered.events[0]!.summary = "intentional review-only change";
    await writeFile(expectedFile, `${JSON.stringify(altered, null, 2)}\n`, "utf8");
    const alteredExpected = await readFile(expectedFile, "utf8");

    const dryRun = await refreshRecordedSessionSnapshot({ snapshotsRoot: root, caseId: "runtime/minimal-completion" });
    expect(dryRun.changed).toBe(true);
    expect(dryRun.written).toBe(false);
    expect(await readFile(expectedFile, "utf8")).toBe(alteredExpected);

    const refreshed = await refreshRecordedSessionSnapshot({
      snapshotsRoot: root,
      caseId: "runtime/minimal-completion",
      write: true,
    });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.written).toBe(true);
    expect(await readFile(expectedFile, "utf8")).toBe(originalExpected);
    expect(await readFile(join(caseDirectory, "input.json"), "utf8")).toBe(originalInput);
    expect(await readFile(join(caseDirectory, "model-stream.jsonl"), "utf8")).toBe(originalStream);
  }, 40_000);

  it("reports a workspace manifest drift independently from event drift", async () => {
    const root = await temporaryDirectory("snapshot-workspace-drift-");
    const caseDirectory = join(root, "runtime/minimal-completion");
    await mkdir(dirname(caseDirectory), { recursive: true });
    await cp(ACCEPTED_CASE, caseDirectory, { recursive: true });
    const expectedFile = join(caseDirectory, "expected.json");
    const expected = JSON.parse(await readFile(expectedFile, "utf8")) as {
      workspace: { after: Array<{ path: string; content_hash: string | null }> };
    };
    const target = expected.workspace.after.find((entry) => entry.path === "src/add.ts");
    expect(target).toBeDefined();
    target!.content_hash = `sha256:${"0".repeat(64)}`;
    await writeFile(expectedFile, `${JSON.stringify(expected, null, 2)}\n`, "utf8");

    await expect(replayRecordedSessionSnapshot({
      snapshotsRoot: root,
      caseId: "runtime/minimal-completion",
    })).rejects.toThrow(/workspace after manifest changed: src\/add\.ts/u);
  }, 40_000);

  it("rejects credential-bearing fields from checked-in model streams", async () => {
    const root = await temporaryDirectory("snapshot-redaction-");
    const caseDirectory = join(root, "runtime/minimal-completion");
    await mkdir(dirname(caseDirectory), { recursive: true });
    await cp(ACCEPTED_CASE, caseDirectory, { recursive: true });
    const modelStreamFile = join(caseDirectory, "model-stream.jsonl");
    const parsed = JSON.parse(await readFile(modelStreamFile, "utf8")) as { value: Record<string, unknown> };
    parsed.value.api_key = "synthetic-redaction-test-value";
    await writeFile(modelStreamFile, `${JSON.stringify(parsed)}\n`, "utf8");

    await expect(replayRecordedSessionSnapshot({
      snapshotsRoot: root,
      caseId: "runtime/minimal-completion",
    })).rejects.toMatchObject({ code: "snapshot_redaction_failed" });
  });
});

function validCapture(task = "Complete the synthetic recorded-session task.") {
  return {
    schema_version: "tracegraph.recorded-session.capture.v1",
    scenario_id: "minimal-completion",
    workspace_fixture: "failing-typescript",
    task,
    model_response: {
      decision_id: "decision:snapshot-test",
      kind: "finish",
      public_reason: "This synthetic fixture needs no workspace changes.",
      evidence_refs: [],
      risk: "none",
      final_answer: "The synthetic task is complete.",
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function readTree(root: string): Promise<readonly { path: string; text: string }[]> {
  const names = (await readdir(root)).sort();
  const files = await Promise.all(names.map(async (name) => ({
    path: name,
    text: await readFile(join(root, name), "utf8"),
  })));
  return files;
}
