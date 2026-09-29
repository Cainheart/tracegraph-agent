import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_FORMAT_VERSION,
  SessionEventReferenceSchema,
  SessionHeaderSchema,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionStore, migrateSessionEntry } from "./index.js";

const roots: string[] = [];
const redactTitle = (text: string) => text.replaceAll("private-marker", "[redacted]");
const createdAt = "2026-09-30T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@tracegraph/session public contract", () => {
  it("migrates legacy generations through the package root and rejects future versions", () => {
    expect(migrateSessionEntry({
      kind: "header",
      session_version: 0,
      id: "legacy-session",
      projectId: "project-one",
      createdAt,
      title: "private-marker legacy title",
    }, redactTitle)).toEqual({
      kind: "header",
      session_version: SESSION_FORMAT_VERSION,
      session_id: "legacy-session",
      project_id: "project-one",
      created_at: createdAt,
      title: "[redacted] legacy title",
      run_ids: [],
    });
    expect(() => migrateSessionEntry({ kind: "header", session_version: 2 }, redactTitle))
      .toThrow("Unsupported session format version: 2");
  });

  it("writes current records, then reads them through a fresh package instance", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const store = new JsonlSessionStore(sessionsRoot, { redactSensitiveText: redactTitle });
    const header = SessionHeaderSchema.parse({
      kind: "header",
      session_version: SESSION_FORMAT_VERSION,
      session_id: "session-one",
      project_id: "project-one",
      created_at: createdAt,
      title: "private-marker conversation",
    });
    await store.create(header);
    const lease = await store.acquireLease(header.session_id);
    await store.append(header.session_id, SessionEventReferenceSchema.parse({
      kind: "event_ref",
      session_version: SESSION_FORMAT_VERSION,
      entry_id: "entry-one",
      created_at: createdAt,
      event_ref: { event_id: "event-one", run_id: "run-one", sequence: 1 },
    }), lease);
    await lease.release();

    const restarted = new JsonlSessionStore(sessionsRoot, { redactSensitiveText: redactTitle });
    await expect(restarted.readAll(header.session_id)).resolves.toMatchObject({
      truncated: false,
      header: { session_version: SESSION_FORMAT_VERSION, title: "[redacted] conversation" },
      entries: [{ kind: "event_ref", event_ref: { event_id: "event-one", sequence: 1 } }],
    });
    await expect(restarted.list({ project_id: header.project_id })).resolves.toMatchObject({
      sessions: [{ session_id: header.session_id, project_id: header.project_id, entry_count: 1 }],
    });
    const jsonl = await sessionFile(sessionsRoot);
    expect(await readFile(jsonl, "utf8")).not.toContain("private-marker");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-session-contract-"));
  roots.push(root);
  return root;
}

async function sessionFile(sessionsRoot: string): Promise<string> {
  const projects = await readdir(sessionsRoot, { withFileTypes: true });
  const project = projects.find((entry) => entry.isDirectory());
  if (project === undefined) throw new Error("expected a project session directory");
  const files = await readdir(join(sessionsRoot, project.name));
  const file = files.find((name) => name.endsWith(".jsonl"));
  if (file === undefined) throw new Error("expected a Session JSONL file");
  return join(sessionsRoot, project.name, file);
}
