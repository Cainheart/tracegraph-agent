import {
  MemoryEpisodeExtractionInputSchema,
  MemoryEpisodeOutcomeSchema,
  MemoryEpisodeSchema,
  MemoryRunEvidenceRefSchema,
  SessionEventSchema,
  isTerminalEventType,
  type MemoryEpisode,
  type MemoryEpisodeExtractionInput,
  type MemoryRunEvidenceRef,
  type SessionEvent,
} from "@tracegraph/contracts";
import { redactSensitiveText, sha256, stableStringify } from "../../kernel/crypto.js";

export const MEMORY_EPISODE_PROJECTOR_VERSION = "run-terminal-v1";
export const MAX_MEMORY_EPISODE_RUN_EVENTS = 10_000;
export const MAX_MEMORY_EPISODE_SOURCE_EVENTS = 256;
export const MAX_MEMORY_EPISODE_SOURCE_TEXT_CHARS = 48_000;

const evidenceEventTypes = new Set([
  "run.created",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.completed",
  "tool.failed",
  "tool.unknown",
  "action.verified",
  "action.reconciled",
  "test.completed",
  "todo.completed",
]);

export class MemoryEpisodeProjectionError extends Error {
  readonly code: "memory_episode_invalid_source" | "memory_episode_unbounded_source" | "memory_episode_evidence_mismatch";

  constructor(code: MemoryEpisodeProjectionError["code"], message: string) {
    super(message);
    this.name = "MemoryEpisodeProjectionError";
    this.code = code;
  }
}

export function projectMemoryEpisode(eventValues: readonly unknown[]): MemoryEpisode {
  if (eventValues.length === 0 || eventValues.length > MAX_MEMORY_EPISODE_RUN_EVENTS) {
    throw new MemoryEpisodeProjectionError(
      "memory_episode_unbounded_source",
      `A settled Run must contain between 1 and ${MAX_MEMORY_EPISODE_RUN_EVENTS} events`,
    );
  }
  let events: SessionEvent[];
  try {
    events = eventValues.map((value) => SessionEventSchema.parse(value));
  } catch {
    throw new MemoryEpisodeProjectionError("memory_episode_invalid_source", "Run evidence contains an invalid event");
  }
  const first = events[0]!;
  const terminalEvents = events.filter((event) => isTerminalEventType(event.type));
  const terminal = terminalEvents[0];
  let previousHash: string | undefined;
  const hashChainValid = events.every((event) => {
    const { event_hash: eventHash, ...body } = event;
    const valid = event.previous_event_hash === previousHash
      && sha256(stableStringify(body)) === eventHash;
    previousHash = eventHash;
    return valid;
  });
  if (first.type !== "run.created" || terminal === undefined || terminalEvents.length !== 1
    || terminal !== events.at(-1)
    || !hashChainValid
    || events.some((event, index) => event.project_id !== first.project_id
      || event.run_id !== first.run_id
      || event.session_id !== first.session_id
      || event.sequence !== index + 1)) {
    throw new MemoryEpisodeProjectionError(
      "memory_episode_invalid_source",
      "Episode projection requires one complete, single-scope Run stream ending in exactly one terminal event",
    );
  }
  const digest = memoryEpisodeSourceDigest(events);
  const selectedEvidence = selectEvidenceEvents(events);
  const outcome = terminal.type === "run.completed" ? "succeeded"
    : terminal.type === "run.failed" ? "failed"
      : "abandoned";
  return MemoryEpisodeSchema.parse({
    schemaVersion: "tracegraph.memory-episode.v1",
    episodeId: memoryEpisodeId(first.run_id),
    projectId: first.project_id,
    runId: first.run_id,
    ...(first.session_id === undefined ? {} : { sessionId: first.session_id }),
    sourceRange: { from: first.sequence, to: terminal.sequence },
    goalRefs: [],
    evidenceRefs: selectedEvidence.map(toMemoryRunEvidenceRef),
    outcome: MemoryEpisodeOutcomeSchema.parse(outcome),
    summary: redactSensitiveText(terminal.summary).slice(0, 2_000) || `Run ${outcome}`,
    boundaryReason: ["run_terminal"],
    projectorVersion: MEMORY_EPISODE_PROJECTOR_VERSION,
    sourceDigest: digest,
    settledAt: terminal.occurred_at,
  });
}

export function memoryEpisodeSourceDigest(events: readonly SessionEvent[]): string {
  return sha256(stableStringify(events.map(({ event_id: eventId, event_hash: eventHash }) => ({ eventId, eventHash }))));
}

export function memoryEpisodeId(runId: string): string {
  return `episode:${sha256(`${MEMORY_EPISODE_PROJECTOR_VERSION}:${runId}`).slice("sha256:".length, 40)}`;
}

export function toMemoryRunEvidenceRef(event: SessionEvent): MemoryRunEvidenceRef {
  return MemoryRunEvidenceRefSchema.parse({
    kind: "run_event",
    projectId: event.project_id,
    runId: event.run_id,
    ...(event.session_id === undefined ? {} : { sessionId: event.session_id }),
    eventId: event.event_id,
    sequence: event.sequence,
    eventType: event.type,
    eventHash: event.event_hash,
  });
}

