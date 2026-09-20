import {
  REPLAY_DIFF_VERSION,
  REPLAY_SNAPSHOT_VERSION,
  ReplayDiffQuerySchema,
  ReplayDiffSchema,
  ReplaySnapshotRequestSchema,
  ReplaySnapshotSchema,
  isTerminalEventType,
  type ArtifactRef,
  type ReplayDiff,
  type ReplayDiffQuery,
  type ReplaySnapshot,
  type ReplaySnapshotRequest,
  type SessionEvent,
  type TodoItem,
  type WireSessionEvent,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "./crypto.js";
import { projectRun } from "./projection.js";

export type ReplayErrorCode =
  | "run_not_found"
  | "replay_scope_mismatch"
  | "replay_sequence_out_of_range"
  | "replay_source_invalid";

export class ReplayError extends Error {
  readonly code: ReplayErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: ReplayErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ReplayError";
    this.code = code;
    this.details = details;
  }
}

type ReplayHashInput = Pick<
  ReplaySnapshot,
  | "schema_version"
  | "session_id"
  | "project_id"
  | "run_id"
  | "until_sequence"
  | "anchor_event_id"
  | "anchor_event_hash"
  | "projection"
>;

/**
 * Hash only immutable canonical state. In particular, the observed ledger
 * head and Host-issued replay authority never affect a historical snapshot.
 */
export function computeReplaySnapshotHash(input: ReplayHashInput): `sha256:${string}` {
  return sha256(stableStringify({
    schema_version: input.schema_version,
    session_id: input.session_id,
    project_id: input.project_id,
    run_id: input.run_id,
    until_sequence: input.until_sequence,
    anchor_event_id: input.anchor_event_id,
    anchor_event_hash: input.anchor_event_hash,
    projection: input.projection,
  }));
}

/** Build a sequence-bounded projection from one already-read canonical ledger. */
export function replaySnapshotFromEvents(
  eventsInput: readonly SessionEvent[],
  requestInput: ReplaySnapshotRequest,
): ReplaySnapshot {
  const request = ReplaySnapshotRequestSchema.parse(requestInput);
  const events = validateReplaySource(eventsInput, request.session_id, request.run_id);
  const headSequence = events.at(-1)!.sequence;
  if (request.until_sequence > headSequence) {
    throw new ReplayError(
      "replay_sequence_out_of_range",
      `Replay sequence ${request.until_sequence} exceeds the current Run head`,
      { requested_sequence: request.until_sequence, head_sequence: headSequence },
    );
  }

  // validateReplaySource proves the list is contiguous and one-based, so an
  // array prefix is exactly the inclusive sequence boundary requested here.
  const prefix = events.slice(0, request.until_sequence);
  const anchor = prefix.at(-1);
  if (anchor === undefined || anchor.sequence !== request.until_sequence) {
    throw new ReplayError(
      "replay_source_invalid",
      "Canonical replay source does not contain the requested sequence",
    );
  }
  const projection = projectRun(prefix);
  const canonical = {
    schema_version: REPLAY_SNAPSHOT_VERSION,
    session_id: request.session_id,
    project_id: events[0]!.project_id,
    run_id: request.run_id,
    until_sequence: request.until_sequence,
    anchor_event_id: anchor.event_id,
    anchor_event_hash: anchor.event_hash,
    projection,
  } satisfies ReplayHashInput;

  return ReplaySnapshotSchema.parse({
    ...canonical,
    head_sequence: headSequence,
    snapshot_hash: computeReplaySnapshotHash(canonical),
  });
}

/**
 * Diff two replay coordinates from one immutable in-memory ledger read. This
 * prevents concurrent appends from giving the endpoints different heads.
 */
export function replayDiffFromEvents(
  eventsInput: readonly SessionEvent[],
  queryInput: ReplayDiffQuery,
): ReplayDiff {
  const query = ReplayDiffQuerySchema.parse(queryInput);
  const events = validateReplaySource(eventsInput, query.session_id, query.run_id);
  const from = replaySnapshotFromEvents(events, {
    session_id: query.session_id,
    run_id: query.run_id,
    until_sequence: query.from,
  });
  const to = replaySnapshotFromEvents(events, {
    session_id: query.session_id,
    run_id: query.run_id,
    until_sequence: query.to,
  });
  const eventDiff = diffByIdentity(
    from.projection.timeline,
    to.projection.timeline,
    (event) => event.event_id,
  );
  const evidence = diffArtifacts(from.projection.artifact_refs, to.projection.artifact_refs);
  const todos = diffTodos(from.projection.todos.items, to.projection.todos.items);
  const approvalChanged = !sameValue(
    from.projection.pending_approval,
    to.projection.pending_approval,
  );
  const pendingPlanChanged = !sameValue(
    from.projection.pending_plan,
    to.projection.pending_plan,
  );

  return ReplayDiffSchema.parse({
    schema_version: REPLAY_DIFF_VERSION,
    session_id: query.session_id,
    project_id: from.project_id,
    run_id: query.run_id,
    head_sequence: from.head_sequence,
    from_sequence: query.from,
    to_sequence: query.to,
    direction: query.from === query.to ? "same" : query.from < query.to ? "forward" : "backward",
    from_snapshot_hash: from.snapshot_hash,
    to_snapshot_hash: to.snapshot_hash,
    events: eventDiff,
    evidence,
    tool_results: {
      added: eventDiff.added.filter(isToolResultEvent),
      removed: eventDiff.removed.filter(isToolResultEvent),
    },
    todos,
    approval: {
      changed: approvalChanged,
      ...(from.projection.pending_approval === undefined
        ? {}
        : { before: from.projection.pending_approval }),
      ...(to.projection.pending_approval === undefined
        ? {}
        : { after: to.projection.pending_approval }),
    },
    pending_plan: {
      changed: pendingPlanChanged,
      ...(from.projection.pending_plan === undefined ? {} : { before: from.projection.pending_plan }),
      ...(to.projection.pending_plan === undefined ? {} : { after: to.projection.pending_plan }),
    },
    ...(from.projection.status === to.projection.status
      ? {}
      : { status: { before: from.projection.status, after: to.projection.status } }),
    ...(from.projection.mode === to.projection.mode
      ? {}
      : { mode: { before: from.projection.mode, after: to.projection.mode } }),
  });
}

