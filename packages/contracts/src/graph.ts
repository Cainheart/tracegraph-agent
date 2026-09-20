import { z } from "zod";
import {
  ArtifactRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
  Sha256Schema,
} from "./common.js";

export const GraphNodeSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(["file", "directory", "module"]),
  label: NonEmptyStringSchema,
  file_path: RelativePathSchema.optional(),
  line: z.number().int().positive().optional(),
  content_hash: Sha256Schema.optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(["static_import", "static_export"]),
  source_node_id: IdentifierSchema,
  target_node_id: IdentifierSchema,
  file_path: RelativePathSchema,
  line: z.number().int().positive().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  resolution: z.enum(["resolved", "partial", "unknown"]),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSnapshotSchema = z.object({
  snapshot_id: IdentifierSchema,
  project_id: IdentifierSchema,
  workspace_hash: Sha256Schema,
  created_at: IsoDateTimeSchema,
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  diagnostics: z.array(z.object({ file_path: RelativePathSchema.optional(), message: NonEmptyStringSchema } )).default([]),
  artifact_ref: ArtifactRefSchema.optional(),
}).superRefine((snapshot, context) => {
  const nodeIds = new Set<string>();
  for (const [index, node] of snapshot.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate graph node id: ${node.id}`,
        path: ["nodes", index, "id"],
      });
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const [index, edge] of snapshot.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate graph edge id: ${edge.id}`,
        path: ["edges", index, "id"],
      });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source_node_id)) {
      context.addIssue({
        code: "custom",
        message: `graph edge source does not exist: ${edge.source_node_id}`,
        path: ["edges", index, "source_node_id"],
      });
    }
    if (!nodeIds.has(edge.target_node_id)) {
      context.addIssue({
        code: "custom",
        message: `graph edge target does not exist: ${edge.target_node_id}`,
        path: ["edges", index, "target_node_id"],
      });
    }
  }
});
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

export const GraphChangeSchema = z.enum(["added", "removed", "changed", "unknown", "partial"]);
export const GraphNodeDeltaSchema = z.object({
  change: GraphChangeSchema,
  before: GraphNodeSchema.optional(),
  after: GraphNodeSchema.optional(),
}).superRefine(validateDeltaShape);
export type GraphNodeDelta = z.infer<typeof GraphNodeDeltaSchema>;

export const GraphEdgeDeltaSchema = z.object({
  change: GraphChangeSchema,
  before: GraphEdgeSchema.optional(),
  after: GraphEdgeSchema.optional(),
}).superRefine(validateDeltaShape);
export type GraphEdgeDelta = z.infer<typeof GraphEdgeDeltaSchema>;

export const GraphDeltaSchema = z.object({
  graph_delta_id: IdentifierSchema,
  project_id: IdentifierSchema,
  base_snapshot_id: IdentifierSchema,
  result_snapshot_id: IdentifierSchema,
  patch_event_id: IdentifierSchema.optional(),
  created_at: IsoDateTimeSchema,
  node_changes: z.array(GraphNodeDeltaSchema),
  edge_changes: z.array(GraphEdgeDeltaSchema),
  artifact_ref: ArtifactRefSchema.optional(),
});
export type GraphDelta = z.infer<typeof GraphDeltaSchema>;

function validateDeltaShape(
  value: {
    change: z.infer<typeof GraphChangeSchema>;
    before?: { id: string } | undefined;
    after?: { id: string } | undefined;
  },
  context: z.RefinementCtx,
): void {
  const addIssue = (message: string, path: (string | number)[] = []) => {
    context.addIssue({ code: "custom", message, path });
  };

  if (value.change === "added") {
    if (value.after === undefined) addIssue("added graph change requires after", ["after"]);
    if (value.before !== undefined) addIssue("added graph change cannot include before", ["before"]);
  } else if (value.change === "removed") {
    if (value.before === undefined) addIssue("removed graph change requires before", ["before"]);
    if (value.after !== undefined) addIssue("removed graph change cannot include after", ["after"]);
  } else if (value.change === "changed") {
    if (value.before === undefined) addIssue("changed graph change requires before", ["before"]);
    if (value.after === undefined) addIssue("changed graph change requires after", ["after"]);
  } else if (value.before === undefined && value.after === undefined) {
    addIssue(`${value.change} graph change requires before or after`);
  }

  if (value.before !== undefined && value.after !== undefined && value.before.id !== value.after.id) {
    addIssue("before and after must describe the same graph entity");
  }
}
