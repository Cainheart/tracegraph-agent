import { z } from "zod";
import type { RawToolResult } from "./types.js";

/** Runtime output boundary shared by Core Tool definitions and seam adapters. */
export const RawToolResultSchema = z.object({
  status: z.enum(["success", "failure", "unknown"]),
  // Keep the shared result envelope compatible with ToolBatchResultSchema.
  code: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(2_000),
  content: z.string().optional(),
  mimeType: z.string().trim().min(1).max(160).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
}).strict() satisfies z.ZodType<RawToolResult>;
