import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@tracegraph/contracts";
import { ArtifactStore } from "./artifact-store.js";
import { AttachmentStore, AttachmentStoreError } from "./attachment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AttachmentStore", () => {
  it("stages idempotently, offloads by default, and replays a same-Run claim", async () => {
    const harness = await setup("idempotent");
    const bytes = pngBytes("same bytes");
    const first = await harness.store.stageAttachment(stageInput("command:one", bytes));
    const retried = await harness.store.stageAttachment(stageInput("command:one", bytes));
    expect(retried).toEqual(first);

    const claimed = await harness.store.claimAttachment(claimInput(first.upload_id));
    expect(claimed).toMatchObject({
      status: "accepted",
      added: { delivery: "offload", deduplicated: false },
      offloaded: { upload_id: first.upload_id, reason: "default_policy" },
    });
    if (claimed.status !== "accepted") throw new Error("expected accepted claim");
    expect(claimed.modelImage).toBeUndefined();
    expect(claimed.added.attachment.sha256).toBe(first.status === "accepted" ? first.sha256 : "");
    const content = await harness.store.getContent({
      attachmentId: claimed.added.attachment.attachment_id,
      projectId: "project:one",
      runId: "run:one",
    });
    expect(Buffer.from(content.bytes)).toEqual(Buffer.from(bytes));

    const replayed = await harness.store.claimAttachment(claimInput(first.upload_id));
    expect(replayed).toEqual(claimed);
    await expect(access(stagedDataPath(harness.root, first.upload_id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically publishes staged bytes across concurrent store instances", async () => {
    const harness = await setup("atomic-stage");
    const peer = new AttachmentStore(join(harness.root, "attachments"), {
      artifacts: harness.artifacts,
    });
    await peer.initialize();
    const bytes = pngBytes("x".repeat(MAX_ATTACHMENT_BYTES - 8));
    const input = stageInput("command:atomic-stage", bytes);

    const receipts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? harness.store : peer).stageAttachment(input)),
    );

    expect(new Set(receipts.map((receipt) => JSON.stringify(receipt)))).toHaveLength(1);
  });

  it("rejects command rebinding and keeps scope mismatch from consuming the upload", async () => {
    const harness = await setup("scope");
    const receipt = await harness.store.stageAttachment({
      ...stageInput("command:scope", pngBytes("scope")),
      sessionId: "session:allowed",
    });
    await expect(harness.store.stageAttachment({
      ...stageInput("command:scope", pngBytes("different")),
      sessionId: "session:allowed",
    })).rejects.toMatchObject<Partial<AttachmentStoreError>>({ code: "upload_command_conflict" });

    await expect(harness.store.claimAttachment({
      ...claimInput(receipt.upload_id),
      sessionId: "session:wrong",
    })).resolves.toMatchObject({
      status: "rejected",
      rejected: { code: "upload_scope_mismatch", bytes: 0 },
    });
    await expect(harness.store.claimAttachment({
      ...claimInput(receipt.upload_id),
      sessionId: "session:allowed",
    })).resolves.toMatchObject({ status: "accepted" });
  });

  it("returns durable rejected receipts for size, magic, and PDF-inline violations", async () => {
    const harness = await setup("rejections");
    const oversized = await harness.store.stageAttachment(
      stageInput("command:large", new Uint8Array(MAX_ATTACHMENT_BYTES + 1)),
    );
    expect(oversized).toMatchObject({ status: "rejected", code: "too_large", bytes: MAX_ATTACHMENT_BYTES + 1 });
    await expect(harness.store.claimAttachment(claimInput(oversized.upload_id))).resolves.toMatchObject({
      status: "rejected",
      rejected: { code: "too_large" },
    });

    const mismatch = await harness.store.stageAttachment({
      ...stageInput("command:mismatch", jpegBytes()),
      declaredMediaType: "image/png",
    });
    expect(mismatch).toMatchObject({
      status: "rejected",
      code: "media_type_mismatch",
      sniffed_media_type: "image/jpeg",
    });

    const truncatedJpeg = await harness.store.stageAttachment({
      ...stageInput("command:truncated-jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01])),
      declaredMediaType: "image/jpeg",
    });
    expect(truncatedJpeg).toMatchObject({ status: "rejected", code: "unsupported_media_type" });

    const inlinePdf = await harness.store.stageAttachment({
      ...stageInput("command:inline-pdf", pdfBytes("hello")),
      declaredMediaType: "application/pdf",
      delivery: "inline",
    });
    expect(inlinePdf).toMatchObject({ status: "rejected", code: "inline_not_supported" });
  });

  it("expires staged uploads and keeps the rejection stable across retries", async () => {
    let current = Date.parse("2026-09-19T00:00:00.000Z");
    const harness = await setup("expiry", { now: () => new Date(current), stageTtlMs: 1_000 });
    const receipt = await harness.store.stageAttachment(stageInput("command:expiry", pngBytes("expires")));
    current += 1_001;
    const rejected = await harness.store.claimAttachment(claimInput(receipt.upload_id));
    expect(rejected).toMatchObject({ status: "rejected", rejected: { code: "upload_expired" } });
    await expect(harness.store.claimAttachment(claimInput(receipt.upload_id))).resolves.toEqual(rejected);
  });

  it("serializes concurrent identical hashes and preserves deduplication after restart", async () => {
    const harness = await setup("dedup");
    const bytes = pngBytes("deduplicate me");
    const firstReceipt = await harness.store.stageAttachment(stageInput("command:dedup-1", bytes));
    const secondReceipt = await harness.store.stageAttachment(stageInput("command:dedup-2", bytes));
    const concurrent = await Promise.all([
      harness.store.claimAttachment(claimInput(firstReceipt.upload_id)),
      harness.store.claimAttachment(claimInput(secondReceipt.upload_id)),
    ]);
    const accepted = concurrent.filter((result) => result.status === "accepted");
    expect(accepted).toHaveLength(2);
    if (accepted.length !== 2) throw new Error("expected accepted concurrent claims");
    expect(accepted.map((result) => result.added.deduplicated).sort()).toEqual([false, true]);
    expect(new Set(accepted.map((result) => result.added.attachment.attachment_id)).size).toBe(1);

    const restarted = new AttachmentStore(join(harness.root, "attachments"), {
      artifacts: harness.artifacts,
    });
    const thirdReceipt = await restarted.stageAttachment(stageInput("command:dedup-3", bytes));
    const third = await restarted.claimAttachment(claimInput(thirdReceipt.upload_id));
    expect(third).toMatchObject({ status: "accepted", added: { deduplicated: true } });
    if (third.status !== "accepted") throw new Error("expected accepted third claim");
    expect(third.added.attachment.attachment_id).toBe(accepted[0]!.added.attachment.attachment_id);
    expect(third.artifactRefs).toEqual(accepted[0]!.artifactRefs);
  });

  it("gates explicit inline images on declared model capability", async () => {
    const unsupportedHarness = await setup("unsupported-image");
    const unsupportedReceipt = await unsupportedHarness.store.stageAttachment({
      ...stageInput("command:inline-unsupported", pngBytes("image")),
      delivery: "inline",
    });
    await expect(unsupportedHarness.store.claimAttachment({
      ...claimInput(unsupportedReceipt.upload_id),
      modelCapabilities: { image_input: false },
    })).resolves.toMatchObject({
      status: "rejected",
      rejected: { code: "model_image_unsupported" },
    });

    const supportedHarness = await setup("supported-image");
    const bytes = pngBytes("image");
    const supportedReceipt = await supportedHarness.store.stageAttachment({
      ...stageInput("command:inline-supported", bytes),
      delivery: "inline",
    });
    const supported = await supportedHarness.store.claimAttachment({
      ...claimInput(supportedReceipt.upload_id),
      modelCapabilities: { image_input: true },
    });
    expect(supported).toMatchObject({
      status: "accepted",
      added: { delivery: "inline" },
      modelImage: { data_base64: Buffer.from(bytes).toString("base64") },
    });
    if (supported.status !== "accepted") throw new Error("expected inline image");
    expect(supported.offloaded).toBeUndefined();

    const offloadThenInline = await supportedHarness.store.stageAttachment({
      ...stageInput("command:inline-after-offload", bytes),
      delivery: "offload",
    });
    await expect(supportedHarness.store.claimAttachment({
      ...claimInput(offloadThenInline.upload_id),
      runId: "run:second",
      modelCapabilities: { image_input: true },
    })).resolves.toMatchObject({ status: "accepted", added: { delivery: "offload" } });
    const inlineDuplicate = await supportedHarness.store.stageAttachment({
      ...stageInput("command:inline-deduplicated", bytes),
      delivery: "inline",
    });
    await expect(supportedHarness.store.claimAttachment({
      ...claimInput(inlineDuplicate.upload_id),
      runId: "run:second",
      modelCapabilities: { image_input: true },
    })).resolves.toMatchObject({
      status: "accepted",
      added: { delivery: "inline", deduplicated: true },
      modelImage: { data_base64: Buffer.from(bytes).toString("base64") },
    });
  });

  it("records explicit PDF extraction fallback without losing the original", async () => {
    const harness = await setup("pdf-fallback", {
      pdfExtractor: async () => { throw new Error("parser internals must not escape"); },
    });
    const bytes = pdfBytes("unextractable");
    const receipt = await harness.store.stageAttachment({
      ...stageInput("command:pdf-fallback", bytes),
      declaredMediaType: "application/pdf",
    });
    const claimed = await harness.store.claimAttachment(claimInput(receipt.upload_id));
    expect(claimed).toMatchObject({
      status: "accepted",
      added: {
        attachment: { media_type: "application/pdf" },
        pdf_extraction: {
          status: "failed",
          code: "pdf_text_extraction_failed",
          fallback: "reference_only",
        },
      },
      offloaded: { reason: "pdf_reference" },
    });
    if (claimed.status !== "accepted") throw new Error("expected accepted PDF fallback");
    expect(claimed.artifactRefs).toHaveLength(1);
    await expect(harness.store.getContent({
      attachmentId: claimed.added.attachment.attachment_id,
      projectId: "project:one",
      runId: "run:one",
    })).resolves.toMatchObject({ bytes: expect.any(Uint8Array) });
  });

  it("stores extracted PDF text as a separate Artifact", async () => {
    const harness = await setup("pdf-text", { pdfExtractor: async () => "Extracted evidence" });
    const receipt = await harness.store.stageAttachment({
      ...stageInput("command:pdf-text", pdfBytes("source")),
      declaredMediaType: "application/pdf",
    });
    const claimed = await harness.store.claimAttachment(claimInput(receipt.upload_id));
    expect(claimed).toMatchObject({
      status: "accepted",
      added: { pdf_extraction: { status: "extracted", characters: 18 } },
      artifactRefs: [{ kind: "application/pdf" }, { kind: "context_source_archive", mime_type: "text/plain" }],
    });
  });

  it("detects staged-byte corruption instead of forwarding a forged image", async () => {
    const harness = await setup("corrupt");
    const receipt = await harness.store.stageAttachment(stageInput("command:corrupt", pngBytes("valid")));
    await writeFile(
      join(harness.root, "attachments", "staging", `${receipt.upload_id.replace(/[^A-Za-z0-9_.-]/gu, "_")}.data`),
      pngBytes("tampered"),
    );
    await expect(harness.store.claimAttachment(claimInput(receipt.upload_id))).resolves.toMatchObject({
      status: "rejected",
      rejected: { code: "upload_corrupt" },
    });
  });
});

