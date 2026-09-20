import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AcceptedAttachmentStageReceiptSchema,
  AttachmentAddedDataSchema,
  AttachmentDeliverySchema,
  AttachmentMediaTypeSchema,
  AttachmentOffloadedDataSchema,
  AttachmentRefSchema,
  AttachmentRejectedDataSchema,
  AttachmentStageReceiptSchema,
  ArtifactRefSchema,
  IdentifierSchema,
  MAX_ATTACHMENT_BYTES,
  ModelCapabilitiesSchema,
  ModelImageInputSchema,
  PdfExtractionResultSchema,
  RejectedAttachmentStageReceiptSchema,
  Sha256Schema,
  type AttachmentAddedData,
  type AttachmentDelivery,
  type AttachmentMediaType,
  type AttachmentOffloadedData,
  type AttachmentRef,
  type AttachmentRejectedData,
  type AttachmentSource,
  type AttachmentStageReceipt,
  type ModelCapabilities,
  type ModelImageInput,
} from "@tracegraph/contracts";
import { ArtifactStore } from "./artifact-store.js";
import {
  defaultIdFactory,
  redactSensitiveText,
  sha256,
  stableStringify,
} from "./crypto.js";

const STAGING_FORMAT_VERSION = 1 as const;
const DEFAULT_STAGE_TTL_MS = 15 * 60 * 1_000;
const MAX_EXTRACTED_PDF_CHARACTERS = 200_000;

const InternalStagingRecordSchema = z.object({
  version: z.literal(STAGING_FORMAT_VERSION),
  command_id: IdentifierSchema,
  project_id: IdentifierSchema,
  session_id: IdentifierSchema.optional(),
  signature: Sha256Schema,
  receipt: AttachmentStageReceiptSchema,
}).strict();
type InternalStagingRecord = z.infer<typeof InternalStagingRecordSchema>;

const DurableIngestRecordSchema = z.object({
  added: AttachmentAddedDataSchema,
  artifact_refs: z.array(ArtifactRefSchema).min(1).max(2),
}).strict();

const DurableClaimResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    added: AttachmentAddedDataSchema,
    offloaded: AttachmentOffloadedDataSchema.optional(),
    artifact_refs: z.array(ArtifactRefSchema).min(1).max(2),
    inline: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    rejected: AttachmentRejectedDataSchema,
  }).strict(),
]);
type DurableClaimResult = z.infer<typeof DurableClaimResultSchema>;

const ClaimOwnerSchema = z.object({
  run_id: IdentifierSchema,
}).strict();

export interface StageAttachmentInput {
  commandId: string;
  projectId: string;
  sessionId?: string;
  declaredMediaType: string;
  delivery?: AttachmentDelivery;
  bytes: Uint8Array;
  /** Host-owned. Browser routes must always force user_upload. */
  source?: AttachmentSource;
}

export interface ClaimAttachmentInput {
  uploadId: string;
  projectId: string;
  sessionId?: string;
  runId: string;
  modelCapabilities: ModelCapabilities;
}

export type AttachmentClaimResult =
  | {
    status: "accepted";
    added: AttachmentAddedData;
    offloaded?: AttachmentOffloadedData;
    artifactRefs: AttachmentArtifactRef[];
    modelImage?: ModelImageInput;
  }
  | {
    status: "rejected";
    rejected: AttachmentRejectedData;
    artifactRefs: [];
  };

export interface AttachmentContent {
  attachment: AttachmentRef;
  bytes: Uint8Array;
}

/** Structural alias avoids exporting ArtifactStore internals from this module. */
export type AttachmentArtifactRef = Awaited<ReturnType<ArtifactStore["putBytes"]>>;

export type PdfTextExtractor = (bytes: Uint8Array) => Promise<string>;

export interface AttachmentStoreOptions {
  artifacts: ArtifactStore;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  pdfExtractor?: PdfTextExtractor;
  maxBytes?: number;
  stageTtlMs?: number;
}

/**
 * Durable two-phase attachment store.
 *
 * `stageAttachment` never creates a Run fact. `claimAttachment` verifies and
 * materializes the staged bytes, but deliberately does not write the Event
 * ledger: Runtime owns the atomic ordering of run.created -> attachment.* ->
 * run.started. A same-run claim is replayable after a crash; another Run is
 * rejected fail-closed.
 */
