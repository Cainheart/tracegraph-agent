import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  type ModelAdapter,
  type ModelInput,
} from "../../packages/core/dist/index.js";
import {
  DecisionSchema,
  MAX_ATTACHMENT_BYTES,
  type ModelCapabilities,
} from "../../packages/contracts/dist/index.js";
import {
  createFailingTypescriptFixture,
  createTemporaryDataDir,
} from "../../packages/test-support/dist/index.js";
import { eventIndex, startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: attachments and multimodal input", () => {
  it("recovers a staged >5 MiB rejection and records it before Run/model execution", async () => {
    const fixture = await createFailingTypescriptFixture("eval-attachment-oversized");
    const data = await createTemporaryDataDir();
    try {
      const stagingRuntime = await createAgentRuntime({
        dataDir: data.path,
        model: new CapturingFinishModel(false),
      });
      const staged = await stagingRuntime.stageAttachment({
        commandId: "command:eval:attachment-oversized-upload",
        projectId: fixture.handle.project_id,
        declaredMediaType: "image/png",
        bytes: oversizedPng(),
      });
      expect(staged).toMatchObject({ status: "rejected", code: "too_large" });

      // A fresh Runtime proves that the rejected receipt is durable rather than
      // being an in-memory result passed directly from staging to claim.
      const model = new CapturingFinishModel(false);
      const runtime = await createAgentRuntime({ dataDir: data.path, model });
      const started = await runtime.startRun({
        ...startEvalInput(
          fixture.handle,
          "attachment-oversized",
          "Verify the durable oversized Attachment rejection.",
        ),
        attachment_upload_ids: [staged.upload_id],
      });
      const completed = await waitForEvalStatus(runtime, started.run_id, "completed");

      expect(completed.attachments.items).toEqual([
        expect.objectContaining({
          status: "rejected",
          code: "too_large",
          upload_id: staged.upload_id,
        }),
      ]);
      expect(eventIndex(completed, "run.created"))
        .toBeLessThan(eventIndex(completed, "attachment.rejected"));
      expect(eventIndex(completed, "attachment.rejected"))
        .toBeLessThan(eventIndex(completed, "run.started"));
      expect(eventIndex(completed, "run.started"))
        .toBeLessThan(eventIndex(completed, "model.request_started"));
      expect(model.inputs[0]?.images).toBeUndefined();
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });

  it("emits zero image blocks when explicit inline delivery lacks model capability", async () => {
    const fixture = await createFailingTypescriptFixture("eval-attachment-unsupported-image");
    const data = await createTemporaryDataDir();
    try {
      const model = new CapturingFinishModel(false);
      const runtime = await createAgentRuntime({ dataDir: data.path, model });
      const staged = await runtime.stageAttachment({
        commandId: "command:eval:attachment-unsupported-image-upload",
        projectId: fixture.handle.project_id,
        declaredMediaType: "image/png",
        delivery: "inline",
        bytes: png(),
      });
      expect(staged.status).toBe("accepted");

      const started = await runtime.startRun({
        ...startEvalInput(
          fixture.handle,
          "attachment-unsupported-image",
          "Verify fail-closed handling for unsupported image input.",
        ),
        attachment_upload_ids: [staged.upload_id],
      });
      const completed = await waitForEvalStatus(runtime, started.run_id, "completed");

      expect(completed.attachments.items).toEqual([
        expect.objectContaining({
          status: "rejected",
          code: "model_image_unsupported",
          upload_id: staged.upload_id,
        }),
      ]);
      expect(completed.timeline.some(({ type }) => type === "attachment.added")).toBe(false);
      expect(model.inputs).toHaveLength(1);
      expect(model.inputs[0]?.images).toBeUndefined();
      expect(JSON.stringify(completed.timeline)).not.toContain(
        Buffer.from(png()).toString("base64"),
      );
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });

  it("makes PDF extraction failure an explicit reference-only fallback", async () => {
    const fixture = await createFailingTypescriptFixture("eval-attachment-pdf-fallback");
    const data = await createTemporaryDataDir();
    try {
      const model = new CapturingFinishModel(true);
      const runtime = await createAgentRuntime({ dataDir: data.path, model });
      const staged = await runtime.stageAttachment({
        commandId: "command:eval:attachment-pdf-fallback-upload",
        projectId: fixture.handle.project_id,
        declaredMediaType: "application/pdf",
        bytes: minimalPdfWithoutExtractableText(),
      });
      expect(staged.status).toBe("accepted");

      const started = await runtime.startRun({
        ...startEvalInput(
          fixture.handle,
          "attachment-pdf-fallback",
          "Verify explicit reference-only fallback for a non-extractable PDF.",
        ),
        attachment_upload_ids: [staged.upload_id],
      });
      const completed = await waitForEvalStatus(runtime, started.run_id, "completed");

      expect(completed.attachments.items).toEqual([
        expect.objectContaining({
          status: "offloaded",
          offload_reason: "pdf_reference",
          pdf_extraction: {
            status: "failed",
            code: "pdf_text_extraction_failed",
            fallback: "reference_only",
            reason: expect.any(String),
          },
        }),
      ]);
      expect(eventIndex(completed, "attachment.added"))
        .toBeLessThan(eventIndex(completed, "attachment.offloaded"));
      expect(model.inputs[0]?.images).toBeUndefined();
      expect(model.inputs[0]?.observations).toEqual([
        expect.objectContaining({
          facts: expect.objectContaining({
            kind: "attachment",
            media_type: "application/pdf",
            pdf_extraction: expect.objectContaining({
              status: "failed",
              fallback: "reference_only",
            }),
          }),
        }),
      ]);
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });
});

class CapturingFinishModel implements ModelAdapter {
  readonly name = "g18-eval-capturing-model";
  readonly inputs: ModelInput[] = [];

  constructor(readonly imageInput: boolean) {}

  capabilities(): ModelCapabilities {
    return { image_input: this.imageInput };
  }

  async decide(input: ModelInput): Promise<unknown> {
    this.inputs.push(input);
    return DecisionSchema.parse({
      decision_id: `decision:g18-eval:${this.inputs.length}`,
      kind: "finish",
      public_reason: "The bounded G18 evaluation observed the attachment contract.",
      evidence_refs: [],
      risk: "none",
      final_answer: "done",
    });
  }
}

function png(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

function oversizedPng(): Uint8Array {
  const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  bytes.set(png());
  return bytes;
}

function minimalPdfWithoutExtractableText(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
}
