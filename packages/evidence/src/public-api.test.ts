import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEventProposal, TodoList } from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  JsonlEventLedger,
  computeReplaySnapshotHash,
  projectRun,
  replaySnapshotFromEvents,
  toWireEvent,
  type EvidencePrimitives,
  type ProjectionPorts,
  type ReplayPorts,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@tracegraph/evidence public contract", () => {
  it("preserves Ledger integrity and idempotency through the package root", async () => {
    const root = await temporaryRoot();
    const ledger = new JsonlEventLedger(join(root, "events"), { primitives });
    const proposal = eventProposal("run.created", "run.created", {
      task: "Public package contract",
      mode: "execute",
      workspace_kind: "managed_local",
      _internal_trace: "must not reach the wire",
    });

    const first = await ledger.append(proposal);
    const duplicate = await ledger.append(proposal);

    expect(duplicate).toEqual(first);
    expect(await ledger.list("run:evidence")).toEqual([first]);
    expect(first.event_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(toWireEvent(first, projectionPorts).data).not.toHaveProperty("_internal_trace");
  });

  it("checks Artifact content hashes and caller scope through the package root", async () => {
    const root = await temporaryRoot();
    const store = new ArtifactStore(join(root, "artifacts"), { primitives });
    const artifact = await store.put({
      projectId: "project:evidence",
      runId: "run:evidence",
      kind: "tool_output",
      mimeType: "text/plain",
      content: "evidence artifact",
    });

    expect(artifact.content_hash).toBe(primitives.sha256("evidence artifact"));
    expect(await store.get({
      artifactId: artifact.artifact_id,
      projectId: "project:other",
      runId: "run:evidence",
    })).toMatchObject({ status: "unavailable", reason: "out_of_scope" });
    expect(await store.get({
      artifactId: artifact.artifact_id,
      projectId: "project:evidence",
      runId: "run:evidence",
    })).toMatchObject({ status: "available", artifact });
  });

  it("persists owner/version-scoped Memory feedback with CAS, idempotency, and a separate hash chain", async () => {
    const root = await temporaryRoot();
    const ledger = new JsonlEventLedger(join(root, "events"), { primitives });
    const reported = await ledger.appendMemoryFeedback({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: "owner:one",
      memoryId: "memory:one",
      memoryVersion: 3,
      expectedSequence: 0,
      action: "reported",
      runId: "run:one",
      memoryUseId: "memory-use:one",
      contextManifestId: "context:one",
      feedback: "incorrect",
      actor: { type: "user", id: "user:one" },
      idempotencyKey: "feedback:incorrect:one",
      occurredAt: "2026-09-30T00:00:00.000Z",
    });
    const retry = await ledger.appendMemoryFeedback({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: "owner:one",
      memoryId: "memory:one",
      memoryVersion: 3,
      expectedSequence: 0,
      action: "reported",
      runId: "run:one",
      memoryUseId: "memory-use:one",
      contextManifestId: "context:one",
      feedback: "incorrect",
      actor: { type: "user", id: "user:one" },
      idempotencyKey: "feedback:incorrect:one",
      occurredAt: "2026-09-30T00:05:00.000Z",
    });
    expect(retry).toEqual({ event: reported.event, replayed: true });
    expect(await ledger.listMemoryFeedback("owner:one", "memory:one", 3)).toEqual([reported.event]);
    expect(await ledger.listMemoryFeedback("owner:other", "memory:one", 3)).toEqual([]);
    expect(await ledger.listMemoryFeedback("owner:one", "memory:one", 4)).toEqual([]);

    await expect(ledger.appendMemoryFeedback({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: "owner:one",
      memoryId: "memory:one",
      memoryVersion: 3,
      expectedSequence: 0,
      action: "reported",
      runId: "run:two",
      memoryUseId: "memory-use:two",
      contextManifestId: "context:two",
      feedback: "helpful",
      actor: { type: "user", id: "user:one" },
      idempotencyKey: "feedback:stale-sequence",
      occurredAt: "2026-09-30T00:06:00.000Z",
    })).rejects.toThrow(/sequence conflict/u);

    await expect(ledger.appendMemoryFeedback({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: "owner:one",
      memoryId: "memory:one",
      memoryVersion: 3,
      expectedSequence: 1,
      action: "reported",
      runId: "run:one",
      memoryUseId: "memory-use:one",
      contextManifestId: "context:one",
      feedback: "helpful",
      actor: { type: "user", id: "user:one" },
      idempotencyKey: "feedback:incorrect:replacement",
      occurredAt: "2026-09-30T00:07:00.000Z",
    })).rejects.toThrow(/only once/u);

    const dismissed = await ledger.appendMemoryFeedback({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: "owner:one",
      memoryId: "memory:one",
      memoryVersion: 3,
      expectedSequence: 1,
      action: "review_dismissed",
      feedbackEventId: reported.event.eventId,
      actor: { type: "user", id: "user:one" },
      idempotencyKey: "feedback:review:one",
      occurredAt: "2026-09-30T00:10:00.000Z",
    });
    expect(dismissed.event.previousEventHash).toBe(reported.event.eventHash);
    const restarted = new JsonlEventLedger(join(root, "events"), { primitives });
    expect(await restarted.listMemoryFeedback("owner:one", "memory:one", 3)).toEqual([
      reported.event,
      dismissed.event,
    ]);
  });

  it("keeps Projection in-memory and replays an anchored hash through the package root", async () => {
    const root = await temporaryRoot();
    const ledger = new JsonlEventLedger(join(root, "events"), { primitives });
    await ledger.append(eventProposal("run.created", "run.created", { task: "Replay", mode: "plan" }));
    await ledger.append(eventProposal("run.started", "run.started", { phase: "conversation" }));
    const events = await ledger.list("run:evidence");
    const beforeProjection = structuredClone(events);

    const projection = projectRun(events, projectionPorts);
    const replay = replaySnapshotFromEvents(events, {
      session_id: "session:evidence",
      run_id: "run:evidence",
      until_sequence: 2,
    }, replayPorts);

    expect(projection.last_sequence).toBe(2);
    expect(events).toEqual(beforeProjection);
    expect(replay.projection).toEqual(projection);
    expect(replay.snapshot_hash).toBe(computeReplaySnapshotHash(replay, replayPorts));
    expect(replay.anchor_event_id).toBe(events[1]?.event_id);
  });

  it("keeps Experience lifecycle in its own owner-scoped Ledger stream with CAS, idempotency, and hash validation", async () => {
    const root = await temporaryRoot();
    const ledgerRoot = join(root, "events");
    const ledger = new JsonlEventLedger(ledgerRoot, { primitives });
    const draft = {
      schemaVersion: "tracegraph.experience-lifecycle-event.v1" as const,
      eventType: "experience.lifecycle.transitioned" as const,
      ownerId: "owner:experience",
      caseId: "experience:one",
      caseVersion: 1,
      expectedSequence: 0,
      action: "validate" as const,
      fromStatus: "candidate" as const,
      toStatus: "validated" as const,
      actor: { type: "user" as const, id: "user:one" },
      reasonCode: "review_accepted" as const,
      idempotencyKey: "experience-review:one",
      occurredAt: "2026-10-01T00:00:00.000Z",
    };
    const appended = await ledger.appendExperienceLifecycle(draft);
    expect(await ledger.appendExperienceLifecycle({ ...draft, occurredAt: "2026-10-01T00:01:00.000Z" }))
      .toEqual({ event: appended.event, replayed: true });
    expect(await ledger.listExperienceLifecycle("owner:experience", "experience:one"))
      .toEqual([appended.event]);
    expect(await ledger.listExperienceLifecycle("owner:other", "experience:one")).toEqual([]);
    expect(await ledger.list("run:evidence")).toEqual([]);
    await expect(ledger.appendExperienceLifecycle({
      ...draft,
      action: "dispute",
      fromStatus: "validated",
      toStatus: "disputed",
      reasonCode: "user_challenge",
      idempotencyKey: "experience-review:stale",
    })).rejects.toThrow(/sequence conflict/u);

    const ownerHash = primitives.sha256(draft.ownerId).slice("sha256:".length);
    const caseHash = primitives.sha256(draft.caseId).slice("sha256:".length);
    const path = join(ledgerRoot, "experience", ownerHash, `${caseHash}.jsonl`);
    const stored = JSON.parse(await readFile(path, "utf8")) as { eventHash: string };
    stored.eventHash = primitives.sha256("tampered");
    await writeFile(path, `${JSON.stringify(stored)}\n`);
    await expect(ledger.listExperienceLifecycle(draft.ownerId, draft.caseId)).rejects.toThrow(/hash mismatch/u);
  });
});

