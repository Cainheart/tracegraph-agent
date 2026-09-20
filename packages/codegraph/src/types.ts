import type {
  GraphDelta,
  GraphEdge,
  GraphEdgeDelta,
  GraphNode,
  GraphNodeDelta,
  GraphSnapshot,
} from "@tracegraph/contracts";

export type {
  GraphDelta,
  GraphEdge,
  GraphEdgeDelta,
  GraphNode,
  GraphNodeDelta,
  GraphSnapshot,
} from "@tracegraph/contracts";

export type GraphNodeKind = GraphNode["kind"];
export type GraphEdgeKind = GraphEdge["kind"];
export type GraphConfidence = GraphEdge["confidence"];
export type GraphResolution = GraphEdge["resolution"];
export type GraphChangeKind = GraphNodeDelta["change"];

export type CodeGraphDiagnosticCode =
  | "ambiguous_static_module"
  | "commonjs_require_partial"
  | "commonjs_require_unsupported"
  | "dynamic_import_unsupported"
  | "external_module_partial"
  | "file_read_failed"
  | "invalid_tsconfig"
  | "static_module_unresolved"
  | "typescript_parse_failed";

export interface CodeGraphDiagnostic {
  readonly code: CodeGraphDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly file_path?: string;
  readonly line?: number;
}

export interface CodeGraphCoverage {
  readonly status: "complete" | "partial";
  readonly indexed_file_count: number;
  readonly skipped_dynamic_import_count: number;
  readonly skipped_commonjs_require_count: number;
  readonly unresolved_static_edge_count: number;
  readonly partial_static_edge_count: number;
}

export type CodeGraphAnalysisFailureCode =
  | "analysis_aborted"
  | "analysis_byte_limit_exceeded"
  | "analysis_deadline_exceeded"
  | "analysis_depth_limit_exceeded"
  | "analysis_file_limit_exceeded"
  | "analysis_file_too_large"
  | "analysis_invalid_limit"
  | "analysis_no_readable_files"
  | "analysis_unsafe_source_file"
  | "typescript_analysis_failed";

export interface CodeGraphAnalysis {
  readonly snapshot: GraphSnapshot;
  readonly diagnostics: readonly CodeGraphDiagnostic[];
  readonly coverage: CodeGraphCoverage;
}

export interface AnalyzeCodeGraphOptions {
  readonly workspace_root: string;
  readonly project_id: string;
  readonly created_at?: string;
  readonly tsconfig_path?: string;
  readonly exclude_directories?: readonly string[];
  readonly signal?: AbortSignal;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxDepth?: number;
  readonly deadlineMs?: number;
}

export interface DiffGraphOptions {
  readonly created_at?: string;
  readonly patch_event_id?: string;
}

export interface ImpactNode {
  readonly node: GraphNode;
  readonly depth: number;
}

export interface ImpactNeighborhood {
  readonly origin_node_id: string;
  readonly direction: "upstream" | "downstream" | "both";
  readonly max_depth: 1 | 2;
  readonly nodes: readonly ImpactNode[];
  readonly edges: readonly GraphEdge[];
}
