/** Curated Core adapter for the public Evidence package. */
import {
  ArtifactStore as EvidenceArtifactStore,
  computeReplaySnapshotHash as evidenceComputeReplaySnapshotHash,
  EventInvariantError,
  JsonlEventLedger as EvidenceJsonlEventLedger,
  LedgerCorruptionError,
  projectRun as evidenceProjectRun,
  ProjectionError,
  replayDiffFromEvents as evidenceReplayDiffFromEvents,
  replaySnapshotFromEvents as evidenceReplaySnapshotFromEvents,
  ReplayError,
  toWireEvent as evidenceToWireEvent,
  type ArtifactStoreOptions as EvidenceArtifactStoreOptions,
  type EvidencePrimitives,
  type JsonlEventLedgerOptions as EvidenceJsonlEventLedgerOptions,
  type ProjectionPorts,
  type ReplayPorts,
} from "@tracegraph/evidence";
import type {
  ReplayDiff,
  ReplayDiffQuery,
  ReplaySnapshot,
  ReplaySnapshotRequest,
  SessionEvent,
  WireSessionEvent,
} from "@tracegraph/contracts";
import * as crypto from "../../kernel/crypto.js";
import { ActionWal, ActionWalError, RecoveryLedger } from "./action-wal.js";
import { AttachmentStore } from "./attachment.js";
import { projectTeam } from "../team/team.js";
import { projectTodos } from "../todo/todo.js";

const evidencePrimitives: EvidencePrimitives = {
  defaultIdFactory: crypto.defaultIdFactory,
  redactSensitiveText: crypto.redactSensitiveText,
  redactStructuredArtifactValue: crypto.redactStructuredArtifactValue,
  redactStructuredValue: crypto.redactStructuredValue,
  sha256: crypto.sha256,
  stableStringify: crypto.stableStringify,
};

const projectionPorts: ProjectionPorts = {
  redactSensitiveText: evidencePrimitives.redactSensitiveText,
  redactStructuredValue: evidencePrimitives.redactStructuredValue,
  projectTeam,
  projectTodos,
};

const replayPorts: ReplayPorts = {
  ...projectionPorts,
  sha256: evidencePrimitives.sha256,
  stableStringify: evidencePrimitives.stableStringify,
};

type JsonlEventLedgerOptions = Omit<EvidenceJsonlEventLedgerOptions, "primitives">;
type ArtifactStoreOptions = Omit<EvidenceArtifactStoreOptions, "primitives">;

/** Preserve the existing Core constructor while binding its canonical helpers. */
export class JsonlEventLedger extends EvidenceJsonlEventLedger {
  constructor(root: string, options: JsonlEventLedgerOptions = {}) {
    super(root, { ...options, primitives: evidencePrimitives });
  }
}

/** Preserve the existing Core constructor while binding its canonical helpers. */
export class ArtifactStore extends EvidenceArtifactStore {
  constructor(root: string, options: ArtifactStoreOptions = {}) {
    super(root, { ...options, primitives: evidencePrimitives });
  }
}

export function projectRun(events: readonly SessionEvent[]) {
  return evidenceProjectRun(events, projectionPorts);
}

export function toWireEvent(event: SessionEvent): WireSessionEvent {
  return evidenceToWireEvent(event, projectionPorts);
}

export function computeReplaySnapshotHash(input: Parameters<typeof evidenceComputeReplaySnapshotHash>[0]) {
  return evidenceComputeReplaySnapshotHash(input, replayPorts);
}

export function replaySnapshotFromEvents(
  events: readonly SessionEvent[],
  request: ReplaySnapshotRequest,
): ReplaySnapshot {
  return evidenceReplaySnapshotFromEvents(events, request, replayPorts);
}

export function replayDiffFromEvents(
  events: readonly SessionEvent[],
  query: ReplayDiffQuery,
): ReplayDiff {
  return evidenceReplayDiffFromEvents(events, query, replayPorts);
}

export {
  ActionWal,
  ActionWalError,
  AttachmentStore,
  EventInvariantError,
  LedgerCorruptionError,
  ProjectionError,
  RecoveryLedger,
  ReplayError,
};
export type {
  AtomicAppendResult,
  AtomicEventScope,
  BinaryArtifactReadResult,
} from "@tracegraph/evidence";
export type { AttachmentContent, StageAttachmentInput } from "./attachment.js";
export type { ReplayErrorCode } from "@tracegraph/evidence";
