import {
  SCHEMA_VERSION,
  SessionEventSchema,
  type ArtifactRef,
  type EventType,
  type SessionEvent,
} from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { projectRun } from "./projection.js";

const PNG_HASH = `sha256:${"a".repeat(64)}` as const;
const PDF_HASH = `sha256:${"b".repeat(64)}` as const;
const TEXT_HASH = `sha256:${"c".repeat(64)}` as const;

describe("G18 attachment projection", () => {
  it("defaults old ledgers to an empty attachment projection", () => {
    expect(projectRun([created(), event("run.started", 2, { phase: "conversation" })]).attachments)
      .toEqual({ items: [], last_sequence: 0 });
  });

  it("replays added, offloaded, extracted-PDF, and rejected facts without content bytes", () => {
    const png = artifact("artifact:png", "image/png", "image/png", 9, PNG_HASH);
    const pdf = artifact("artifact:pdf", "application/pdf", "application/pdf", 40, PDF_HASH);
    const text = artifact("artifact:pdf:text", "context_source_archive", "text/plain", 12, TEXT_HASH);
    const projection = projectRun([
      created(),
      event("attachment.added", 2, {
        upload_id: "upload:image",
        attachment: attachment("artifact:png", "image/png", 9, PNG_HASH),
        delivery: "offload",
        deduplicated: false,
        pdf_extraction: { status: "not_applicable" },
      }, [png]),
      event("attachment.offloaded", 3, {
        upload_id: "upload:image",
        attachment: attachment("artifact:png", "image/png", 9, PNG_HASH),
        reason: "default_policy",
        locator: "artifact:artifact:png",
      }, [png]),
      event("attachment.added", 4, {
        upload_id: "upload:pdf",
        attachment: {
          ...attachment("artifact:pdf", "application/pdf", 40, PDF_HASH),
          extracted_text_artifact_id: "artifact:pdf:text",
        },
        delivery: "offload",
        deduplicated: false,
        pdf_extraction: { status: "extracted", artifact_id: "artifact:pdf:text", characters: 12 },
      }, [pdf, text]),
      event("attachment.offloaded", 5, {
        upload_id: "upload:pdf",
        attachment: {
          ...attachment("artifact:pdf", "application/pdf", 40, PDF_HASH),
          extracted_text_artifact_id: "artifact:pdf:text",
        },
        reason: "pdf_reference",
        locator: "artifact:artifact:pdf",
      }, [pdf]),
      event("attachment.rejected", 6, {
        upload_id: "upload:bad",
        source: "user_upload",
        delivery: "inline",
        sniffed_media_type: "image/png",
        bytes: 9,
        code: "model_image_unsupported",
        reason: "Configured model does not declare image input capability",
      }),
    ]);

    expect(projection.attachments).toMatchObject({
      last_sequence: 6,
      items: [
        { upload_id: "upload:image", status: "offloaded", offload_reason: "default_policy" },
        {
          upload_id: "upload:pdf",
          status: "offloaded",
          offload_reason: "pdf_reference",
          pdf_extraction: { status: "extracted", artifact_id: "artifact:pdf:text" },
        },
        { upload_id: "upload:bad", status: "rejected", code: "model_image_unsupported" },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain("data_base64");
  });

  it("fails closed on missing Artifact proof, duplicate upload IDs, or an orphan offload", () => {
    const addedData = {
      upload_id: "upload:image",
      attachment: attachment("artifact:png", "image/png", 9, PNG_HASH),
      delivery: "offload",
      deduplicated: false,
      pdf_extraction: { status: "not_applicable" },
    };
    const png = artifact("artifact:png", "image/png", "image/png", 9, PNG_HASH);

    expect(() => projectRun([created(), event("attachment.added", 2, addedData)]))
      .toThrow("Artifact proof mismatch");
    expect(() => projectRun([
      created(),
      event("attachment.added", 2, addedData, [png]),
      event("attachment.added", 3, addedData, [png]),
    ])).toThrow("duplicate attachment upload_id");
    expect(() => projectRun([
      created(),
      event("attachment.offloaded", 2, {
        upload_id: "upload:image",
        attachment: attachment("artifact:png", "image/png", 9, PNG_HASH),
        reason: "default_policy",
        locator: "artifact:artifact:png",
      }, [png]),
    ])).toThrow("has no added upload");
    expect(() => projectRun([
      created(),
      event("run.started", 2, { phase: "conversation" }),
      event("attachment.rejected", 3, {
        upload_id: "upload:late",
        source: "user_upload",
        delivery: "offload",
        bytes: 0,
        code: "empty_file",
        reason: "Attachment is empty",
      }),
    ])).toThrow("attachment event follows run.started");
  });

  it("fails closed when extracted PDF text lacks a same-run text Artifact proof", () => {
    const pdf = artifact("artifact:pdf", "application/pdf", "application/pdf", 40, PDF_HASH);
    expect(() => projectRun([
      created(),
      event("attachment.added", 2, {
        upload_id: "upload:pdf",
        attachment: {
          ...attachment("artifact:pdf", "application/pdf", 40, PDF_HASH),
          extracted_text_artifact_id: "artifact:pdf:text",
        },
        delivery: "offload",
        deduplicated: false,
        pdf_extraction: { status: "extracted", artifact_id: "artifact:pdf:text", characters: 12 },
      }, [pdf]),
    ])).toThrow("extracted-text proof mismatch");
  });
});

function created(): SessionEvent {
  return event("run.created", 1, {
    task: "Inspect attachment",
    mode: "execute",
    workspace_kind: "disposable_fixture",
  });
}

function attachment(
  attachmentId: string,
  mediaType: "image/png" | "application/pdf",
  bytes: number,
  contentHash: string,
) {
  return {
    attachment_id: attachmentId,
    media_type: mediaType,
    bytes,
    sha256: contentHash,
    source: "user_upload" as const,
  };
}

function artifact(
  artifactId: string,
  kind: ArtifactRef["kind"],
  mimeType: string,
  byteLength: number,
  contentHash: string,
): ArtifactRef {
  return {
    artifact_id: artifactId,
    project_id: "project:g18",
    run_id: "run:g18",
    kind,
    mime_type: mimeType,
    byte_length: byteLength,
    content_hash: contentHash,
    created_at: "2026-09-19T12:00:00.000Z",
  };
}

function event(
  type: EventType,
  sequence: number,
  data: Record<string, unknown>,
  artifactRefs: readonly ArtifactRef[] = [],
): SessionEvent {
  return SessionEventSchema.parse({
    schema_version: SCHEMA_VERSION,
    event_id: `event:${sequence}`,
    project_id: "project:g18",
    run_id: "run:g18",
    session_id: "session:g18",
    sequence,
    occurred_at: `2026-09-19T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    attempt: 0,
    type,
    summary: type,
    artifact_refs: artifactRefs,
    event_hash: PNG_HASH,
    data,
  });
}
