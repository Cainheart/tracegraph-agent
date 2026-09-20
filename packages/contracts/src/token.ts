import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, NonEmptyStringSchema } from "./common.js";

const ProviderNameSchema = NonEmptyStringSchema.max(100);
const ModelNameSchema = NonEmptyStringSchema.max(200);
const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RatioSchema = z.number().finite().nonnegative().max(100);

export const TOKEN_CALIBRATION_FORMAT_VERSION = 1 as const;

export const TokenEstimateConfidenceSchema = z.enum(["exact", "calibrated", "estimated"]);
export type TokenEstimateConfidence = z.infer<typeof TokenEstimateConfidenceSchema>;

export const TokenUsageConfidenceSchema = z.literal("provider_reported");
export type TokenUsageConfidence = z.infer<typeof TokenUsageConfidenceSchema>;

/** Union for generic presentation code; concrete contracts use the narrower schemas above. */
export const TokenConfidenceSchema = z.union([TokenEstimateConfidenceSchema, TokenUsageConfidenceSchema]);
export type TokenConfidence = z.infer<typeof TokenConfidenceSchema>;

/** Shared six-way accounting vocabulary; Context re-exports this as its section schema. */
export const TokenSectionSchema = z.enum(["system", "goal", "history", "tool", "repo", "memory"]);
export type TokenSection = z.infer<typeof TokenSectionSchema>;

/** Exhaustive by design: every model-visible input token belongs to one section. */
export const TokenSectionCountsSchema = z.record(TokenSectionSchema, TokenCountSchema);
export type TokenSectionCounts = z.infer<typeof TokenSectionCountsSchema>;

export const TokenEstimateSchema = z.object({
  estimator_id: NonEmptyStringSchema.max(160),
  confidence: TokenEstimateConfidenceSchema,
  input_tokens: TokenCountSchema,
  output_tokens: TokenCountSchema,
  cached_tokens: TokenCountSchema.optional(),
  per_section: TokenSectionCountsSchema,
}).strict().superRefine((value, context) => {
  const sectionTotal = Object.values(value.per_section).reduce((total, count) => total + count, 0);
  if (sectionTotal !== value.input_tokens) {
    context.addIssue({
      code: "custom",
      path: ["per_section"],
      message: "per_section token counts must sum to input_tokens",
    });
  }
  if (value.cached_tokens !== undefined && value.cached_tokens > value.input_tokens) {
    context.addIssue({
      code: "custom",
      path: ["cached_tokens"],
      message: "cached_tokens must be a subset of input_tokens",
    });
  }
});
export type TokenEstimate = z.infer<typeof TokenEstimateSchema>;

export const ProviderReportedCostSchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
}).strict();
export type ProviderReportedCost = z.infer<typeof ProviderReportedCostSchema>;

/** Distinguishes the primary Decision call from repair and compaction calls. */
export const ModelRequestKindSchema = z.enum(["initial", "repair", "summary"]);
export type ModelRequestKind = z.infer<typeof ModelRequestKindSchema>;

/** Canonical provider response usage. Cached input is not added to total_tokens. */
export const ModelUsageReportSchema = z.object({
  provider: ProviderNameSchema,
  model: ModelNameSchema,
  input_tokens: TokenCountSchema,
  output_tokens: TokenCountSchema,
  cached_input_tokens: TokenCountSchema.optional(),
  reasoning_output_tokens: TokenCountSchema.optional(),
  total_tokens: TokenCountSchema,
  request_kind: ModelRequestKindSchema,
  request_sequence: z.number().int().positive().max(1_000),
  provider_reported_cost: ProviderReportedCostSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.total_tokens !== value.input_tokens + value.output_tokens) {
    context.addIssue({
      code: "custom",
      path: ["total_tokens"],
      message: "total_tokens must equal input_tokens plus output_tokens",
    });
  }
  if (value.cached_input_tokens !== undefined && value.cached_input_tokens > value.input_tokens) {
    context.addIssue({
      code: "custom",
      path: ["cached_input_tokens"],
      message: "cached_input_tokens must be a subset of input_tokens",
    });
  }
  if (value.reasoning_output_tokens !== undefined && value.reasoning_output_tokens > value.output_tokens) {
    context.addIssue({
      code: "custom",
      path: ["reasoning_output_tokens"],
      message: "reasoning_output_tokens must be a subset of output_tokens",
    });
  }
  if (value.request_kind === "initial" && value.request_sequence !== 1) {
    context.addIssue({
      code: "custom",
      path: ["request_sequence"],
      message: "initial model usage must use request_sequence 1",
    });
  }
  if (value.request_kind === "repair" && value.request_sequence <= 1) {
    context.addIssue({
      code: "custom",
      path: ["request_sequence"],
      message: "repair model usage must follow the initial request",
    });
  }
  if (value.request_kind === "summary" && value.request_sequence !== 1) {
    context.addIssue({
      code: "custom",
      path: ["request_sequence"],
      message: "summary model usage must use request_sequence 1",
    });
  }
});
export type ModelUsageReport = z.infer<typeof ModelUsageReportSchema>;