export class AttachmentStore {
  readonly #root: string;
  readonly #stagingRoot: string;
  readonly #ingestedRoot: string;
  readonly #lookupRoot: string;
  readonly #artifacts: ArtifactStore;
  readonly #now: () => Date;
  readonly #pdfExtractor: PdfTextExtractor;
  readonly #maxBytes: number;
  readonly #stageTtlMs: number;
  readonly #claimQueues = new Map<string, Promise<void>>();

  constructor(root: string, options: AttachmentStoreOptions) {
    this.#root = root;
    this.#stagingRoot = join(root, "staging");
    this.#ingestedRoot = join(root, "ingested");
    this.#lookupRoot = join(root, "lookup");
    this.#artifacts = options.artifacts;
    this.#now = options.now ?? (() => new Date());
    // Retain the composition seam even though upload IDs are deliberately
    // derived from command identity so retries survive a process restart.
    void (options.idFactory ?? defaultIdFactory);
    this.#pdfExtractor = options.pdfExtractor ?? extractBasicPdfText;
    this.#maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.#stageTtlMs = options.stageTtlMs ?? DEFAULT_STAGE_TTL_MS;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > MAX_ATTACHMENT_BYTES) {
      throw new RangeError(`maxBytes must be an integer between 1 and ${MAX_ATTACHMENT_BYTES}`);
    }
    if (!Number.isSafeInteger(this.#stageTtlMs) || this.#stageTtlMs < 1_000 || this.#stageTtlMs > 24 * 60 * 60 * 1_000) {
      throw new RangeError("stageTtlMs must be between 1 second and 24 hours");
    }
  }

