import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
