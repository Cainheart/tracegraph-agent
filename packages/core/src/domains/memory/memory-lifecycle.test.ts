import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryLifecycleAction, MemoryLifecycleCommand, MemoryRecordV2 } from "@tracegraph/contracts";
import { EventInvariantError, JsonlEventLedger, LedgerCorruptionError } from "../evidence/runtime-service.js";
import {
  MemoryLifecycleError,
  MemoryLifecycleService,
} from "./memory-lifecycle.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function candidate(overrides: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  return {
    schemaVersion: 2,
    memoryId: "memory:lifecycle-one",
    version: 3,
    kind: "fact",
    claim: "The project uses a local journal.",
    status: "candidate",
    scope: { ownerId: "owner:one", projectId: "project:one", visibility: "private" },
    provenance: {
      origin: "user",
      evidenceRefs: [{ source_id: "source:user", source_type: "user", trust: "trusted" }],
      createdBy: { type: "user", id: "user:one" },
    },
    assessment: { sourceTrust: "authoritative", verification: "asserted" },
    validity: {
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2026-10-01T00:00:00.000Z",
      applicability: ["project:one"],
      invalidators: [],
    },
    governance: {
      sensitivity: "personal",
      consent: "explicit",
      retentionPolicy: "review-annually",
      allowModelUse: true,
      allowExport: false,
    },
    lineage: { supersedes: [], contradictedBy: [], derivedFrom: [] },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

