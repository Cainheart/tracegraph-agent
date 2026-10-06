import { z } from "zod";
import { IdentifierSchema } from "./common.js";

export const ModelProbeKindSchema = z.enum(["text", "tools", "image", "structured"]);
export type ModelProbeKind = z.infer<typeof ModelProbeKindSchema>;
export const ModelCapabilityTestRequestSchema = z.object({
  command_id: IdentifierSchema,
  expected_revision: z.number().int().nonnegative(),
  model: z.string().trim().min(1).max(200),
  features: z.array(ModelProbeKindSchema).min(1).max(4),
  confirmed: z.literal(true),
}).strict().refine(value => new Set(value.features).size === value.features.length, { message: "Probe kinds must be unique" });
export type ModelCapabilityTestRequest = z.infer<typeof ModelCapabilityTestRequestSchema>;
export const ModelProbeUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(), cached_input_tokens: z.number().int().nonnegative().optional(),
  cost: z.object({ amount: z.number().finite().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict().optional(),
}).strict().refine(value => value.input_tokens + value.output_tokens === value.total_tokens && (value.cached_input_tokens ?? 0) <= value.input_tokens, { message: "Inconsistent usage" });
export const ModelProbeResultSchema = z.object({
  feature: ModelProbeKindSchema, status: z.enum(["passed", "failed", "unsupported", "unknown"]),
  code: z.string().regex(/^[a-z0-9_]+$/u).max(100), duration_ms: z.number().int().nonnegative(),
  dispatched: z.boolean(), usage_status: z.enum(["reported", "unknown"]), usage: ModelProbeUsageSchema.optional(),
  evidence: z.enum(["exact_text", "native_tool_call", "image_fixture_answer", "native_json_schema"]).optional(),
}).strict().refine(value => (value.usage_status === "reported") === (value.usage !== undefined), { message: "Usage status must match evidence" }).refine(value => value.status !== "passed" || value.dispatched && value.evidence === ({ text: "exact_text", tools: "native_tool_call", image: "image_fixture_answer", structured: "native_json_schema" } as const)[value.feature], { message: "Passed tests require their actual evidence kind" }).refine(value => value.status !== "unsupported" || !value.dispatched, { message: "Unimplemented formats cannot dispatch" });
export type ModelProbeResult = z.infer<typeof ModelProbeResultSchema>;
export const ModelCapabilityTestResultSchema = z.object({
  command_id: IdentifierSchema, connection_id: IdentifierSchema, connection_revision: z.number().int().nonnegative(),
  model: z.string().min(1).max(200), provider: z.string().max(100), protocol: z.enum(["openai-chat-completions", "anthropic-messages"]),
  checked_at: z.iso.datetime({ offset: true }), duration_ms: z.number().int().nonnegative(), results: z.array(ModelProbeResultSchema).min(1).max(4),
}).strict();
export type ModelCapabilityTestResult = z.infer<typeof ModelCapabilityTestResultSchema>;
export const ModelCapabilityTestReceiptSchema = z.object({
  command_id: IdentifierSchema, state: z.enum(["not_found", "unknown", "failed", "completed"]),
  code: z.string().max(100).optional(), result: ModelCapabilityTestResultSchema.optional(),
}).strict();
export type ModelCapabilityTestReceipt = z.infer<typeof ModelCapabilityTestReceiptSchema>;
