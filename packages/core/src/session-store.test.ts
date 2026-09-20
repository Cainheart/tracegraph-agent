import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_FORMAT_VERSION,
  SessionEventReferenceSchema,
  SessionHeaderSchema,
  type SessionEventReference,
  type SessionHeader,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonlSessionStore,
  SessionCorruptionError,
  SessionLeaseConflictError,
  SessionPathSafetyError,
  UnsupportedSessionVersionError,
  migrateSessionEntry,
} from "./session-store.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

const roots: string[] = [];
const createdAt = "2026-09-18T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("session format migration", () => {
  it.each([
    {
      name: "header",
      legacy: {
        kind: "header",
        session_version: 0,
        id: "session-v0",
        projectId: "project-v0",
        createdAt,
        title: "Legacy title",
        parentSessionId: "session-parent",
        runIds: ["run-1", "run-2"],
      },
      expected: {
        kind: "header",
        session_version: 1,
        session_id: "session-v0",
        project_id: "project-v0",
        created_at: createdAt,
        title: "Legacy title",
        parent_session_id: "session-parent",
        run_ids: ["run-1", "run-2"],
      },
    },
    {
      name: "event reference",
      legacy: {
        kind: "event",
        session_version: 0,
        id: "entry-v0",
        parentId: "entry-parent",
        createdAt,
        eventId: "event-v0",
        runId: "run-v0",
        sequence: 7,
      },
      expected: {
        kind: "event_ref",
        session_version: 1,
        entry_id: "entry-v0",
        parent_entry_id: "entry-parent",
        created_at: createdAt,
        event_ref: { event_id: "event-v0", run_id: "run-v0", sequence: 7 },
      },
    },
  ])("maps every v0 $name field to v1", ({ legacy, expected }) => {
    expect(migrateSessionEntry(legacy)).toEqual(expected);
  });

  it("rejects missing and unknown versions explicitly", () => {
    expect(() => migrateSessionEntry({ kind: "header" })).toThrow("missing session_version");
    try {
      migrateSessionEntry({ kind: "header", session_version: 2 });
      throw new Error("expected unsupported version");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSessionVersionError);
      expect((error as UnsupportedSessionVersionError).code).toBe("session_version_unsupported");
      expect((error as Error).message).toContain("2");
    }
  });
});

