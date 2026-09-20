import { GraphDeltaSchema } from "@tracegraph/contracts";

import { sha256, stableJson } from "./hash.js";
import type {
  DiffGraphOptions,
  GraphChangeKind,
  GraphDelta,
  GraphEdge,
  GraphEdgeDelta,
  GraphNode,
  GraphNodeDelta,
  GraphSnapshot,
} from "./types.js";

export function diffGraphSnapshots(
  before: GraphSnapshot,
  after: GraphSnapshot,
  options: DiffGraphOptions = {},
): GraphDelta {
  if (before.project_id !== after.project_id) {
    throw new Error(
      `cannot diff snapshots from different projects: ${before.project_id} !== ${after.project_id}`,
    );
  }

  const nodeChanges = diffById(before.nodes, after.nodes, classifyNodeChange);
  const edgeChanges = diffById(before.edges, after.edges, classifyEdgeChange);
  const createdAt = validateCreatedAt(options.created_at);
  const deltaIdentity = {
    base_snapshot_id: before.snapshot_id,
    edge_changes: edgeChanges,
    node_changes: nodeChanges,
    patch_event_id: options.patch_event_id,
    project_id: before.project_id,
    result_snapshot_id: after.snapshot_id,
  };

  return GraphDeltaSchema.parse({
    graph_delta_id: `graph_delta:${sha256(stableJson(deltaIdentity))}`,
    project_id: before.project_id,
    base_snapshot_id: before.snapshot_id,
    result_snapshot_id: after.snapshot_id,
    ...(options.patch_event_id === undefined
      ? {}
      : { patch_event_id: options.patch_event_id }),
    created_at: createdAt,
    node_changes: nodeChanges,
    edge_changes: edgeChanges,
  });
}

function diffById<T extends { readonly id: string }, D>(
  beforeItems: readonly T[],
  afterItems: readonly T[],
  classify: (before: T | undefined, after: T | undefined) => D | undefined,
): D[] {
  const beforeById = new Map(beforeItems.map((item) => [item.id, item]));
  const afterById = new Map(afterItems.map((item) => [item.id, item]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const changes: D[] = [];
  for (const id of [...ids].sort()) {
    const change = classify(beforeById.get(id), afterById.get(id));
    if (change !== undefined) {
      changes.push(change);
    }
  }
  return changes;
}

function classifyNodeChange(
  before: GraphNode | undefined,
  after: GraphNode | undefined,
): GraphNodeDelta | undefined {
  if (before === undefined && after !== undefined) {
    return { change: "added", after };
  }
  if (before !== undefined && after === undefined) {
    return { change: "removed", before };
  }
  if (before === undefined || after === undefined || stableJson(before) === stableJson(after)) {
    return undefined;
  }
  return { change: "changed", before, after };
}

function classifyEdgeChange(
  before: GraphEdge | undefined,
  after: GraphEdge | undefined,
): GraphEdgeDelta | undefined {
  if (before === undefined && after !== undefined) {
    return { change: certaintyChange(after), after };
  }
  if (before !== undefined && after === undefined) {
    return { change: "removed", before };
  }
  if (before === undefined || after === undefined || stableJson(before) === stableJson(after)) {
    return undefined;
  }
  const certainty = weakestCertainty(before, after);
  return { change: certainty ?? "changed", before, after };
}

function certaintyChange(edge: GraphEdge): GraphChangeKind {
  if (edge.resolution === "unknown") {
    return "unknown";
  }
  if (edge.resolution === "partial") {
    return "partial";
  }
  return "added";
}

function weakestCertainty(before: GraphEdge, after: GraphEdge): GraphChangeKind | undefined {
  if (before.resolution === "unknown" || after.resolution === "unknown") {
    return "unknown";
  }
  if (before.resolution === "partial" || after.resolution === "partial") {
    return "partial";
  }
  return undefined;
}

function validateCreatedAt(createdAt: string | undefined): string {
  if (createdAt === undefined) {
    return new Date().toISOString();
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`created_at must be an ISO timestamp: ${createdAt}`);
  }
  return createdAt;
}