function validateReplaySource(
  eventsInput: readonly SessionEvent[],
  sessionId: string,
  runId: string,
): readonly SessionEvent[] {
  if (eventsInput.length === 0) {
    throw new ReplayError("run_not_found", "Run is unavailable");
  }
  const events = [...eventsInput];
  const first = events[0]!;
  if (first.type !== "run.created") {
    throw new ReplayError("replay_source_invalid", "Replay source must begin with run.created");
  }
  if (first.run_id !== runId || first.session_id !== sessionId) {
    throw new ReplayError(
      "replay_scope_mismatch",
      "Run is outside the requested durable session scope",
    );
  }

  let terminalCount = 0;
  const eventIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw new ReplayError(
        "replay_source_invalid",
        `Replay source sequence is not contiguous at ${event.sequence}`,
      );
    }
    if (
      event.run_id !== first.run_id
      || event.project_id !== first.project_id
      || event.session_id !== sessionId
    ) {
      throw new ReplayError(
        "replay_scope_mismatch",
        `Replay source changes scope at sequence ${event.sequence}`,
      );
    }
    if (eventIds.has(event.event_id)) {
      throw new ReplayError(
        "replay_source_invalid",
        `Replay source repeats event_id at sequence ${event.sequence}`,
      );
    }
    eventIds.add(event.event_id);
    const { event_hash: eventHash, ...body } = event;
    if (sha256(stableStringify(body)) !== eventHash) {
      throw new ReplayError(
        "replay_source_invalid",
        `Replay source hash mismatch at sequence ${event.sequence}`,
      );
    }
    const previous = events[index - 1];
    if (previous === undefined && event.previous_event_hash !== undefined) {
      throw new ReplayError(
        "replay_source_invalid",
        "Replay source root event must not reference a previous event",
      );
    }
    if (previous !== undefined && event.previous_event_hash !== previous.event_hash) {
      throw new ReplayError(
        "replay_source_invalid",
        `Replay source hash chain is broken at sequence ${event.sequence}`,
      );
    }
    if (isTerminalEventType(event.type)) terminalCount += 1;
  }
  if (terminalCount > 1) {
    throw new ReplayError("replay_source_invalid", "Replay source contains multiple terminal events");
  }
  return events;
}

function diffByIdentity<T>(
  before: readonly T[],
  after: readonly T[],
  identity: (value: T) => string,
): { added: T[]; removed: T[] } {
  const beforeIds = new Set(before.map(identity));
  const afterIds = new Set(after.map(identity));
  return {
    added: after.filter((value) => !beforeIds.has(identity(value))),
    removed: before.filter((value) => !afterIds.has(identity(value))),
  };
}

function diffArtifacts(
  before: readonly ArtifactRef[],
  after: readonly ArtifactRef[],
): ReplayDiff["evidence"] {
  const beforeById = new Map(before.map((artifact) => [artifact.artifact_id, artifact]));
  const afterById = new Map(after.map((artifact) => [artifact.artifact_id, artifact]));
  return {
    added: after.filter((artifact) => !beforeById.has(artifact.artifact_id)),
    removed: before.filter((artifact) => !afterById.has(artifact.artifact_id)),
    changed: after.flatMap((artifact) => {
      const previous = beforeById.get(artifact.artifact_id);
      return previous !== undefined && !sameValue(previous, artifact)
        ? [{ artifact_id: artifact.artifact_id, before: previous, after: artifact }]
        : [];
    }),
  };
}

function diffTodos(
  before: readonly TodoItem[],
  after: readonly TodoItem[],
): ReplayDiff["todos"] {
  const beforeById = new Map(before.map((todo) => [todo.todo_id, todo]));
  const afterById = new Map(after.map((todo) => [todo.todo_id, todo]));
  return {
    added: after.filter((todo) => !beforeById.has(todo.todo_id)),
    removed: before.filter((todo) => !afterById.has(todo.todo_id)),
    changed: after.flatMap((todo) => {
      const previous = beforeById.get(todo.todo_id);
      return previous !== undefined && !sameValue(previous, todo)
        ? [{ todo_id: todo.todo_id, before: previous, after: todo }]
        : [];
    }),
  };
}

function isToolResultEvent(event: WireSessionEvent): boolean {
  return event.type === "tool.completed"
    || event.type === "tool.failed"
    || event.type === "tool.unknown";
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