const primitives: EvidencePrimitives = {
  defaultIdFactory: sequentialIdFactory(),
  redactSensitiveText: (value) => value,
  redactStructuredArtifactValue: (value) => value,
  redactStructuredValue: (value) => value,
  sha256: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
  stableStringify: (value) => JSON.stringify(sortRecursively(value)),
};

const projectionPorts: ProjectionPorts = {
  redactSensitiveText: primitives.redactSensitiveText,
  redactStructuredValue: primitives.redactStructuredValue,
  projectTeam: () => undefined,
  projectTodos: (events): TodoList => ({ items: [], last_sequence: events.at(-1)?.sequence ?? 0 }),
};

const replayPorts: ReplayPorts = {
  ...projectionPorts,
  sha256: primitives.sha256,
  stableStringify: primitives.stableStringify,
};

function eventProposal(
  idempotencyKey: string,
  type: SessionEventProposal["type"],
  data: Record<string, unknown>,
): SessionEventProposal {
  return {
    type,
    project_id: "project:evidence",
    run_id: "run:evidence",
    session_id: "session:evidence",
    attempt: 0,
    summary: type,
    artifact_refs: [],
    idempotency_key: idempotencyKey,
    data,
  };
}

function sequentialIdFactory(): EvidencePrimitives["defaultIdFactory"] {
  let sequence = 0;
  return (prefix) => `${prefix}:public-api-${++sequence}`;
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortRecursively(child)]),
  );
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-evidence-contract-"));
  roots.push(root);
  return root;
}