export const TokenMeterSectionSchema = z.object({
  section: TokenSectionSchema,
  content: z.string().max(16_000_000),
}).strict();
export type TokenMeterSection = z.infer<typeof TokenMeterSectionSchema>;

export const TokenMeterInputSchema = z.object({
  model_call_id: IdentifierSchema,
  provider: ProviderNameSchema,
  model: ModelNameSchema,
  content_revision: NonEmptyStringSchema.max(160),
  sections: z.array(TokenMeterSectionSchema).min(1).max(10_000),
  output_content: z.string().max(16_000_000).optional(),
}).strict();
export type TokenMeterInput = z.infer<typeof TokenMeterInputSchema>;

export const TokenUsageObservationSchema = z.object({
  model_call_id: IdentifierSchema,
  provider: ProviderNameSchema,
  model: ModelNameSchema,
  estimator_id: NonEmptyStringSchema.max(160),
  confidence: TokenUsageConfidenceSchema,
  input_tokens: TokenCountSchema,
  output_tokens: TokenCountSchema,
  cached_input_tokens: TokenCountSchema.optional(),
  reasoning_output_tokens: TokenCountSchema.optional(),
  total_tokens: TokenCountSchema,
  estimated_input_tokens: TokenCountSchema,
  delta_ratio: RatioSchema,
  anomaly: z.boolean(),
  calibration_applied: z.boolean(),
  calibration_revision: z.number().int().nonnegative(),
  request_kind: ModelRequestKindSchema,
  request_sequence: z.number().int().positive().max(1_000),
  provider_reported_cost: ProviderReportedCostSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.total_tokens !== value.input_tokens + value.output_tokens) {
    context.addIssue({
      code: "custom",
      path: ["total_tokens"],
      message: "total_tokens must equal input_tokens plus output_tokens",
    });
  }
  if (value.cached_input_tokens !== undefined && value.cached_input_tokens > value.input_tokens) {
    context.addIssue({
      code: "custom",
      path: ["cached_input_tokens"],
      message: "cached_input_tokens must be a subset of input_tokens",
    });
  }
  if (value.reasoning_output_tokens !== undefined && value.reasoning_output_tokens > value.output_tokens) {
    context.addIssue({
      code: "custom",
      path: ["reasoning_output_tokens"],
      message: "reasoning_output_tokens must be a subset of output_tokens",
    });
  }
  if (value.request_kind === "initial" && value.request_sequence !== 1) {
    context.addIssue({
      code: "custom",
      path: ["request_sequence"],
      message: "initial model usage must use request_sequence 1",
    });
  }
  if (value.request_kind === "repair" && value.request_sequence <= 1) {
    context.addIssue({
      code: "custom",
      path: ["request_sequence"],
      message: "repair model usage must follow the initial request",
    });
  }
  if (value.request_kind === "summary" && value.request_sequence !== 1) {
    context.addIssue({
      code: "custom",
      path: ["request_sequence"],
      message: "summary model usage must use request_sequence 1",
    });
  }
});
export type TokenUsageObservation = z.infer<typeof TokenUsageObservationSchema>;

export const TokenCalibrationSampleSchema = z.object({
  ratio: RatioSchema.positive(),
  observed_at: IsoDateTimeSchema,
}).strict();
export type TokenCalibrationSample = z.infer<typeof TokenCalibrationSampleSchema>;

export const TokenCalibrationEntrySchema = z.object({
  provider: ProviderNameSchema,
  model: ModelNameSchema,
  samples: z.array(TokenCalibrationSampleSchema).min(1).max(100),
}).strict();
export type TokenCalibrationEntry = z.infer<typeof TokenCalibrationEntrySchema>;

export const TokenCalibrationFileSchema = z.object({
  version: z.literal(TOKEN_CALIBRATION_FORMAT_VERSION),
  revision: z.number().int().nonnegative(),
  updated_at: IsoDateTimeSchema,
  entries: z.array(TokenCalibrationEntrySchema).max(1_000),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    const key = JSON.stringify([entry.provider, entry.model]);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index],
        message: "provider/model calibration entries must be unique",
      });
    }
    seen.add(key);
  });
});
export type TokenCalibrationFile = z.infer<typeof TokenCalibrationFileSchema>;
