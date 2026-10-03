import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../kernel/crypto.js";
import { JsonlEventLedger } from "../evidence/runtime-service.js";
import { MemoryControlError, MemoryControlService, JsonlMemoryV2RecordStore } from "./memory-control.js";
import { MemoryLifecycleService } from "./memory-lifecycle.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createService(now: () => Date = () => new Date("2026-09-30T12:00:00.000Z")) {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-memory-control-"));
  roots.push(root);
  const ledger = new JsonlEventLedger(join(root, "events"));
  const records = new JsonlMemoryV2RecordStore(join(root, "memory-v2"));
  await records.initialize();
  const service = new MemoryControlService({
    ownerId: "owner:local",
    actorId: "user:local",
    records,
    journal: ledger,
    lifecycle: new MemoryLifecycleService({ journal: ledger, now }),
    now,
  });
  return { root, ledger, records, service };
}

const localScope = { allowedScopeIds: ["project:one"] } as const;

describe("Memory V2 control plane", () => {
  it("binds explicit export consent to exact authored content and clears it on correction", async () => {
    const { service } = await createService();
    const input = { command_id: "command:export-consent", kind: "fact", claim: "Public fixture port is 4310.", project_id: "project:one", sensitivity: "public", allow_export: true };
    const candidate = await service.createCandidate(input, localScope);
    expect(candidate.record.governance).toMatchObject({ consent: "explicit", allowExport: true, allowModelUse: false });
    await expect(service.createCandidate({ ...input, allow_export: false }, localScope)).rejects.toMatchObject({ code: "memory_control_conflict" });
    const corrected = await service.correct(candidate.record.memoryId, { command_id: "command:export-correction", expected_sequence: 0, claim: "Public fixture port is 4311." }, localScope);
    expect(corrected.record.governance.allowExport).toBe(false);
    const correctionInput = { command_id: "command:export-fresh-consent", expected_sequence: 0, claim: "Public fixture port is 4312.", allow_export: true };
    const exportableCorrection = await service.correct(corrected.record.memoryId, correctionInput, localScope);
    expect(exportableCorrection.record.governance.allowExport).toBe(true);
    await expect(service.correct(corrected.record.memoryId, { ...correctionInput, allow_export: false }, localScope)).rejects.toMatchObject({ code: "memory_control_conflict" });
    const denied = await service.createCandidate({ ...input, command_id: "command:no-export", allow_export: undefined }, localScope);
    expect(denied.record.governance.allowExport).toBe(false);
    await expect(service.createCandidate({ ...input, command_id: "command:export-secret", sensitivity: "secret" }, localScope)).rejects.toThrow();
    await expect(service.createCandidate({ ...input, command_id: "command:export-cross-scope", project_id: "project:two" }, localScope)).rejects.toMatchObject({ code: "memory_control_scope_denied" });
  });

  it("creates review-gated candidates, replays review/revoke, and exposes provenance/use feedback read models", async () => {
    const { service, ledger } = await createService();
    const candidate = await service.createCandidate({
      command_id: "command:create-one",
      kind: "preference",
      claim: "Prefer concise project summaries.",
      project_id: "project:one",
      allow_model_use: true,
    }, localScope);
    expect(candidate.record).toMatchObject({
      status: "candidate",
      scope: { ownerId: "owner:local", projectId: "project:one" },
      provenance: { origin: "user", evidenceRefs: [{ source_type: "user" }] },
      governance: { consent: "explicit", allowModelUse: true },
    });

    const activated = await service.review(candidate.record.memoryId, {
      command_id: "command:review-one",
      expected_sequence: 0,
      action: "review_activate",
    }, localScope);
    expect(activated.record.status).toBe("active");
    const revoked = await service.revoke(candidate.record.memoryId, {
      command_id: "command:revoke-one",
      expected_sequence: 1,
    }, localScope);
    expect(revoked.record.status).toBe("revoked");
    expect((await service.list(localScope)).items[0]?.record.status).toBe("revoked");

    const lifecycle = await ledger.listMemoryLifecycle("owner:local", candidate.record.memoryId);
    expect(lifecycle.map((event) => event.action)).toEqual(["review_activate", "revoke"]);
    expect(JSON.stringify(lifecycle)).not.toContain(candidate.record.claim);
  });

  it("corrects an immutable active record into a new candidate and supersedes the prior identity", async () => {
    const { service } = await createService();
    const original = await service.createCandidate({
      command_id: "command:original",
      kind: "fact",
      claim: "The service listens on port 4310.",
      normalized_key: "service port",
      project_id: "project:one",
      allow_model_use: true,
    }, localScope);
    await service.review(original.record.memoryId, {
      command_id: "command:activate-original",
      expected_sequence: 0,
      action: "review_activate",
    }, localScope);

    const corrected = await service.correct(original.record.memoryId, {
      command_id: "command:correct-port",
      expected_sequence: 1,
      claim: "The service listens on port 4311.",
    }, localScope);
    expect(corrected.record).toMatchObject({
      status: "candidate",
      version: 2,
      claim: "The service listens on port 4311.",
      lineage: { supersedes: [original.record.memoryId] },
    });
    const snapshot = await service.list(localScope);
    expect(snapshot.items.map((item) => item.record.status).sort()).toEqual(["candidate", "superseded"]);
    const correctionRetry = await service.correct(original.record.memoryId, {
      command_id: "command:correct-port",
      expected_sequence: 1,
      claim: "The service listens on port 4311.",
    }, localScope);
    expect(correctionRetry.record.memoryId).toBe(corrected.record.memoryId);
  });

  it("redacts a deleted correction lineage and refuses later reads or mutations", async () => {
    const { root, service, records, ledger } = await createService();
    const original = await service.createCandidate({
      command_id: "command:erase-source",
      kind: "fact",
      claim: "Secret test phrase: blue lantern.",
      project_id: "project:one",
    }, localScope);
    const corrected = await service.correct(original.record.memoryId, {
      command_id: "command:erase-correction",
      expected_sequence: 0,
      claim: "Corrected test phrase: green lantern.",
    }, localScope);

    const deleted = await service.delete(corrected.record.memoryId, "command:erase-family", localScope);
    expect(deleted.deletedMemoryIds).toContain(original.record.memoryId);
    expect(deleted.deletedMemoryIds).toContain(corrected.record.memoryId);
    expect(await service.list(localScope)).toEqual({ items: [], conflicts: [] });
    await expect(service.review(original.record.memoryId, {
      command_id: "command:after-delete",
      expected_sequence: 0,
      action: "review_activate",
    }, localScope)).rejects.toMatchObject<Partial<MemoryControlError>>({ code: "memory_control_deleted", statusCode: 410 });

    const contents = await records.list("owner:local");
    expect(contents).toEqual([]);
    const data = await readFile(join(root, "memory-v2", hashSegment("owner:local"), "records.jsonl"), "utf8");
    expect(data).not.toContain("blue lantern");
    expect(data).not.toContain("green lantern");
    for (const memoryId of deleted.deletedMemoryIds) {
      const control = await ledger.listMemoryControl("owner:local", memoryId);
      expect(control.at(-1)?.action).toBe("deleted");
      expect(JSON.stringify(control)).not.toContain("lantern");
      expect(control.at(-1)).toMatchObject({ deletedMemoryIds: deleted.deletedMemoryIds, deletedScopeIds: ["project:one"] });
    }
    await expect(service.delete(corrected.record.memoryId, "command:erase-family", localScope)).resolves.toEqual(deleted);
    await expect(service.delete(corrected.record.memoryId, "command:cross-scope-delete-retry", { allowedScopeIds: ["project:two"] }))
      .rejects.toMatchObject<Partial<MemoryControlError>>({ code: "memory_control_not_found", statusCode: 404 });
    await expect(service.createCandidate({
      command_id: "command:erase-source",
      kind: "fact",
      claim: "Secret test phrase: blue lantern.",
      project_id: "project:one",
    }, localScope)).rejects.toMatchObject<Partial<MemoryControlError>>({ code: "memory_control_deleted", statusCode: 410 });
  });

  it("hides project records across scopes and rejects cross-scope commands without leaking existence", async () => {
    const { service } = await createService();
    const record = await service.createCandidate({
      command_id: "command:scoped-candidate",
      kind: "fact",
      claim: "Scoped fact.",
      project_id: "project:one",
    }, localScope);
    expect((await service.list({ allowedScopeIds: ["project:two"] })).items).toEqual([]);
    await expect(service.review(record.record.memoryId, {
      command_id: "command:cross-scope-review",
      expected_sequence: 0,
      action: "review_activate",
    }, { allowedScopeIds: ["project:two"] })).rejects.toMatchObject<Partial<MemoryControlError>>({ code: "memory_control_not_found", statusCode: 404 });
    await expect(service.createCandidate({
      command_id: "command:out-of-scope-candidate",
      kind: "fact",
      claim: "Not visible to caller.",
      project_id: "project:two",
    }, localScope)).rejects.toMatchObject<Partial<MemoryControlError>>({ code: "memory_control_scope_denied", statusCode: 404 });
  });

  it("retries candidate creation by command identity and rejects command-id content changes", async () => {
    const { service } = await createService();
    const input = { command_id: "command:idempotent-candidate", kind: "fact", claim: "One claim." } as const;
    const first = await service.createCandidate(input, localScope);
    const retry = await service.createCandidate(input, localScope);
    expect(retry.record.memoryId).toBe(first.record.memoryId);
    await expect(service.createCandidate({ ...input, claim: "Different claim." }, localScope))
      .rejects.toMatchObject<Partial<MemoryControlError>>({ code: "memory_control_conflict", statusCode: 409 });
    await expect(service.createCandidate({ ...input, allow_model_use: true }, localScope))
      .rejects.toMatchObject<Partial<MemoryControlError>>({ code: "memory_control_conflict", statusCode: 409 });
    expect((await service.list(localScope)).items).toHaveLength(1);
  });

  it("projects exact-version MemoryUse dispatch and response state from the Run Ledger", async () => {
    const { service, ledger } = await createService();
    const candidate = await service.createCandidate({
      command_id: "command:memory-use-candidate",
      kind: "preference",
      claim: "Use compact examples.",
    }, localScope);
    const contentHash = sha256(candidate.record.claim);
    const memoryRef = {
      record_schema_version: "tracegraph.memory-record.v2" as const,
      memory_id: candidate.record.memoryId,
      version: candidate.record.version,
      content_hash: contentHash,
      evidence_refs: candidate.record.provenance.evidenceRefs.flatMap((ref) => (
        "source_type" in ref ? [{ source_id: ref.source_id, source_type: ref.source_type, trust: ref.trust }] : []
      )),
    };
    const retrieval = {
      rank: 1,
      hit_id: "hit:memory-control",
      content_hash: contentHash,
      score: 1,
      source_path: `memory/${encodeURIComponent(candidate.record.memoryId)}.md`,
      start_line: 1,
      end_line: 1,
      heading_path: [],
      injected_tokens: 3,
      memory_ref: memoryRef,
    };
    const tokenEstimate = {
      estimator_id: "heuristic_v2",
      confidence: "estimated",
      input_tokens: 3,
      output_tokens: 0,
      per_section: { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 3, experience: 0 },
    };
    await ledger.append({
      type: "memory.use_status",
      project_id: "project:one",
      run_id: "run:memory-use-control",
      attempt: 0,
      artifact_refs: [],
      summary: "MemoryUse dispatch intent",
      data: {
        memory_use_id: "memory-use:control",
        stage: "dispatch_intent",
        manifest_id: "context:control",
        rendered_context_digest: sha256("rendered context"),
        token_estimate: tokenEstimate,
        memory_items: [{
          context_item_id: "context-item:memory",
          memory_ref: memoryRef,
          retrieval,
          content_digest: contentHash,
          included_tokens: 3,
        }],
      },
    });
    await ledger.append({
      type: "memory.use_status",
      project_id: "project:one",
      run_id: "run:memory-use-control",
      attempt: 0,
      artifact_refs: [],
      summary: "MemoryUse response",
      data: { memory_use_id: "memory-use:control", stage: "response" },
    });

    const item = (await service.list(localScope)).items[0]!;
    expect(item.memoryUseRequests).toEqual([{
      runId: "run:memory-use-control",
      memoryUseId: "memory-use:control",
      memoryVersion: 1,
      contextManifestId: "context:control",
      stage: "response",
      occurredAt: expect.any(String),
    }]);
  });
});

function hashSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
