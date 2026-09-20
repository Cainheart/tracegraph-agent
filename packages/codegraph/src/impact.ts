import type {
  GraphEdge,
  GraphSnapshot,
  ImpactNeighborhood,
  ImpactNode,
} from "./types.js";

export function getImpactNeighborhood(
  snapshot: GraphSnapshot,
  originNodeId: string,
  options: {
    readonly direction?: "upstream" | "downstream" | "both";
    readonly max_depth?: 1 | 2;
  } = {},
): ImpactNeighborhood {
  const direction = options.direction ?? "upstream";
  const maxDepth = options.max_depth ?? 2;
  if (maxDepth !== 1 && maxDepth !== 2) {
    throw new Error("max_depth must be 1 or 2");
  }
  if (direction !== "upstream" && direction !== "downstream" && direction !== "both") {
    throw new Error("direction must be upstream, downstream, or both");
  }
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(originNodeId)) {
    throw new Error(`graph node does not exist: ${originNodeId}`);
  }

  const selectedEdges = new Map<string, GraphEdge>();
  const depthByNodeId = new Map<string, number>([[originNodeId, 0]]);
  let frontier = [originNodeId];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const edge of snapshot.edges) {
        const neighbor = neighborFor(edge, nodeId, direction);
        if (neighbor === undefined) {
          continue;
        }
        selectedEdges.set(edge.id, edge);
        if (!depthByNodeId.has(neighbor)) {
          depthByNodeId.set(neighbor, depth);
          next.add(neighbor);
        }
      }
    }
    frontier = [...next];
  }

  const nodes: ImpactNode[] = [...depthByNodeId.entries()]
    .map(([nodeId, depth]) => ({ node: nodeById.get(nodeId), depth }))
    .filter((item): item is ImpactNode => item.node !== undefined)
    .sort((left, right) => left.depth - right.depth || left.node.id.localeCompare(right.node.id));

  return {
    origin_node_id: originNodeId,
    direction,
    max_depth: maxDepth,
    nodes,
    edges: [...selectedEdges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function neighborFor(
  edge: GraphEdge,
  nodeId: string,
  direction: "upstream" | "downstream" | "both",
): string | undefined {
  if ((direction === "upstream" || direction === "both") && edge.target_node_id === nodeId) {
    return edge.source_node_id;
  }
  if ((direction === "downstream" || direction === "both") && edge.source_node_id === nodeId) {
    return edge.target_node_id;
  }
  return undefined;
}
