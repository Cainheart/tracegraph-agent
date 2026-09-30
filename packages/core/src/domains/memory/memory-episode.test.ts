import { describe, expect, it } from "vitest";
import {
  MemoryEpisodeCandidateDraftSchema,
  SCHEMA_VERSION,
  SessionEventSchema,
  type SessionEvent,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";
import {
  MAX_MEMORY_EPISODE_SOURCE_TEXT_CHARS,
  MemoryEpisodeProjectionError,
  buildMemoryEpisodeExtractionInput,
  projectMemoryEpisode,
} from "./memory-episode.js";

describe("Memory Episode projection", () => {
  it("projects only a complete hash-validated terminal Run and produces stable event provenance", () => {
    const events = makeRunEvents("run:episode-project", 1);
    const episode = projectMemoryEpisode(events);
    const replayed = projectMemoryEpisode(events);

    expect(episode).toEqual(replayed);
    expect(episode).toMatchObject({
      runId: "run:episode-project",
      projectId: "project:episode-tests",
      sourceRange: { from: 1, to: 3 },
      outcome: "succeeded",
      boundaryReason: ["run_terminal"],
    });
    expect(episode.evidenceRefs.map(({ sequence, eventHash }) => ({ sequence, eventHash }))).toEqual([
      { sequence: 1, eventHash: events[0]?.event_hash },
      { sequence: 2, eventHash: events[1]?.event_hash },
      { sequence: 3, eventHash: events[2]?.event_hash },
    ]);

    const tampered = events.map((event, index) => index === 1 ? { ...event, summary: "changed after settlement" } : event);
    expect(() => projectMemoryEpisode(tampered)).toThrow(MemoryEpisodeProjectionError);
    expect(() => projectMemoryEpisode(events.slice(0, -1))).toThrow(MemoryEpisodeProjectionError);
    expect(() => projectMemoryEpisode([...events, ...makeRunEvents("run:episode-other", 1)]))
      .toThrow(MemoryEpisodeProjectionError);
  });

  it("keeps bounded extractor JSON valid and restricts citations to rows actually sent", () => {
    const events = makeRunEvents("run:episode-bounded", 110, {
      summary: (sequence) => sequence === 2
        ? "private_token=episode-secret-must-be-redacted"
        : `Evidence row ${sequence}: ${"x".repeat(1_800)}`,
    });
    const episode = projectMemoryEpisode(events);
    const input = buildMemoryEpisodeExtractionInput(episode, events);
    const rows = JSON.parse(input.sourceText) as Array<{ sequence: number; summary: string }>;

    expect(input.sourceText.length).toBeLessThanOrEqual(MAX_MEMORY_EPISODE_SOURCE_TEXT_CHARS);
    expect(input.evidenceSequences).toEqual(rows.map(({ sequence }) => sequence));
    expect(rows.at(-1)?.sequence).toBe(events.at(-1)?.sequence);
    expect(rows.length).toBeLessThan(episode.evidenceRefs.length);
    expect(input.sourceText).not.toContain("episode-secret-must-be-redacted");
    expect(() => JSON.parse(input.sourceText) as unknown).not.toThrow();
  });

  it.each([
    ["run.failed", "failed"],
    ["run.cancelled", "abandoned"],
  ] as const)("maps %s to the Episode outcome %s", (terminalType, outcome) => {
    const events = makeRunEvents("run:episode-outcome-" + terminalType, 1, { terminalType });
    expect(projectMemoryEpisode(events).outcome).toBe(outcome);
  });

  it("rejects model-derived declared identity claims at the contract boundary", () => {
    expect(MemoryEpisodeCandidateDraftSchema.safeParse({
      kind: "declared_identity",
      claim: "I am a staff engineer.",
      evidenceSequences: [1],
    }).success).toBe(false);
  });
});

function makeRunEvents(
  runId: string,
  toolEventCount: number,
  options: {
    summary?: (sequence: number) => string;
    terminalType?: "run.completed" | "run.failed" | "run.cancelled";
  } = {},
): SessionEvent[] {
  const values: SessionEvent[] = [];
  const eventCount = toolEventCount + 2;
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    const type = sequence === 1
      ? "run.created"
      : sequence === eventCount
        ? options.terminalType ?? "run.completed"
        : "tool.completed";
    const body = {
      schema_version: SCHEMA_VERSION,
      event_id: `event:${runId}:${sequence}`,
      project_id: "project:episode-tests",
      run_id: runId,
      sequence,
      occurred_at: new Date(Date.UTC(2026, 8, 30, 0, 0, sequence)).toISOString(),
      attempt: 0,
      summary: options.summary?.(sequence) ?? (type === "run.completed" ? "Run completed" : `Event ${sequence}`),
      artifact_refs: [],
      ...(values.at(-1) === undefined ? {} : { previous_event_hash: values.at(-1)!.event_hash }),
      type,
      data: {},
    };
    values.push(SessionEventSchema.parse({
      ...body,
      event_hash: sha256(stableStringify(body)),
    }));
  }
  return values;
}
