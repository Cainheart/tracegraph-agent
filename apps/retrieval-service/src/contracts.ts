import { z } from "zod";

export const RETRIEVAL_SERVICE_SCHEMA_VERSION = "tracegraph.retrieval-service.v1" as const;
export const RETRIEVAL_SERVICE_ERROR_SCHEMA_VERSION = "tracegraph.retrieval-service.error.v1" as const;

const ProjectIdSchema = z.string()
  .min(1)
  .max(160)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "project_id must be a bounded identifier without control characters",
  });

const isSafeSourcePath = (value: string): boolean => {
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.length > 0
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

export const SourcePathSchema = z.string()
  .min(1)
  .max(2_048)
  .refine(isSafeSourcePath, "source_path must be a canonical workspace-relative path");

export const RetrievalIngestRequestSchema = z.strictObject({
  project_id: ProjectIdSchema,
  source_path: SourcePathSchema,
  content: z.string().max(8 * 1_048_576),
});

export const RetrievalSearchRequestSchema = z.strictObject({
  project_id: ProjectIdSchema,
  query: z.string().min(1).max(2_000).refine((value) => (
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
  ), "query must contain bounded text without control characters"),
  top_k: z.number().int().min(1).max(100).optional(),
});

const ContentHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const SafeLabelSchema = z.string().min(1).max(128).refine(
  (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
  "label must not contain control characters",
);

export const RetrievalIndexUpdateSchema = z.strictObject({
  schema_version: z.literal("tracegraph.retrieval.v1"),
  project_id: ProjectIdSchema,
  source_path: SourcePathSchema,
  document_hash: ContentHashSchema,
  status: z.enum(["updated", "unchanged"]),
  generation: z.number().int().nonnegative(),
  source_chunk_count: z.number().int().nonnegative(),
  total_indexed_chunks: z.number().int().nonnegative(),
});

export const RetrievalSearchHitSchema = z.strictObject({
  rank: z.number().int().positive(),
  chunk_id: z.string().regex(/^chunk:[a-f0-9]{64}$/u),
  content_hash: ContentHashSchema,
  score: z.number().finite().nonnegative(),
  source_path: SourcePathSchema,
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  heading_path: z.array(z.string().min(1).max(500)).max(6),
  content: z.string().max(64_000),
}).refine((value) => value.end_line >= value.start_line, {
  message: "end_line must not precede start_line",
  path: ["end_line"],
});

export const RetrievalSearchResponseSchema = z.strictObject({
  schema_version: z.literal("tracegraph.retrieval.v1"),
  project_id: ProjectIdSchema,
  query_hash: ContentHashSchema,
  total_indexed_chunks: z.number().int().nonnegative(),
  hits: z.array(RetrievalSearchHitSchema).max(100),
});

export const RetrievalServiceHealthSchema = z.strictObject({
  schema_version: z.literal(RETRIEVAL_SERVICE_SCHEMA_VERSION),
  status: z.literal("ok"),
  backend: SafeLabelSchema,
  embedding_provider: SafeLabelSchema.nullable(),
});

export const RetrievalServiceErrorSchema = z.strictObject({
  schema_version: z.literal(RETRIEVAL_SERVICE_ERROR_SCHEMA_VERSION),
  error: z.string().min(1).max(128),
  message: z.string().min(1).max(1_024),
  issues: z.array(z.strictObject({
    code: z.string().min(1).max(128),
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string().min(1).max(512),
  })).max(64).optional(),
});

export type RetrievalIngestRequest = z.infer<typeof RetrievalIngestRequestSchema>;
export type RetrievalSearchRequest = z.infer<typeof RetrievalSearchRequestSchema>;
export type RetrievalIndexUpdate = z.infer<typeof RetrievalIndexUpdateSchema>;
export type RetrievalSearchHit = z.infer<typeof RetrievalSearchHitSchema>;
export type RetrievalSearchResponse = z.infer<typeof RetrievalSearchResponseSchema>;
export type RetrievalServiceHealth = z.infer<typeof RetrievalServiceHealthSchema>;
export type RetrievalServiceErrorBody = z.infer<typeof RetrievalServiceErrorSchema>;