async function createService(options: { now?: () => Date } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-memory-lifecycle-"));
  directories.push(root);
  let eventId = 0;
  const ledger = new JsonlEventLedger(root, {
    idFactory: (prefix) => `${prefix}:test:${++eventId}`,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const service = new MemoryLifecycleService({
    journal: ledger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { root, ledger, service };
}

function command(
  action: MemoryLifecycleAction,
  expectedSequence: number,
  overrides: Partial<MemoryLifecycleCommand> = {},
): MemoryLifecycleCommand {
  const reasonByAction: Record<MemoryLifecycleAction, MemoryLifecycleCommand["reasonCode"]> = {
    review_activate: "review_accepted",
    review_reject: "review_rejected",
    dispute: "user_challenge",
    resolve_active: "resolution_confirmed",
    resolve_superseded: "correction_accepted",
    supersede: "replacement_accepted",
    revoke: "user_requested_forget",
    expire: "retention_elapsed",
    revalidate: "revalidated_by_user",
  };
  return {
    ownerId: "owner:one",
    memoryId: "memory:lifecycle-one",
    memoryVersion: 3,
    expectedSequence,
    action,
    actor: { type: action === "expire" ? "system" : "user", id: action === "expire" ? "system:retention" : "user:one" },
    reasonCode: reasonByAction[action],
    idempotencyKey: `command:${action}:${expectedSequence}`,
    ...overrides,
  };
}

describe("Memory V2 lifecycle", () => {
  it("persists and replays reviewed, disputed, resolved, superseded, and revoked transitions", async () => {
    let now = new Date("2026-09-02T00:00:00.000Z");
    const { root, ledger, service } = await createService({ now: () => now });
    const seed = candidate();
    const commands = [
      command("review_activate", 0),
      command("dispute", 1, { reasonCode: "conflicting_evidence" }),
      command("resolve_active", 2),
      command("supersede", 3, { relatedMemoryId: "memory:replacement" }),
      command("revoke", 4),
    ];
    const statuses = ["active", "disputed", "active", "superseded", "revoked"];

    for (const [index, item] of commands.entries()) {
      now = new Date(now.getTime() + 1_000);
      const result = await service.transition(seed, item);
      expect(result.record.status).toBe(statuses[index]);
      expect(result.event).toMatchObject({
        sequence: index + 1,
        action: item.action,
        fromStatus: index === 0 ? "candidate" : statuses[index - 1],
        toStatus: statuses[index],
      });
      expect(JSON.stringify(result.event)).not.toContain(seed.claim);
    }

    expect(await ledger.list("run:unrelated")).toEqual([]);
    const ownerDirectory = join(root, "memory", requireSafeOwnerDirectory("owner:one"));
    const [filename] = await readdir(ownerDirectory);
    expect((await stat(ownerDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(ownerDirectory, filename ?? ""))).mode & 0o777).toBe(0o600);

    const restarted = new MemoryLifecycleService({
      journal: new JsonlEventLedger(root),
      now: () => now,
    });
    const replayed = await restarted.read(seed);
    expect(replayed).toEqual({ record: { ...seed, status: "revoked", updatedAt: now.toISOString() }, sequence: 5 });
  });

  it("rejects illegal transitions and blocks an unreviewed legacy record from activation", async () => {
    const { service } = await createService({ now: () => new Date("2026-09-02T00:00:00.000Z") });
    await expect(service.transition(candidate(), command("dispute", 0)))
      .rejects.toMatchObject<Partial<MemoryLifecycleError>>({ code: "memory_lifecycle_invalid_transition" });

    const legacy = candidate({
      kind: "legacy_unclassified",
      governance: {
        sensitivity: "unknown",
        consent: "none",
        retentionPolicy: "legacy-unreviewed",
        allowModelUse: false,
        allowExport: false,
      },
      assessment: { sourceTrust: "unknown", verification: "unclassified" },
    });
    await expect(service.transition(legacy, command("review_activate", 0)))
      .rejects.toMatchObject<Partial<MemoryLifecycleError>>({ code: "memory_lifecycle_invalid_transition" });
    const rejected = await service.transition(legacy, command("review_reject", 0));
    expect(rejected.record.status).toBe("revoked");
  });

  it("revalidates expired Memory back to candidate and requires a second explicit review", async () => {
    let now = new Date("2026-09-02T00:00:00.000Z");
    const { service } = await createService({ now: () => now });
    const seed = candidate({
      validity: {
        validFrom: "2026-09-01T00:00:00.000Z",
        validUntil: "2026-10-01T00:00:00.000Z",
        applicability: ["project:one"],
        invalidators: [],
      },
    });
    const active = await service.transition(seed, command("review_activate", 0));
    now = new Date("2026-10-02T00:00:01.000Z");
    const expired = await service.transition(seed, command("expire", 1));
    expect(expired.record.status).toBe("expired");
    now = new Date("2026-10-02T00:00:02.000Z");
    const candidateAgain = await service.transition(seed, command("revalidate", 2, {
      validUntil: "2026-11-01T00:00:00.000Z",
    }));
    expect(candidateAgain.record).toMatchObject({
      status: "candidate",
      validity: { validFrom: now.toISOString(), validUntil: "2026-11-01T00:00:00.000Z" },
    });
    now = new Date("2026-10-02T00:00:03.000Z");
    const reviewedAgain = await service.transition(seed, command("review_activate", 3, {
      idempotencyKey: "command:review:after-revalidation",
    }));
    expect(reviewedAgain.record.status).toBe("active");
    expect(active.record.status).toBe("active");
  });

  it("handles idempotent retries, stale sequence conflicts, and journal corruption", async () => {
    const { root, ledger, service } = await createService({ now: () => new Date("2026-09-02T00:00:00.000Z") });
    const seed = candidate();
    const activate = command("review_activate", 0, { idempotencyKey: "command:activate:stable" });
    const first = await service.transition(seed, activate);
    const retry = await service.transition(seed, activate);
    expect(retry).toMatchObject({ replayed: true, record: { status: "active" }, event: first.event });

    await expect(service.transition(seed, command("revoke", 0)))
      .rejects.toMatchObject<Partial<MemoryLifecycleError>>({ code: "memory_lifecycle_version_conflict" });
    await expect(service.transition(seed, command("review_activate", 0, {
      idempotencyKey: "command:activate:stable",
      actor: { type: "user", id: "user:two" },
    }))).rejects.toMatchObject<Partial<MemoryLifecycleError>>({ code: "memory_lifecycle_idempotency_conflict" });

    const ownerDirectory = join(root, "memory", requireSafeOwnerDirectory("owner:one"));
    const [filename] = await readdir(ownerDirectory);
    const path = join(ownerDirectory, filename ?? "");
    const text = await readFile(path, "utf8");
    const corrupted = text.replace(first.event.eventHash, `sha256:${"0".repeat(64)}`);
    await writeFile(path, corrupted, "utf8");
    await expect(ledger.listMemoryLifecycle("owner:one", "memory:lifecycle-one"))
      .rejects.toBeInstanceOf(LedgerCorruptionError);
  });

  it("uses ledger sequence compare-and-swap to reject concurrent stale writers", async () => {
    const { ledger, service } = await createService({ now: () => new Date("2026-09-02T00:00:00.000Z") });
    const seed = candidate();
    const outcomes = await Promise.allSettled([
      service.transition(seed, command("review_activate", 0, { idempotencyKey: "command:concurrent:one" })),
      service.transition(seed, command("review_activate", 0, { idempotencyKey: "command:concurrent:two" })),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(EventInvariantError) });
    expect(await ledger.listMemoryLifecycle("owner:one", "memory:lifecycle-one")).toHaveLength(1);
  });
});

function requireSafeOwnerDirectory(ownerId: string): string {
  return createHashSegment(ownerId);
}

function createHashSegment(value: string): string {
  // Keep the file discovery in this test independent of the implementation's
  // private path helper while still avoiding the raw owner ID in filenames.
  return createHash("sha256").update(value).digest("hex");
}