  async initialize(): Promise<void> {
    await Promise.all([
      initializePrivateDirectory(this.#root),
      initializePrivateDirectory(this.#stagingRoot),
      initializePrivateDirectory(this.#ingestedRoot),
      initializePrivateDirectory(this.#lookupRoot),
      this.#artifacts.initialize(),
    ]);
  }

  async stageAttachment(inputValue: StageAttachmentInput): Promise<AttachmentStageReceipt> {
    await this.initialize();
    const commandId = IdentifierSchema.parse(inputValue.commandId);
    const projectId = IdentifierSchema.parse(inputValue.projectId);
    const sessionId = inputValue.sessionId === undefined
      ? undefined
      : IdentifierSchema.parse(inputValue.sessionId);
    const declaredMediaType = inputValue.declaredMediaType.trim().toLowerCase();
    if (!declaredMediaType || declaredMediaType.length > 100) {
      throw new TypeError("declaredMediaType must contain at most 100 characters");
    }
    const delivery = AttachmentDeliverySchema.parse(inputValue.delivery ?? "offload");
    const source = inputValue.source ?? "user_upload";
    const bytes = Buffer.from(inputValue.bytes);
    const contentHash = sha256(bytes);
    const uploadId = uploadIdFor(commandId, projectId, sessionId);
    const expiresAt = new Date(this.#now().getTime() + this.#stageTtlMs).toISOString();
    const sniffed = sniffAttachmentMediaType(bytes);
    const parsedDeclared = AttachmentMediaTypeSchema.safeParse(declaredMediaType);
    const rejection = stageRejection(
      bytes.byteLength,
      this.#maxBytes,
      declaredMediaType,
      sniffed,
      parsedDeclared.success,
      delivery,
    );
    const receipt = rejection === undefined
      ? AcceptedAttachmentStageReceiptSchema.parse({
        status: "accepted",
        upload_id: uploadId,
        source,
        delivery,
        bytes: bytes.byteLength,
        expires_at: expiresAt,
        media_type: sniffed,
        sha256: contentHash,
      })
      : RejectedAttachmentStageReceiptSchema.parse({
        status: "rejected",
        upload_id: uploadId,
        source,
        delivery,
        bytes: bytes.byteLength,
        expires_at: expiresAt,
        declared_media_type: declaredMediaType,
        ...(sniffed === undefined ? {} : { sniffed_media_type: sniffed }),
        code: rejection.code,
        reason: rejection.reason,
      });
    const signature = sha256(stableStringify({
      command_id: commandId,
      project_id: projectId,
      session_id: sessionId,
      declared_media_type: declaredMediaType,
      delivery,
      source,
      bytes: bytes.byteLength,
      content_hash: contentHash,
    }));
    const record = InternalStagingRecordSchema.parse({
      version: STAGING_FORMAT_VERSION,
      command_id: commandId,
      project_id: projectId,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      signature,
      receipt,
    });
    const existing = await this.#readStagingRecord(uploadId);
    if (existing !== undefined) return replayStage(existing, signature);

    if (receipt.status === "accepted") {
      await writeExclusiveOrVerify(this.#stagedBytesPath(uploadId), bytes);
    }
    const metadataCreated = await publishExclusive(
      this.#stagedMetadataPath(uploadId),
      Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
    );
    if (!metadataCreated) {
      const raced = await this.#readStagingRecord(uploadId);
      if (raced === undefined) {
        throw new AttachmentStoreError("attachment_conflict", "Durable attachment metadata disappeared during replay");
      }
      return replayStage(raced, signature);
    }
    return receipt;
  }

  async claimAttachment(inputValue: ClaimAttachmentInput): Promise<AttachmentClaimResult> {
    await this.initialize();
    const input = {
      uploadId: IdentifierSchema.parse(inputValue.uploadId),
      projectId: IdentifierSchema.parse(inputValue.projectId),
      ...(inputValue.sessionId === undefined ? {} : { sessionId: IdentifierSchema.parse(inputValue.sessionId) }),
      runId: IdentifierSchema.parse(inputValue.runId),
      modelCapabilities: ModelCapabilitiesSchema.parse(inputValue.modelCapabilities),
    };
    const queueKey = `${input.projectId}\0${input.runId}\0${input.uploadId}`;
    return this.#withClaimQueue(queueKey, () => this.#claimAttachmentLocked(input));
  }

  async getContent(input: {
    attachmentId: string;
    projectId: string;
    runId: string;
  }): Promise<AttachmentContent> {
    await this.initialize();
    const attachmentId = IdentifierSchema.parse(input.attachmentId);
    const projectId = IdentifierSchema.parse(input.projectId);
    const runId = IdentifierSchema.parse(input.runId);
    let lookup: AttachmentRef;
    try {
      lookup = AttachmentRefSchema.parse(JSON.parse(
        await readFile(this.#lookupPath(attachmentId), "utf8"),
      ));
    } catch (error) {
      if (isNotFound(error)) throw new AttachmentStoreError("attachment_not_found", "Attachment content is unavailable");
      throw error;
    }
    if (lookup.attachment_id !== attachmentId) throw new AttachmentStoreError("attachment_corrupt", "Attachment lookup identity mismatch");
    const result = await this.#artifacts.getBytesInternal({
      artifactId: attachmentId,
      projectId,
      runId,
      maximumBytes: this.#maxBytes,
    });
    if (result.status !== "available") {
      throw new AttachmentStoreError(`attachment_${result.reason}`, "Attachment content is unavailable");
    }
    if (lookup.sha256 !== result.artifact.content_hash || lookup.bytes !== result.bytes.byteLength) {
      throw new AttachmentStoreError("attachment_corrupt", "Attachment lookup does not match stored bytes");
    }
    return { attachment: lookup, bytes: result.bytes };
  }

  async #claimAttachmentLocked(input: {
    uploadId: string;
    projectId: string;
    sessionId?: string;
    runId: string;
    modelCapabilities: ModelCapabilities;
  }): Promise<AttachmentClaimResult> {
    const durableResultPath = this.#claimResultPath(input.uploadId, input.runId);
    const durableResult = await readJsonIfPresent(durableResultPath, DurableClaimResultSchema);
    if (durableResult !== undefined) {
      await this.#deleteStagedBytes(input.uploadId);
      return this.#replayClaimResult(durableResult);
    }
    const record = await this.#readStagingRecord(input.uploadId);
    if (record === undefined) {
      return rejectedClaim(input.uploadId, "upload_already_claimed", "Upload is unavailable");
    }
    if (!sameStageScope(record, input.projectId, input.sessionId)) {
      return rejectedClaim(input.uploadId, "upload_scope_mismatch", "Upload does not belong to this project/session scope");
    }
    const ownerPath = this.#claimOwnerPath(input.uploadId);
    const ownerCreated = await publishExclusive(
      ownerPath,
      Buffer.from(`${JSON.stringify({ run_id: input.runId })}\n`, "utf8"),
    );
    if (!ownerCreated) {
      const owner = await readJsonIfPresent(ownerPath, ClaimOwnerSchema);
      if (owner?.run_id !== input.runId) {
        return rejectedClaim(input.uploadId, "upload_already_claimed", "Upload was claimed by another Run");
      }
    }
    if (Date.parse(record.receipt.expires_at) <= this.#now().getTime()) {
      return this.#persistClaimResult(durableResultPath, rejectedFromReceipt(
        record.receipt,
        "upload_expired",
        "Upload expired before it was claimed",
      ));
    }
    if (record.receipt.status === "rejected") {
      return this.#persistClaimResult(durableResultPath, rejectedFromReceipt(record.receipt));
    }
    const receipt = AcceptedAttachmentStageReceiptSchema.parse(record.receipt);
    if (receipt.delivery === "inline" && !input.modelCapabilities.image_input) {
      return this.#persistClaimResult(durableResultPath, rejectedFromReceipt(
        receipt,
        "model_image_unsupported",
        "Configured model does not declare image input capability",
      ));
    }
    const bytes = await this.#readAndVerifyStagedBytes(receipt);
    if (bytes === undefined) {
      return this.#persistClaimResult(durableResultPath, rejectedFromReceipt(
        receipt,
        "upload_corrupt",
        "Staged attachment bytes failed integrity verification",
      ));
    }

    const dedupKey = sha256(stableStringify({
      project_id: input.projectId,
      run_id: input.runId,
      media_type: receipt.media_type,
      content_hash: receipt.sha256,
      source: receipt.source,
    }));
    const { added, artifactRefs } = await this.#withClaimQueue(`dedup:${dedupKey}`, async () => {
      const durablePath = join(this.#ingestedRoot, `${dedupKey.slice("sha256:".length)}.json`);
      const existing = await readJsonIfPresent(durablePath, DurableIngestRecordSchema);
      if (existing !== undefined) {
        const parsedAdded = AttachmentAddedDataSchema.parse(existing.added);
        return {
          added: parsedAdded.upload_id === input.uploadId
            ? parsedAdded
            : AttachmentAddedDataSchema.parse({
              ...parsedAdded,
              upload_id: input.uploadId,
              delivery: receipt.delivery,
              deduplicated: true,
            }),
          artifactRefs: existing.artifact_refs as AttachmentArtifactRef[],
        };
      }
      const materialized = await this.#materialize(input, receipt, bytes);
      const durableCreated = await publishExclusive(
        durablePath,
        Buffer.from(`${JSON.stringify({
          added: materialized.added,
          artifact_refs: materialized.artifactRefs,
        })}\n`, "utf8"),
      );
      if (durableCreated) {
        return materialized;
      }
      const raced = await readJsonIfPresent(durablePath, DurableIngestRecordSchema);
      if (raced === undefined) {
        throw new AttachmentStoreError("attachment_conflict", "Durable attachment ingest record disappeared during replay");
      }
      const parsedAdded = AttachmentAddedDataSchema.parse(raced.added);
      return {
        added: AttachmentAddedDataSchema.parse({
          ...parsedAdded,
          upload_id: input.uploadId,
          delivery: receipt.delivery,
          deduplicated: true,
        }),
        artifactRefs: raced.artifact_refs as AttachmentArtifactRef[],
      };
    });

    await writeExclusiveOrVerify(
      this.#lookupPath(added.attachment.attachment_id),
      Buffer.from(`${JSON.stringify(added.attachment)}\n`, "utf8"),
    );
    const offloaded = added.delivery === "offload" || added.attachment.media_type === "application/pdf"
      ? AttachmentOffloadedDataSchema.parse({
        upload_id: input.uploadId,
        attachment: added.attachment,
        reason: added.attachment.media_type === "application/pdf" ? "pdf_reference" : "default_policy",
        locator: `artifact:${added.attachment.attachment_id}`,
      })
      : undefined;
    const modelImage = added.delivery === "inline"
      ? ModelImageInputSchema.parse({
        attachment: added.attachment,
        data_base64: Buffer.from(bytes).toString("base64"),
      })
      : undefined;
    return this.#persistClaimResult(durableResultPath, {
      status: "accepted",
      added,
      ...(offloaded === undefined ? {} : { offloaded }),
      artifactRefs,
      ...(modelImage === undefined ? {} : { modelImage }),
    });
  }

  async #persistClaimResult(path: string, result: AttachmentClaimResult): Promise<AttachmentClaimResult> {
    const durable = DurableClaimResultSchema.parse(result.status === "accepted"
      ? {
        status: "accepted",
        added: result.added,
        ...(result.offloaded === undefined ? {} : { offloaded: result.offloaded }),
        artifact_refs: result.artifactRefs,
        inline: result.modelImage !== undefined,
      }
      : { status: "rejected", rejected: result.rejected });
    const resultCreated = await publishExclusive(
      path,
      Buffer.from(`${JSON.stringify(durable)}\n`, "utf8"),
    );
    if (resultCreated) {
      await this.#deleteStagedBytes(claimUploadId(result));
      return result;
    }
    const raced = await readJsonIfPresent(path, DurableClaimResultSchema);
    if (raced === undefined) {
      throw new AttachmentStoreError("attachment_conflict", "Durable attachment claim result disappeared during replay");
    }
    await this.#deleteStagedBytes(claimUploadId(result));
    return this.#replayClaimResult(raced);
  }

  async #replayClaimResult(result: DurableClaimResult): Promise<AttachmentClaimResult> {
    if (result.status === "rejected") {
      return { status: "rejected", rejected: result.rejected, artifactRefs: [] };
    }
    let modelImage: ModelImageInput | undefined;
    if (result.inline) {
      const content = await this.getContent({
        attachmentId: result.added.attachment.attachment_id,
        projectId: result.artifact_refs[0]!.project_id,
        runId: result.artifact_refs[0]!.run_id,
      });
      modelImage = ModelImageInputSchema.parse({
        attachment: result.added.attachment,
        data_base64: Buffer.from(content.bytes).toString("base64"),
      });
    }
    return {
      status: "accepted",
      added: result.added,
      ...(result.offloaded === undefined ? {} : { offloaded: result.offloaded }),
      artifactRefs: result.artifact_refs,
      ...(modelImage === undefined ? {} : { modelImage }),
    };
  }

  async #materialize(
    input: { uploadId: string; projectId: string; runId: string },
    receipt: z.infer<typeof AcceptedAttachmentStageReceiptSchema>,
    bytes: Uint8Array,
  ): Promise<{ added: AttachmentAddedData; artifactRefs: AttachmentArtifactRef[] }> {
    const original = await this.#artifacts.putBytes({
      projectId: input.projectId,
      runId: input.runId,
      kind: receipt.media_type,
      mimeType: receipt.media_type,
      content: bytes,
    });
    const artifactRefs: AttachmentArtifactRef[] = [original];
    let extraction = PdfExtractionResultSchema.parse({ status: "not_applicable" });
    let extractedTextArtifactId: string | undefined;
    if (receipt.media_type === "application/pdf") {
      try {
        const extracted = normalizeExtractedPdfText(await this.#pdfExtractor(bytes));
        const textArtifact = await this.#artifacts.put({
          projectId: input.projectId,
          runId: input.runId,
          kind: "context_source_archive",
          mimeType: "text/plain",
          content: extracted,
        });
        artifactRefs.push(textArtifact);
        extractedTextArtifactId = textArtifact.artifact_id;
        extraction = PdfExtractionResultSchema.parse({
          status: "extracted",
          artifact_id: textArtifact.artifact_id,
          characters: extracted.length,
        });
      } catch {
        extraction = PdfExtractionResultSchema.parse({
          status: "failed",
          code: "pdf_text_extraction_failed",
          reason: "PDF text extraction failed; the original PDF remains available by reference",
          fallback: "reference_only",
        });
      }
    }
    const attachment = AttachmentRefSchema.parse({
      attachment_id: original.artifact_id,
      media_type: receipt.media_type,
      bytes: original.byte_length,
      sha256: original.content_hash,
      ...(extractedTextArtifactId === undefined ? {} : { extracted_text_artifact_id: extractedTextArtifactId }),
      source: receipt.source,
    });
    return {
      added: AttachmentAddedDataSchema.parse({
        upload_id: input.uploadId,
        attachment,
        delivery: receipt.delivery,
        deduplicated: false,
        pdf_extraction: extraction,
      }),
      artifactRefs,
    };
  }

  async #readAndVerifyStagedBytes(
    receipt: z.infer<typeof AcceptedAttachmentStageReceiptSchema>,
  ): Promise<Uint8Array | undefined> {
    try {
      const bytes = await readFile(this.#stagedBytesPath(receipt.upload_id));
      if (
        bytes.byteLength !== receipt.bytes
        || bytes.byteLength > this.#maxBytes
        || sha256(bytes) !== receipt.sha256
        || sniffAttachmentMediaType(bytes) !== receipt.media_type
      ) return undefined;
      return bytes;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async #readStagingRecord(uploadId: string): Promise<InternalStagingRecord | undefined> {
    return readJsonIfPresent(this.#stagedMetadataPath(uploadId), InternalStagingRecordSchema);
  }

  async #withClaimQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.#claimQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = preceding.then(() => current);
    this.#claimQueues.set(key, queued);
    await preceding;
    try {
      return await operation();
    } finally {
      release();
      if (this.#claimQueues.get(key) === queued) this.#claimQueues.delete(key);
    }
  }

  #stagedMetadataPath(uploadId: string): string {
    return join(this.#stagingRoot, `${safeId(uploadId)}.json`);
  }

  #stagedBytesPath(uploadId: string): string {
    return join(this.#stagingRoot, `${safeId(uploadId)}.data`);
  }

  #claimOwnerPath(uploadId: string): string {
    return join(this.#stagingRoot, `${safeId(uploadId)}.owner.json`);
  }

  #lookupPath(attachmentId: string): string {
    return join(this.#lookupRoot, `${safeId(attachmentId)}.json`);
  }

  #claimResultPath(uploadId: string, runId: string): string {
    const runScope = sha256(runId).slice("sha256:".length, "sha256:".length + 24);
    return join(this.#stagingRoot, `${safeId(uploadId)}.result-${runScope}.json`);
  }

  async #deleteStagedBytes(uploadId: string): Promise<void> {
    await unlink(this.#stagedBytesPath(uploadId)).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

export class AttachmentStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AttachmentStoreError";
    this.code = code;
  }
}

function uploadIdFor(commandId: string, projectId: string, sessionId: string | undefined): string {
  return `upload:${sha256(stableStringify({ command_id: commandId, project_id: projectId, session_id: sessionId })).slice("sha256:".length)}`;
}

function claimUploadId(result: AttachmentClaimResult): string {
  return result.status === "accepted" ? result.added.upload_id : result.rejected.upload_id;
}

function stageRejection(
  bytes: number,
  maximumBytes: number,
  declared: string,
  sniffed: AttachmentMediaType | undefined,
  declaredSupported: boolean,
  delivery: AttachmentDelivery,
): { code: "empty_file" | "too_large" | "unsupported_media_type" | "media_type_mismatch" | "inline_not_supported"; reason: string } | undefined {
  if (bytes === 0) return { code: "empty_file", reason: "Attachment is empty" };
  if (bytes > maximumBytes) return { code: "too_large", reason: `Attachment exceeds the ${maximumBytes}-byte limit` };
  if (!declaredSupported || sniffed === undefined) return { code: "unsupported_media_type", reason: "Attachment media type is unsupported" };
  if (declared !== sniffed) return { code: "media_type_mismatch", reason: "Declared media type does not match file signature" };
  if (delivery === "inline" && sniffed === "application/pdf") {
    return { code: "inline_not_supported", reason: "PDF attachments are reference-only and cannot be inlined" };
  }
  return undefined;
}

export function sniffAttachmentMediaType(bytes: Uint8Array): AttachmentMediaType | undefined {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 5
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    && bytes.at(-2) === 0xff
    && bytes.at(-1) === 0xd9
  ) return "image/jpeg";
  if (
    bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d
  ) return "application/pdf";
  return undefined;
}

async function extractBasicPdfText(bytes: Uint8Array): Promise<string> {
  const source = new TextDecoder("latin1").decode(bytes);
  const values: string[] = [];
  const textOperator = /\(((?:\\.|[^\\)]){1,8192})\)\s*(?:Tj|'|")/gu;
  for (const match of source.matchAll(textOperator)) {
    const decoded = decodePdfLiteral(match[1] ?? "").trim();
    if (decoded) values.push(decoded);
    if (values.join("\n").length >= MAX_EXTRACTED_PDF_CHARACTERS) break;
  }
  return values.join("\n");
}

function decodePdfLiteral(value: string): string {
  return value
    .replace(/\\([nrtbf()\\])/gu, (_match, escaped: string) => ({
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\",
    })[escaped] ?? escaped)
    .replace(/\\([0-7]{1,3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function normalizeExtractedPdfText(value: string): string {
  const normalized = redactSensitiveText(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_PDF_CHARACTERS);
  if (!normalized) throw new AttachmentStoreError("pdf_text_empty", "PDF did not contain extractable text");
  return normalized;
}

function sameStageScope(record: InternalStagingRecord, projectId: string, sessionId: string | undefined): boolean {
  return record.project_id === projectId
    && (record.session_id === undefined || record.session_id === sessionId);
}

function rejectedFromReceipt(
  receipt: AttachmentStageReceipt,
  overrideCode?: AttachmentRejectedData["code"],
  overrideReason?: string,
): AttachmentClaimResult {
  const rejected = receipt.status === "rejected"
    ? AttachmentRejectedDataSchema.parse({
      upload_id: receipt.upload_id,
      source: receipt.source,
      delivery: receipt.delivery,
      declared_media_type: receipt.declared_media_type,
      ...(receipt.sniffed_media_type === undefined ? {} : { sniffed_media_type: receipt.sniffed_media_type }),
      bytes: receipt.bytes,
      code: overrideCode ?? receipt.code,
      reason: overrideReason ?? receipt.reason,
    })
    : AttachmentRejectedDataSchema.parse({
      upload_id: receipt.upload_id,
      source: receipt.source,
      delivery: receipt.delivery,
      sniffed_media_type: receipt.media_type,
      bytes: receipt.bytes,
      code: overrideCode ?? "upload_corrupt",
      reason: overrideReason ?? "Attachment upload is unavailable",
    });
  return { status: "rejected", rejected, artifactRefs: [] };
}

function rejectedClaim(
  uploadId: string,
  code: "upload_already_claimed" | "upload_scope_mismatch",
  reason: string,
): AttachmentClaimResult {
  return {
    status: "rejected",
    rejected: AttachmentRejectedDataSchema.parse({
      upload_id: uploadId,
      source: "user_upload",
      delivery: "offload",
      bytes: 0,
      code,
      reason,
    }),
    artifactRefs: [],
  };
}

function replayStage(record: InternalStagingRecord, expectedSignature: string): AttachmentStageReceipt {
  if (record.signature !== expectedSignature) {
    throw new AttachmentStoreError("upload_command_conflict", "Attachment command_id was reused with different input");
  }
  return AttachmentStageReceiptSchema.parse(record.receipt);
}

async function initializePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("Attachment root must be a real directory");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new TypeError("Attachment root must be owned by the current user");
  }
  await chmod(path, 0o700);
}

async function readJsonIfPresent<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeExclusiveOrVerify(path: string, bytes: Uint8Array): Promise<void> {
  if (await publishExclusive(path, bytes)) return;
  const existing = await readFile(path);
  if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
    throw new AttachmentStoreError("attachment_conflict", "Durable attachment bytes conflict with an existing command");
  }
}

/**
 * Publish a fully written file without ever exposing a partial destination.
 *
 * `O_EXCL` on the final path is not sufficient: the directory entry becomes
 * visible as soon as `open()` succeeds, before `writeFile()` and `sync()` have
 * completed. A concurrent verifier can then read a zero-length or partial
 * file and report a false conflict. A same-directory hard link is atomic and
 * never replaces an existing winner, so readers only observe complete bytes.
 */
async function publishExclusive(path: string, bytes: Uint8Array): Promise<boolean> {
  const temporaryPath = `${path}.${safeId(defaultIdFactory("attachment-publish"))}.tmp`;
  try {
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
