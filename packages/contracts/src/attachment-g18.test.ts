import { describe, expect, it } from "vitest";
import {
  AcceptedAttachmentStageReceiptSchema,
  AttachmentAddedDataSchema,
  AttachmentOffloadedDataSchema,
  AttachmentUploadIdsSchema,
  EventTypeSchema,
  MAX_ATTACHMENT_BYTES,
  ModelImageInputSchema,
  RunProjectionSchema,
} from "./index.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

describe("G18 attachment contracts", () => {
  it("keeps staging receipts opaque and rejects leaked scope fields", () => {
    const receipt = {
      status: "accepted",
      upload_id: "upload:test",
      source: "user_upload",
      delivery: "offload",
      bytes: 9,
      expires_at: "2026-09-19T12:15:00.000Z",
      media_type: "image/png",
      sha256: HASH,
    } as const;
    expect(AcceptedAttachmentStageReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => AcceptedAttachmentStageReceiptSchema.parse({
      ...receipt,
      project_id: "project:hidden-chat",
    })).toThrow();
    expect(() => AcceptedAttachmentStageReceiptSchema.parse({
      ...receipt,
      session_id: "session:private",
    })).toThrow();
  });

  it("bounds each Run to eight unique opaque upload ids", () => {
    expect(AttachmentUploadIdsSchema.parse(
      Array.from({ length: 8 }, (_, index) => `upload:${index}`),
    )).toHaveLength(8);
    expect(() => AttachmentUploadIdsSchema.parse(
      Array.from({ length: 9 }, (_, index) => `upload:${index}`),
    )).toThrow();
    expect(() => AttachmentUploadIdsSchema.parse(["upload:one", "upload:one"])).toThrow();
  });

  it("enforces media, delivery, extraction, and offload consistency", () => {
    const image = attachment("image/png");
    expect(() => AttachmentAddedDataSchema.parse({
      upload_id: "upload:image",
      attachment: image,
      delivery: "offload",
      deduplicated: false,
      pdf_extraction: { status: "failed", code: "bad", reason: "bad", fallback: "reference_only" },
    })).toThrow("image attachments cannot carry PDF extraction state");

    const pdf = attachment("application/pdf");
    expect(() => AttachmentAddedDataSchema.parse({
      upload_id: "upload:pdf",
      attachment: pdf,
      delivery: "inline",
      deduplicated: false,
      pdf_extraction: { status: "failed", code: "bad", reason: "bad", fallback: "reference_only" },
    })).toThrow("PDF attachments must be offloaded");
    expect(() => AttachmentOffloadedDataSchema.parse({
      upload_id: "upload:pdf",
      attachment: pdf,
      reason: "default_policy",
      locator: "artifact:attachment:test",
    })).toThrow("PDF offload must use pdf_reference");
  });

  it("admits only canonical bounded image blocks", () => {
    const image = attachment("image/png");
    expect(ModelImageInputSchema.parse({
      attachment: image,
      data_base64: "cG5nLWJ5dGVz",
    }).attachment.media_type).toBe("image/png");
    expect(() => ModelImageInputSchema.parse({ attachment: image, data_base64: "not base64" })).toThrow();
    const oversizedBase64 = "AAAA".repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1) / 3));
    expect(() => ModelImageInputSchema.parse({ attachment: image, data_base64: oversizedBase64 })).toThrow();
    expect(() => ModelImageInputSchema.parse({
      attachment: attachment("application/pdf"),
      data_base64: "cGRm",
    })).toThrow();
  });

  it("appends all three lifecycle event types", () => {
    expect(EventTypeSchema.parse("attachment.added")).toBe("attachment.added");
    expect(EventTypeSchema.parse("attachment.rejected")).toBe("attachment.rejected");
    expect(EventTypeSchema.parse("attachment.offloaded")).toBe("attachment.offloaded");
    expect(EventTypeSchema.options).toHaveLength(102);
  });

  it("defaults old projection payloads to an empty attachment list", () => {
    const projection = RunProjectionSchema.parse({
      schema_version: "tracegraph.session-event.v1",
      projector_version: "tracegraph.projector.v9",
      project_id: "project:test",
      run_id: "run:test",
      task: "Legacy replay",
      mode: "execute",
      reasoning_effort: "default",
      workspace_kind: "managed_local",
      status: "created",
      last_sequence: 1,
      timeline: [],
      todos: { items: [], last_sequence: 1 },
      input_queue: { pending: [] },
      subagents: {
        items: [],
        active_count: 0,
        last_sequence: 1,
        limits: { max_parallel_subagents: 2, max_depth: 1 },
      },
      artifact_refs: [],
    });
    expect(projection.attachments).toEqual({ items: [], last_sequence: 0 });
  });
});

function attachment(mediaType: "image/png" | "application/pdf") {
  return {
    attachment_id: "attachment:test",
    media_type: mediaType,
    bytes: 9,
    sha256: HASH,
    source: "user_upload" as const,
  };
}