describe("JsonlSessionStore", () => {
  it("stores only a header and ledger event references, and updates run_ids durably", async () => {
    const { root, store } = await temporaryStore();
    const secret = "sk-session-store-abcdefghijklmnop";
    await store.create(header("session-1", "project-1", `First session ${secret}`));
    const lease = await store.acquireLease("session-1");
    await store.append("session-1", eventReference("entry-1", "event-1", "run-1", 1), lease);
    await store.append("session-1", {
      ...eventReference("entry-2", "event-2", "run-1", 2),
      parent_entry_id: "entry-1",
    }, lease);
    await lease.release();

    const result = await store.readAll("session-1");
    expect(result).toMatchObject({ truncated: false, header: { run_ids: ["run-1"] } });
    expect(result.entries).toHaveLength(2);
    const path = await onlySessionFile(root);
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual(["header", "event_ref", "event_ref"]);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).toContain("[REDACTED_API_KEY]");
    expect(JSON.stringify(records)).not.toContain('"event":');
    expect(JSON.stringify(records)).not.toContain('"summary":');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, "sessions"))).mode & 0o777).toBe(0o700);
  });

  it("reports a partial tail on ordinary reads and truncates it only under a live lease", async () => {
    const { root, store } = await temporaryStore();
    await store.create(header("session-tail", "project-1"));
    const path = await onlySessionFile(root);
    await appendFile(path, '{"kind":"event_ref","session_version":1,"entry_id":');

    await expect(store.readAll("session-tail")).resolves.toMatchObject({ truncated: true, entries: [] });
    expect(await readFile(path, "utf8")).toContain('"entry_id":');

    const lease = await store.acquireLease("session-tail");
    await expect(store.readAll("session-tail", lease)).resolves.toMatchObject({ truncated: true });
    await lease.release();
    const repaired = await readFile(path, "utf8");
    expect(repaired.endsWith("\n")).toBe(true);
    expect(repaired).not.toContain('"entry_id":');
    await expect(store.readAll("session-tail")).resolves.toMatchObject({ truncated: false });
  });

  it("does not mistake complete invalid JSON or an invalid schema for a repairable tail", async () => {
    const first = await temporaryStore();
    await first.store.create(header("session-invalid-json", "project-1"));
    const firstPath = await onlySessionFile(first.root);
    await appendFile(firstPath, '{"kind": nope}');
    await expect(first.store.readAll("session-invalid-json")).rejects.toBeInstanceOf(SessionCorruptionError);
    expect(await readFile(firstPath, "utf8")).toContain("nope");

    const second = await temporaryStore();
    await second.store.create(header("session-invalid-schema", "project-1"));
    const secondPath = await onlySessionFile(second.root);
    await appendFile(secondPath, JSON.stringify({
      kind: "event_ref",
      session_version: 1,
      entry_id: "entry-1",
      created_at: createdAt,
      event_ref: { event_id: "event-1", run_id: "run-1", sequence: 1 },
      event: { summary: "forbidden body" },
    }));
    await expect(second.store.readAll("session-invalid-schema")).rejects.toBeInstanceOf(SessionCorruptionError);
  });

  it("loads v0 records through the migration table and rewrites them as v1 on rename", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const projectRoot = join(sessionsRoot, "legacy-project");
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    await chmod(sessionsRoot, 0o700);
    const path = join(projectRoot, "legacy.jsonl");
    await writeFile(path, [
      JSON.stringify({
        kind: "header", session_version: 0, id: "legacy-session", projectId: "project-1",
        createdAt, title: "Old", runIds: ["run-1"],
      }),
      JSON.stringify({
        kind: "event", session_version: 0, id: "entry-1", createdAt,
        eventId: "event-1", runId: "run-1", sequence: 1,
      }),
      "",
    ].join("\n"), { mode: 0o600 });
    await chmod(path, 0o600);
    const store = new JsonlSessionStore(sessionsRoot);

    await expect(store.readAll("legacy-session")).resolves.toMatchObject({
      header: { session_version: 1, session_id: "legacy-session" },
      entries: [{ session_version: 1, kind: "event_ref" }],
    });
    await store.rename("legacy-session", "Migrated");
    expect(await readFile(path, "utf8")).not.toContain('"session_version":0');
  });

  it("fails closed when a file declares an unknown version", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const projectRoot = join(sessionsRoot, "unknown-project");
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    await chmod(sessionsRoot, 0o700);
    const path = join(projectRoot, "unknown.jsonl");
    await writeFile(path, `${JSON.stringify({ kind: "header", session_version: 99 })}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    const store = new JsonlSessionStore(sessionsRoot);

    await expect(store.list()).rejects.toBeInstanceOf(UnsupportedSessionVersionError);
  });

  it("searches, scopes before pagination, renames atomically, and soft-deletes", async () => {
    const { root, store } = await temporaryStore();
    await store.create(header("session-a", "project-visible", "Visible needle"));
    await store.create(header("session-b", "project-hidden", "Hidden needle"));
    await store.create(header("session-c", "project-visible", "Other"));

    await expect(store.list({ q: "needle" })).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ session_id: "session-a" }),
        expect.objectContaining({ session_id: "session-b" }),
      ]),
    });
    const scoped = await store.list({ limit: 1 }, new Set(["project-visible"]));
    expect(scoped.sessions).toHaveLength(1);
    expect(scoped.sessions[0]?.project_id).toBe("project-visible");
    if (scoped.next_cursor !== undefined) {
      const page2 = await store.list(
        { limit: 1, cursor: scoped.next_cursor },
        new Set(["project-visible"]),
      );
      expect(page2.sessions[0]?.project_id).toBe("project-visible");
    }

    await expect(store.rename("session-a", "Renamed session")).resolves.toMatchObject({
      title: "Renamed session",
    });
    expect((await readdir(join(root, "sessions"), { recursive: true })).some((name) => name.endsWith(".tmp"))).toBe(false);
    await store.delete("session-a");
    expect((await store.list()).sessions.some((session) => session.session_id === "session-a")).toBe(false);
    const trashEntries = await readdir(join(root, "sessions-trash"), { recursive: true });
    expect(trashEntries.some((name) => name.endsWith(".deleted.jsonl"))).toBe(true);
  });

  it("hides child Sessions by default and filters roots before cursor pagination", async () => {
    const { store } = await temporaryStore();
    await store.create(header("session-root-a", "project-visible", "Root A"));
    await store.create(header("session-child", "project-visible", "Child", "session-root-a"));
    await store.create(header("session-root-b", "project-visible", "Root B"));

    const rootsOnly = await store.list({ limit: 10 });
    expect(rootsOnly.sessions.map(({ session_id: sessionId }) => sessionId).sort()).toEqual([
      "session-root-a",
      "session-root-b",
    ]);
    const all = await store.list({ view: "all", limit: 10 });
    expect(all.sessions.map(({ session_id: sessionId }) => sessionId)).toHaveLength(3);

    const firstRoot = await store.list({ view: "roots", limit: 1 });
    expect(firstRoot.sessions).toHaveLength(1);
    expect(firstRoot.next_cursor).toBeDefined();
    const secondRoot = await store.list({
      view: "roots",
      limit: 1,
      cursor: firstRoot.next_cursor,
    });
    expect(secondRoot.sessions).toHaveLength(1);
    expect(secondRoot.sessions[0]?.parent_session_id).toBeUndefined();
  });

  it("enforces a single writer lease and refreshes heartbeats automatically", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const first = new JsonlSessionStore(sessionsRoot, {
      staleLeaseTimeoutMs: 150,
      heartbeatIntervalMs: 20,
    });
    const second = new JsonlSessionStore(sessionsRoot, {
      staleLeaseTimeoutMs: 150,
      heartbeatIntervalMs: 20,
    });
    await first.create(header("session-lease", "project-1"));
    const lease = await first.acquireLease("session-lease");
    await expect(second.acquireLease("session-lease")).rejects.toMatchObject({
      code: "session_lease_conflict",
    });
    const lockPath = `${await onlySessionFile(root)}.lock`;
    const before = JSON.parse(await readFile(lockPath, "utf8")) as { heartbeat_at: string };
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = JSON.parse(await readFile(lockPath, "utf8")) as { heartbeat_at: string };
    expect(Date.parse(after.heartbeat_at)).toBeGreaterThan(Date.parse(before.heartbeat_at));
    await lease.release();
  });

  it("rejects a second writer in a separate process without corrupting the file", async () => {
    const { root, store } = await temporaryStore();
    await store.create(header("session-process", "project-1"));
    const lease = await store.acquireLease("session-process");
    const moduleUrl = new URL("./session-store.ts", import.meta.url).href;
    const script = [
      `import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};`,
      `const store = new JsonlSessionStore(${JSON.stringify(join(root, "sessions"))});`,
      "try {",
      "  const lease = await store.acquireLease('session-process');",
      "  await lease.release();",
      "  process.stdout.write('unexpected_success');",
      "} catch (error) {",
      "  process.stdout.write(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown_error');",
      "}",
    ].join("\n");
    const output = await runChild(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
    expect(output).toBe("session_lease_conflict");
    await lease.release();
    await expect(store.readAll("session-process")).resolves.toMatchObject({ truncated: false });
  });

  it("takes over a fresh same-host lease immediately when its pid is dead", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const hostname = "test-host";
    const deadWriter = new JsonlSessionStore(sessionsRoot, {
      pid: 999_999,
      hostname,
      staleLeaseTimeoutMs: 10_000,
      heartbeatIntervalMs: 9_000,
    });
    const survivor = new JsonlSessionStore(sessionsRoot, {
      hostname,
      staleLeaseTimeoutMs: 10_000,
      heartbeatIntervalMs: 9_000,
    });
    await deadWriter.create(header("session-dead-pid", "project-1"));
    const abandoned = await deadWriter.acquireLease("session-dead-pid");
    const recovered = await survivor.acquireLease("session-dead-pid");
    await recovered.release();
    await expect(abandoned.release()).resolves.toBeUndefined();
  });

  it("rejects unsafe roots, session symlinks, and permissive files", async () => {
    const root = await temporaryRoot();
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked);
    await expect(new JsonlSessionStore(linked).initialize()).rejects.toBeInstanceOf(SessionPathSafetyError);

    const safe = await temporaryStore();
    await safe.store.create(header("session-mode", "project-1"));
    const path = await onlySessionFile(safe.root);
    await chmod(path, 0o644);
    await expect(safe.store.list()).rejects.toBeInstanceOf(SessionPathSafetyError);
  });

  it("requires an acquired lease to append and preserves tree integrity", async () => {
    const { store } = await temporaryStore();
    await store.create(header("session-tree", "project-1"));
    const fakeLease = {
      sessionId: "session-tree",
      pid: process.pid,
      hostname: "fake",
      async heartbeat() {},
      async release() {},
    };
    await expect(store.append(
      "session-tree",
      eventReference("entry-1", "event-1", "run-1", 1),
      fakeLease,
    )).rejects.toBeInstanceOf(SessionLeaseConflictError);

    const lease = await store.acquireLease("session-tree");
    await expect(store.append("session-tree", {
      ...eventReference("entry-2", "event-2", "run-1", 2),
      parent_entry_id: "missing",
    }, lease)).rejects.toBeInstanceOf(SessionCorruptionError);
    await lease.release();
  });
});

function header(
  sessionId: string,
  projectId: string,
  title?: string,
  parentSessionId?: string,
): SessionHeader {
  return SessionHeaderSchema.parse({
    kind: "header",
    session_version: SESSION_FORMAT_VERSION,
    session_id: sessionId,
    project_id: projectId,
    created_at: createdAt,
    ...(title === undefined ? {} : { title }),
    ...(parentSessionId === undefined ? {} : { parent_session_id: parentSessionId }),
    run_ids: [],
  });
}

function eventReference(
  entryId: string,
  eventId: string,
  runId: string,
  sequence: number,
): SessionEventReference {
  return SessionEventReferenceSchema.parse({
    kind: "event_ref",
    session_version: SESSION_FORMAT_VERSION,
    entry_id: entryId,
    created_at: createdAt,
    event_ref: { event_id: eventId, run_id: runId, sequence },
  });
}

async function temporaryStore(): Promise<{ root: string; store: JsonlSessionStore }> {
  const root = await temporaryRoot();
  return { root, store: new JsonlSessionStore(join(root, "sessions")) };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-session-store-"));
  roots.push(root);
  return root;
}

async function onlySessionFile(root: string): Promise<string> {
  const sessionsRoot = join(root, "sessions");
  const projectDirectories = (await readdir(sessionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  if (projectDirectories.length !== 1) throw new Error("expected one project directory");
  const projectRoot = join(sessionsRoot, projectDirectories[0]!.name);
  const files = (await readdir(projectRoot))
    .filter((name) => name.endsWith(".jsonl"));
  if (files.length !== 1) throw new Error("expected one session file");
  return join(projectRoot, files[0]!);
}

async function runChild(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`child exited ${String(code)}: ${stderr}`));
    });
  });
}
