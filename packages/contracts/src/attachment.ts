import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.js";

/** Product limit. Transport layers may use a slightly larger hard cap. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_RUN = 8;

export const AttachmentMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "application/pdf",
]);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>;

export const ImageAttachmentMediaTypeSchema = z.enum(["image/png", "image/jpeg"]);
export type ImageAttachmentMediaType = z.infer<typeof ImageAttachmentMediaTypeSchema>;

export const AttachmentSourceSchema = z.enum(["user_upload", "tool_output"]);
export type AttachmentSource = z.infer<typeof AttachmentSourceSchema>;

/** Offload is the safe default. Inline must represent an explicit user intent. */
export const AttachmentDeliverySchema = z.enum(["offload", "inline"]);
export type AttachmentDelivery = z.infer<typeof AttachmentDeliverySchema>;

export const AttachmentRefSchema = z.object({
  attachment_id: IdentifierSchema,
  media_type: AttachmentMediaTypeSchema,
  bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: Sha256Schema,
  extracted_text_artifact_id: IdentifierSchema.optional(),
  source: AttachmentSourceSchema,
}).strict().superRefine((value, context) => {
  if (value.media_type !== "application/pdf" && value.extracted_text_artifact_id !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["extracted_text_artifact_id"],
      message: "only PDF attachments may reference extracted text",
    });
  }
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const ModelCapabilitiesSchema = z.object({
  image_input: z.boolean(),
}).strict();
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

const AttachmentUploadRequestBaseShape = {
  command_id: IdentifierSchema,
  session_id: IdentifierSchema.optional(),
  declared_media_type: NonEmptyStringSchema.max(100),
  delivery: AttachmentDeliverySchema.default("offload"),
};

/** Browser metadata only. The Host resolves both branches to its own project capability. */
export const AttachmentUploadRequestSchema = z.discriminatedUnion("target", [
  z.object({
    ...AttachmentUploadRequestBaseShape,
    target: z.literal("project"),
    project_id: IdentifierSchema,
  }).strict(),
  z.object({
    ...AttachmentUploadRequestBaseShape,
    target: z.literal("chat"),
  }).strict(),
]);
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequestSchema>;

export const AttachmentUploadIdsSchema = IdentifierSchema.array()
  .max(MAX_ATTACHMENTS_PER_RUN)
  .refine((items) => new Set(items).size === items.length, {
    message: "attachment upload IDs must be unique",
  });

export const AttachmentRejectionCodeSchema = z.enum([
  "empty_file",
  "too_large",
  "unsupported_media_type",
  "media_type_mismatch",
  "upload_expired",
  "upload_already_claimed",
  "upload_scope_mismatch",
  "upload_corrupt",
  "model_image_unsupported",
  "inline_not_supported",
]);
export type AttachmentRejectionCode = z.infer<typeof AttachmentRejectionCodeSchema>;

const AttachmentStageBaseSchema = z.object({
  upload_id: IdentifierSchema,
  source: AttachmentSourceSchema,
  delivery: AttachmentDeliverySchema,
  bytes: z.number().int().nonnegative(),
  expires_at: IsoDateTimeSchema,
}).strict();

export const AcceptedAttachmentStageReceiptSchema = AttachmentStageBaseSchema.extend({
  status: z.literal("accepted"),
  media_type: AttachmentMediaTypeSchema,
  sha256: Sha256Schema,
}).strict();
export type AcceptedAttachmentStageReceipt = z.infer<typeof AcceptedAttachmentStageReceiptSchema>;

export const RejectedAttachmentStageReceiptSchema = AttachmentStageBaseSchema.extend({
  status: z.literal("rejected"),
  declared_media_type: NonEmptyStringSchema.max(100),
  sniffed_media_type: AttachmentMediaTypeSchema.optional(),
  code: AttachmentRejectionCodeSchema.exclude([
    "upload_expired",
    "upload_already_claimed",
    "upload_scope_mismatch",
    "upload_corrupt",
    "model_image_unsupported",
  ]),
  reason: NonEmptyStringSchema.max(500),
}).strict();
export type RejectedAttachmentStageReceipt = z.infer<typeof RejectedAttachmentStageReceiptSchema>;

export const AttachmentStageReceiptSchema = z.discriminatedUnion("status", [
  AcceptedAttachmentStageReceiptSchema,
  RejectedAttachmentStageReceiptSchema,
]);
export type AttachmentStageReceipt = z.infer<typeof AttachmentStageReceiptSchema>;

export const PdfExtractionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_applicable") }).strict(),
  z.object({
    status: z.literal("extracted"),
    artifact_id: IdentifierSchema,
    characters: z.number().int().positive().max(2_000_000),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    code: NonEmptyStringSchema.max(100),
    reason: NonEmptyStringSchema.max(500),
    fallback: z.literal("reference_only"),
  }).strict(),
]);
export type PdfExtractionResult = z.infer<typeof PdfExtractionResultSchema>;

