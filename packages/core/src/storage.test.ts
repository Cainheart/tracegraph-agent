import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextManifestSchema,
  type SessionEventProposal,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { JsonlEventLedger, LedgerCorruptionError } from "./event-ledger.js";
import { registerSecretForRedaction } from "./crypto.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("durable evidence stores", () => {
  it("rejects a partial trailing ledger record", async () => {
    const root = await temporaryRoot();
    const ledger = ledgerAt(root);
    await ledger.append(proposal("run.created"));
    const path = join(root, "events", "run_test.jsonl");
    await writeFile(path, '{"partial":', { flag: "a" });

    await expect(ledger.list("run:test")).rejects.toBeInstanceOf(LedgerCorruptionError);
  });

  it("detects event mutation through the hash chain", async () => {
    const root = await temporaryRoot();
    const ledger = ledgerAt(root);
    await ledger.append(proposal("run.created"));
    const path = join(root, "events", "run_test.jsonl");
    const event = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    event.summary = "tampered after commit";
    await writeFile(path, `${JSON.stringify(event)}\n`);

    await expect(ledger.list("run:test")).rejects.toThrow("event hash mismatch");
  });

  it("keeps a committed event successful when an SSE subscriber throws", async () => {
    const root = await temporaryRoot();
    const ledger = ledgerAt(root);
    ledger.subscribe(() => {
      throw new Error("broken subscriber");
    });

    const committed = await ledger.append(proposal("run.created"));

    expect(committed.sequence).toBe(1);
    await expect(ledger.list("run:test")).resolves.toEqual([committed]);
  });

  it("commits an atomic Event tail only after finalize and durable replace both succeed", async () => {
    const root = await temporaryRoot();
    const seeded = ledgerAt(root);
    await seeded.append(proposal("run.created"));

    await expect(seeded.appendAtomic(
      { project_id: "project:test", run_id: "run:test" },
      [{ ...proposal("run.started"), idempotency_key: "atomic:finalize:item" }],
      () => { throw new Error("injected finalize failure"); },
    )).rejects.toThrow("injected finalize failure");
    expect(await seeded.list("run:test")).toHaveLength(1);

    let notifications = 0;
    const replaceFailure = new JsonlEventLedger(join(root, "events"), {
      idFactory: () => "event:replace-failure",
      now: () => new Date("2026-09-16T00:00:01.000Z"),
      replaceDurably: async () => { throw new Error("injected durable replace failure"); },
    });
    replaceFailure.subscribe(() => { notifications += 1; });
    await expect(replaceFailure.appendAtomic(
      { project_id: "project:test", run_id: "run:test" },
      [{ ...proposal("run.started"), idempotency_key: "atomic:replace:item" }],
      () => ({ ...proposal("run.started"), idempotency_key: "atomic:replace:receipt" }),
    )).rejects.toThrow("injected durable replace failure");
    expect(await seeded.list("run:test")).toHaveLength(1);
    expect(notifications).toBe(0);
  });

  it("serializes terminal Events against atomic batches without exposing a partial tail", async () => {
    const atomicFirstRoot = await temporaryRoot();
    const atomicFirst = ledgerAt(atomicFirstRoot);
    await atomicFirst.append(proposal("run.created"));
    const atomicFirstResults = await Promise.allSettled([
      atomicFirst.appendAtomic(
        { project_id: "project:test", run_id: "run:test" },
        [
          { ...proposal("run.started"), idempotency_key: "atomic:first:one" },
          { ...proposal("run.started"), idempotency_key: "atomic:first:two" },
        ],
      ),
      atomicFirst.append({ ...proposal("run.completed"), idempotency_key: "terminal:after" }),
    ]);
    expect(atomicFirstResults.every(({ status }) => status === "fulfilled")).toBe(true);
    expect((await atomicFirst.list("run:test")).map(({ type }) => type)).toEqual([
      "run.created",
      "run.started",
      "run.started",
      "run.completed",
    ]);

    const terminalFirstRoot = await temporaryRoot();
    const terminalFirst = ledgerAt(terminalFirstRoot);
    await terminalFirst.append(proposal("run.created"));
    const terminalFirstResults = await Promise.allSettled([
      terminalFirst.append({ ...proposal("run.completed"), idempotency_key: "terminal:first" }),
      terminalFirst.appendAtomic(
        { project_id: "project:test", run_id: "run:test" },
        [
          { ...proposal("run.started"), idempotency_key: "atomic:blocked:one" },
          { ...proposal("run.started"), idempotency_key: "atomic:blocked:two" },
        ],
      ),
    ]);
    expect(terminalFirstResults.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect((await terminalFirst.list("run:test")).map(({ type }) => type)).toEqual([
      "run.created",
      "run.completed",
    ]);
  });

  it("applies the registered-secret guard at the final ledger write boundary", async () => {
    const root = await temporaryRoot();
    const ledger = ledgerAt(root);
    const secret = "ledger-opaque-value.12345";
    registerSecretForRedaction(secret);

    await ledger.append({
      ...proposal("run.created"),
      summary: `starting with ${secret}`,
      data: { task: `use ${secret}`, mode: "plan", workspace_kind: "readonly_local" },
    });

    const persisted = await readFile(join(root, "events", "run_test.jsonl"), "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED_REGISTERED_SECRET]");
  });

  it("redacts secrets and reports content corruption explicitly", async () => {
    const root = await temporaryRoot();
    const store = new ArtifactStore(join(root, "artifacts"), {
      idFactory: () => "artifact:test",
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });
    const ref = await store.put({
      projectId: "project:test",
      runId: "run:test",
      kind: "tool_output",
      mimeType: "text/plain",
      content: "token=do-not-persist-this-value cwd=/Users/cain/private/repository",
    });
    const available = await store.get({
      artifactId: ref.artifact_id,
      projectId: "project:test",
      runId: "run:test",
    });
    expect(available).toMatchObject({ status: "available" });
    expect(JSON.stringify(available)).not.toContain("do-not-persist-this-value");
    expect(JSON.stringify(available)).not.toContain("/Users/cain/private/repository");
    expect((await lstat(join(root, "artifacts"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "artifacts", "artifact_test.data"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, "artifacts", "artifact_test.json"))).mode & 0o777).toBe(0o600);

    await writeFile(join(root, "artifacts", "artifact_test.data"), "tampered");
    await expect(store.get({
      artifactId: ref.artifact_id,
      projectId: "project:test",
      runId: "run:test",
    })).resolves.toMatchObject({ status: "corrupt", expected_hash: ref.content_hash });
  });

  it("rejects a symbolic-link Artifact root before storing recovery context", async () => {
    const root = await temporaryRoot();
    const realRoot = join(root, "real-artifacts");
    const linkedRoot = join(root, "linked-artifacts");
    await mkdir(realRoot, { mode: 0o700 });
    await symlink(realRoot, linkedRoot);

    await expect(new ArtifactStore(linkedRoot).initialize())
      .rejects.toThrow("Artifact root must be a real directory");
  });

  it("blocks unsupported MIME types and oversized wire artifacts", async () => {
    const root = await temporaryRoot();
    let sequence = 0;
    const store = new ArtifactStore(join(root, "artifacts"), {
      idFactory: () => `artifact:${++sequence}`,
      maxWireBytes: 4,
      maxInternalBytes: 8,
    });
    const unsupported = await store.put({
      projectId: "project:test",
      runId: "run:test",
      kind: "tool_output",
      mimeType: "application/octet-stream",
      content: "abc",
    });
    const oversized = await store.put({
      projectId: "project:test",
      runId: "run:test",
      kind: "tool_output",
      mimeType: "text/plain",
      content: "abcde",
    });
    const internallyOversized = await store.put({
      projectId: "project:test",
      runId: "run:test",
      kind: "recovery_state",
      mimeType: "application/json",
      content: JSON.stringify({ value: "123456789" }),
    });

    await expect(store.get({
      artifactId: unsupported.artifact_id,
      projectId: "project:test",
      runId: "run:test",
    })).resolves.toMatchObject({ status: "unavailable", reason: "unsupported_mime" });
    await expect(store.get({
      artifactId: oversized.artifact_id,
      projectId: "project:test",
      runId: "run:test",
    })).resolves.toMatchObject({ status: "unavailable", reason: "too_large" });
    await expect(store.getInternal({
      artifactId: oversized.artifact_id,
      projectId: "project:test",
      runId: "run:test",
    })).resolves.toMatchObject({ status: "available" });
    await expect(store.getInternal({
      artifactId: internallyOversized.artifact_id,
      projectId: "project:test",
      runId: "run:test",
    })).resolves.toMatchObject({ status: "unavailable", reason: "too_large" });
  });

  it("round-trips a complete redacted ContextManifest as valid JSON", async () => {
    const root = await temporaryRoot();
    const store = new ArtifactStore(join(root, "artifacts"), {
      idFactory: () => "artifact:context",
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const nestedSecret = "opaque-refresh-secret";
    const itemCount = 125;
    const manifest = ContextManifestSchema.parse({
      manifest_id: "context:test",
      project_id: "project:test",
      run_id: "run:test",
      turn_id: "turn:test",
      model_call_id: "model-call:test",
      token_limit: 1_000,
      reserved_output_tokens: 100,
      input_tokens: itemCount,
      items: Array.from({ length: itemCount }, (_, index) => ({
        item_id: `context-item:${index}`,
        section: index === 0 ? "goal" : "repo",
        label: `Evidence ${index}`,
        source: {
          source_id: `source:${index}`,
          source_type: index === 0 ? "user" : "repository",
          trust: "trusted",
        },
        original_tokens: 1,
        included_tokens: 1,
        action: index === 0 ? "pinned" : "kept",
        reason: "roundtrip_test",
        content: index === itemCount - 1
          ? `GITHUB_TOKEN=${secret}`
          : index === itemCount - 2
            ? JSON.stringify({ refresh_token: nestedSecret })
            : `Evidence item ${index}`,
      })),
      fixed_constraints_preserved: true,
      created_at: "2026-09-16T00:00:00.000Z",
    });
    const ref = await store.put({
      projectId: "project:test",
      runId: "run:test",
      kind: "context_manifest",
      mimeType: "application/json",
      content: JSON.stringify(manifest, null, 2),
    });

    const result = await store.get({
      artifactId: ref.artifact_id,
      projectId: "project:test",
      runId: "run:test",
    });

    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("Context Artifact was unavailable");
    const roundTripped = ContextManifestSchema.parse(JSON.parse(result.content));
    expect(roundTripped.items).toHaveLength(itemCount);
    expect(JSON.stringify(roundTripped)).not.toContain(secret);
    expect(JSON.stringify(roundTripped)).not.toContain(nestedSecret);
    expect(roundTripped.items.at(-2)?.content).toContain("[REDACTED]");
    expect(roundTripped.items.at(-1)?.content).toBe("GITHUB_TOKEN=[REDACTED]");
  });
});

function ledgerAt(root: string): JsonlEventLedger {
  let sequence = 0;
  return new JsonlEventLedger(join(root, "events"), {
    idFactory: () => `event:${++sequence}`,
    now: () => new Date("2026-09-16T00:00:00.000Z"),
  });
}

function proposal(type: SessionEventProposal["type"]): SessionEventProposal {
  return {
    type,
    project_id: "project:test",
    run_id: "run:test",
    attempt: 0,
    summary: type,
    artifact_refs: [],
    data: type === "run.created"
      ? { task: "test", mode: "plan", workspace_kind: "readonly_local" }
      : {},
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-storage-"));
  roots.push(root);
  return root;
}