async function setup(
  name: string,
  options: {
    now?: () => Date;
    stageTtlMs?: number;
    pdfExtractor?: (bytes: Uint8Array) => Promise<string>;
  } = {},
): Promise<{ root: string; artifacts: ArtifactStore; store: AttachmentStore }> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-attachment-${name}-`));
  roots.push(root);
  const artifacts = new ArtifactStore(join(root, "artifacts"), {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const store = new AttachmentStore(join(root, "attachments"), {
    artifacts,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.stageTtlMs === undefined ? {} : { stageTtlMs: options.stageTtlMs }),
    ...(options.pdfExtractor === undefined ? {} : { pdfExtractor: options.pdfExtractor }),
  });
  await store.initialize();
  return { root, artifacts, store };
}

function stageInput(commandId: string, bytes: Uint8Array) {
  return {
    commandId,
    projectId: "project:one",
    declaredMediaType: "image/png",
    bytes,
  };
}

function claimInput(uploadId: string) {
  return {
    uploadId,
    projectId: "project:one",
    runId: "run:one",
    modelCapabilities: { image_input: false },
  };
}

function pngBytes(suffix: string): Uint8Array {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(suffix, "utf8"),
  ]);
}

function jpegBytes(): Uint8Array {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

function pdfBytes(text: string): Uint8Array {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nstream\nBT (${text}) Tj ET\nendstream\nendobj\n%%EOF`, "latin1");
}

function stagedDataPath(root: string, uploadId: string): string {
  return join(root, "attachments", "staging", `${uploadId.replace(/[^A-Za-z0-9_.-]/gu, "_")}.data`);
}