export const AttachmentAddedDataSchema = z.object({
  upload_id: IdentifierSchema,
  attachment: AttachmentRefSchema,
  delivery: AttachmentDeliverySchema,
  deduplicated: z.boolean(),
  pdf_extraction: PdfExtractionResultSchema,
}).strict().superRefine((value, context) => {
  const isPdf = value.attachment.media_type === "application/pdf";
  if (isPdf && value.delivery !== "offload") {
    context.addIssue({ code: "custom", path: ["delivery"], message: "PDF attachments must be offloaded" });
  }
  if (!isPdf && value.pdf_extraction.status !== "not_applicable") {
    context.addIssue({ code: "custom", path: ["pdf_extraction"], message: "image attachments cannot carry PDF extraction state" });
  }
  if (isPdf && value.pdf_extraction.status === "not_applicable") {
    context.addIssue({ code: "custom", path: ["pdf_extraction"], message: "PDF attachments require an extraction result" });
  }
  if (
    value.pdf_extraction.status === "extracted"
    && value.attachment.extracted_text_artifact_id !== value.pdf_extraction.artifact_id
  ) {
    context.addIssue({
      code: "custom",
      path: ["attachment", "extracted_text_artifact_id"],
      message: "extracted PDF text Artifact IDs must match",
    });
  }
  if (
    value.pdf_extraction.status === "failed"
    && value.attachment.extracted_text_artifact_id !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["attachment", "extracted_text_artifact_id"],
      message: "failed PDF extraction cannot expose a text Artifact",
    });
  }
});
export type AttachmentAddedData = z.infer<typeof AttachmentAddedDataSchema>;

export const AttachmentRejectedDataSchema = z.object({
  upload_id: IdentifierSchema,
  source: AttachmentSourceSchema,
  delivery: AttachmentDeliverySchema,
  declared_media_type: NonEmptyStringSchema.max(100).optional(),
  sniffed_media_type: AttachmentMediaTypeSchema.optional(),
  bytes: z.number().int().nonnegative(),
  code: AttachmentRejectionCodeSchema,
  reason: NonEmptyStringSchema.max(500),
}).strict();
export type AttachmentRejectedData = z.infer<typeof AttachmentRejectedDataSchema>;

export const AttachmentOffloadedDataSchema = z.object({
  upload_id: IdentifierSchema,
  attachment: AttachmentRefSchema,
  reason: z.enum(["default_policy", "pdf_reference", "context_compaction"]),
  locator: NonEmptyStringSchema.max(200),
}).strict().superRefine((value, context) => {
  if (value.locator !== `artifact:${value.attachment.attachment_id}`) {
    context.addIssue({
      code: "custom",
      path: ["locator"],
      message: "attachment locator must equal artifact:<attachment_id>",
    });
  }
  if (value.reason === "pdf_reference" && value.attachment.media_type !== "application/pdf") {
    context.addIssue({ code: "custom", path: ["reason"], message: "pdf_reference requires a PDF attachment" });
  }
  if (value.attachment.media_type === "application/pdf" && value.reason === "default_policy") {
    context.addIssue({ code: "custom", path: ["reason"], message: "PDF offload must use pdf_reference" });
  }
});
export type AttachmentOffloadedData = z.infer<typeof AttachmentOffloadedDataSchema>;

export const AttachmentProjectionItemSchema = z.discriminatedUnion("status", [
  AttachmentAddedDataSchema.safeExtend({
    status: z.enum(["added", "offloaded"]),
    offload_reason: AttachmentOffloadedDataSchema.shape.reason.optional(),
  }).strict(),
  AttachmentRejectedDataSchema.extend({ status: z.literal("rejected") }).strict(),
]).superRefine((value, context) => {
  if (value.status === "offloaded" && value.offload_reason === undefined) {
    context.addIssue({ code: "custom", path: ["offload_reason"], message: "offloaded attachments require a reason" });
  }
  if (value.status === "added" && value.offload_reason !== undefined) {
    context.addIssue({ code: "custom", path: ["offload_reason"], message: "non-offloaded attachments cannot carry an offload reason" });
  }
});
export type AttachmentProjectionItem = z.infer<typeof AttachmentProjectionItemSchema>;

export const AttachmentListProjectionSchema = z.object({
  items: z.array(AttachmentProjectionItemSchema).max(MAX_ATTACHMENTS_PER_RUN),
  last_sequence: z.number().int().nonnegative(),
}).strict();
export type AttachmentListProjection = z.infer<typeof AttachmentListProjectionSchema>;

export const ModelImageInputSchema = z.object({
  attachment: AttachmentRefSchema.safeExtend({
    media_type: ImageAttachmentMediaTypeSchema,
  }).strict(),
  data_base64: NonEmptyStringSchema
    .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
    .refine((value) => {
      const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
      const decodedBytes = (value.length / 4) * 3 - padding;
      return decodedBytes > 0 && decodedBytes <= MAX_ATTACHMENT_BYTES;
    }, { message: "image base64 must decode to between 1 byte and the attachment limit" }),
}).strict();
export type ModelImageInput = z.infer<typeof ModelImageInputSchema>;
