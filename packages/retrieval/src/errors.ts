export type RetrievalErrorCode =
  | "invalid_project_id"
  | "invalid_source_path"
  | "invalid_content"
  | "invalid_query"
  | "invalid_top_k"
  | "invalid_chunk"
  | "invalid_data_dir"
  | "unsafe_path"
  | "index_too_large"
  | "index_corrupt"
  | "project_scope_mismatch"
  | "io_failed";

export class RetrievalError extends Error {
  constructor(
    readonly code: RetrievalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RetrievalError";
  }
}