export function buildMemoryEpisodeExtractionInput(
  episode: MemoryEpisode,
  events: readonly SessionEvent[],
): MemoryEpisodeExtractionInput {
  assertEpisodeMatchesRun(episode, events);
  const evidenceSequences = episode.evidenceRefs.map(({ sequence }) => sequence);
  const bySequence = new Map(events.map((event) => [event.sequence, event]));
  const sourceRows = episode.evidenceRefs.flatMap((ref) => {
    const event = bySequence.get(ref.sequence);
    if (event === undefined) return [];
    const facts = safeReceiptFacts(event);
    return [{
      event_id: event.event_id,
      sequence: event.sequence,
      type: event.type,
      occurred_at: event.occurred_at,
      summary: redactSensitiveText(event.summary).slice(0, 500),
      ...(facts === undefined ? {} : { facts }),
    }];
  });
  // Keep the JSON intact and make the allowed sequence set exactly match the
  // evidence rows the model actually receives. The terminal receipt is kept.
  const terminal = sourceRows.at(-1)!;
  const boundedRows = [terminal];
  for (const row of sourceRows.slice(0, -1)) {
    const proposed = [...boundedRows, row].sort((left, right) => left.sequence - right.sequence);
    if (redactSensitiveText(stableStringify(proposed)).length <= MAX_MEMORY_EPISODE_SOURCE_TEXT_CHARS) {
      boundedRows.push(row);
    }
  }
  boundedRows.sort((left, right) => left.sequence - right.sequence);
  const sourceText = redactSensitiveText(stableStringify(boundedRows));
  return MemoryEpisodeExtractionInputSchema.parse({
    projectId: episode.projectId,
    runId: episode.runId,
    episodeId: episode.episodeId,
    sourceDigest: episode.sourceDigest,
    outcome: episode.outcome,
    sourceText: sourceText.length > 0 ? sourceText : "[]",
    evidenceSequences: boundedRows.map(({ sequence }) => sequence),
  });
}

export function assertEpisodeMatchesRun(episode: MemoryEpisode, eventValues: readonly unknown[]): void {
  const events = eventValues.map((value) => SessionEventSchema.parse(value));
  if (memoryEpisodeSourceDigest(events) !== episode.sourceDigest
    || memoryEpisodeId(episode.runId) !== episode.episodeId) {
    throw new MemoryEpisodeProjectionError("memory_episode_evidence_mismatch", "Episode no longer matches its canonical Run stream");
  }
  const bySequence = new Map(events.map((event) => [event.sequence, event]));
  for (const ref of episode.evidenceRefs) {
    const event = bySequence.get(ref.sequence);
    if (event === undefined || event.event_id !== ref.eventId || event.event_hash !== ref.eventHash
      || event.run_id !== episode.runId || event.project_id !== episode.projectId
      || event.session_id !== episode.sessionId || event.type !== ref.eventType) {
      throw new MemoryEpisodeProjectionError("memory_episode_evidence_mismatch", "Episode contains an event reference outside its canonical Run stream");
    }
  }
}

export function assertCandidateEvidenceSequences(
  episode: MemoryEpisode,
  events: readonly SessionEvent[],
  sequences: readonly number[],
): MemoryRunEvidenceRef[] {
  assertEpisodeMatchesRun(episode, events);
  const allowed = new Map(episode.evidenceRefs.map((ref) => [ref.sequence, ref]));
  const selected = sequences.map((sequence) => allowed.get(sequence));
  if (selected.some((ref) => ref === undefined) || new Set(sequences).size !== sequences.length) {
    throw new MemoryEpisodeProjectionError("memory_episode_evidence_mismatch", "Candidate cited evidence outside its Episode or repeated a reference");
  }
  return selected as MemoryRunEvidenceRef[];
}

function selectEvidenceEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const eligible = events.filter((event) => evidenceEventTypes.has(event.type));
  if (eligible.length <= MAX_MEMORY_EPISODE_SOURCE_EVENTS) return eligible;
  const terminal = events.at(-1)!;
  const prioritized = eligible.filter((event) => event.type === "run.created"
    || isTerminalEventType(event.type)
    || event.type === "test.completed"
    || event.type === "action.verified");
  const retained = new Map<number, SessionEvent>();
  for (const event of prioritized.slice(-MAX_MEMORY_EPISODE_SOURCE_EVENTS)) retained.set(event.sequence, event);
  for (const event of eligible.slice(-MAX_MEMORY_EPISODE_SOURCE_EVENTS)) retained.set(event.sequence, event);
  retained.set(terminal.sequence, terminal);
  return [...retained.values()].sort((left, right) => left.sequence - right.sequence).slice(-MAX_MEMORY_EPISODE_SOURCE_EVENTS);
}

function safeReceiptFacts(event: SessionEvent): Record<string, unknown> | undefined {
  if (event.type !== "tool.completed" && event.type !== "tool.failed" && event.type !== "tool.unknown" && event.type !== "test.completed") {
    return undefined;
  }
  const data = event.data;
  const receiptValue = data.receipt;
  if (typeof receiptValue !== "object" || receiptValue === null || Array.isArray(receiptValue)) return undefined;
  const receipt = receiptValue as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const key of ["tool_name", "status", "business_status", "code", "summary", "duration_ms", "started_at", "completed_at"]) {
    if (typeof receipt[key] === "string" || typeof receipt[key] === "number") allowed[key] = receipt[key];
  }
  return Object.keys(allowed).length === 0 ? undefined : allowed;
}
