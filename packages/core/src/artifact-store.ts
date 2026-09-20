import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentMediaTypeSchema,
  ArtifactRefSchema,
  ArtifactWireResponseSchema,
  type ArtifactKind,
  type ArtifactRef,
  type ArtifactWireResponse,
} from "@tracegraph/contracts";
import {
  defaultIdFactory,
  redactSensitiveText,
  redactStructuredArtifactValue,
  sha256,
} from "./crypto.js";

const DEFAULT_MAX_WIRE_BYTES = 1024 * 1024;
// Internal recovery payloads are bounded by their strict contracts but can be
// larger than the public Artifact response ceiling (for example 160 bounded
// conversation messages). Keep a separate hard ceiling so recovery does not
// accidentally inherit a transport/UI policy.
const DEFAULT_MAX_INTERNAL_BYTES = 8 * 1024 * 1024;
const ALLOWED_WIRE_MIME_TYPES = new Set([
  "application/json",
  "text/markdown",
  "text/plain",
  "text/x-diff",
]);

export type BinaryArtifactReadResult =
  | { status: "available"; artifact: ArtifactRef; bytes: Uint8Array }
  | { status: "unavailable"; artifactId: string; reason: "not_found" | "out_of_scope" | "unsupported_mime" | "too_large" }
  | { status: "corrupt"; artifactId: string; expectedHash: string; actualHash?: string; reason: string };

export class ArtifactStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #maxWireBytes: number;
  readonly #maxInternalBytes: number;

  constructor(
    root: string,
    options: {
      now?: () => Date;
      idFactory?: (prefix: string) => string;
      maxWireBytes?: number;
      maxInternalBytes?: number;
    } = {},
  ) {
    this.#root = root;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#maxWireBytes = options.maxWireBytes ?? DEFAULT_MAX_WIRE_BYTES;
    this.#maxInternalBytes = options.maxInternalBytes ?? DEFAULT_MAX_INTERNAL_BYTES;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TypeError("Artifact root must be a real directory");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new TypeError("Artifact root must be owned by the current user");
    }
    await chmod(this.#root, 0o700);
  }

  async put(input: {
    projectId: string;
    runId: string;
    kind: ArtifactKind;
    mimeType: string;
    content: string;
  }): Promise<ArtifactRef> {
    await this.initialize();
    const artifactId = this.#idFactory("artifact");
    const content = sanitizeArtifactContent(input.content, input.mimeType);
    const bytes = Buffer.from(content, "utf8");
    const ref = ArtifactRefSchema.parse({
      artifact_id: artifactId,
      kind: input.kind,
      content_hash: sha256(bytes),
      mime_type: input.mimeType,
      byte_length: bytes.byteLength,
      project_id: input.projectId,
      run_id: input.runId,
      created_at: this.#now().toISOString(),
    });
    await writeFile(this.#contentPath(artifactId), bytes, { flag: "wx", mode: 0o600 });
    await writeFile(this.#metadataPath(artifactId), `${JSON.stringify(ref)}\n`, { flag: "wx", mode: 0o600 });
    return ref;
  }

  /**
   * Store verified opaque bytes without passing them through UTF-8 redaction.
   * This boundary is intentionally limited to the three G-18 attachment MIME
   * types; arbitrary binary Artifacts remain unsupported.
   */
  async putBytes(input: {
    projectId: string;
    runId: string;
    kind: "image/png" | "image/jpeg" | "application/pdf";
    mimeType: "image/png" | "image/jpeg" | "application/pdf";
    content: Uint8Array;
  }): Promise<ArtifactRef> {
    await this.initialize();
    const mediaType = AttachmentMediaTypeSchema.parse(input.mimeType);
    if (input.kind !== mediaType) throw new TypeError("Attachment Artifact kind must match its MIME type");
    const bytes = Buffer.from(input.content);
    const artifactId = this.#idFactory("attachment");
    const ref = ArtifactRefSchema.parse({
      artifact_id: artifactId,
      kind: input.kind,
      content_hash: sha256(bytes),
      mime_type: mediaType,
      byte_length: bytes.byteLength,
      project_id: input.projectId,
      run_id: input.runId,
      created_at: this.#now().toISOString(),
    });
    const contentPath = this.#contentPath(artifactId);
    let contentCreated = false;
    try {
      await writeFile(contentPath, bytes, { flag: "wx", mode: 0o600 });
      contentCreated = true;
      await writeFile(this.#metadataPath(artifactId), `${JSON.stringify(ref)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (contentCreated) await unlink(contentPath).catch(() => undefined);
      throw error;
    }
    return ref;
  }

  async get(input: {
    artifactId: string;
    projectId: string;
    runId: string;
  }): Promise<ArtifactWireResponse> {
    return this.#getVerified(input, this.#maxWireBytes);
  }

  /**
   * Runtime-only verified read. This is deliberately not exposed through the
   * Host Artifact route and has its own bounded ceiling above the wire limit.
   */
  async getInternal(input: {
    artifactId: string;
    projectId: string;
    runId: string;
  }): Promise<ArtifactWireResponse> {
    return this.#getVerified(input, this.#maxInternalBytes);
  }

  /** Runtime/Host-only verified binary read for a relation-authorized attachment route. */
  async getBytesInternal(input: {
    artifactId: string;
    projectId: string;
    runId: string;
    maximumBytes: number;
  }): Promise<BinaryArtifactReadResult> {
    try {
      const metadataText = await readFile(this.#metadataPath(input.artifactId), "utf8");
      const ref = ArtifactRefSchema.parse(JSON.parse(metadataText));
      if (ref.project_id !== input.projectId || ref.run_id !== input.runId) {
        return { status: "unavailable", artifactId: input.artifactId, reason: "out_of_scope" };
      }
      const media = AttachmentMediaTypeSchema.safeParse(ref.mime_type);
      if (!media.success || ref.kind !== media.data) {
        return { status: "unavailable", artifactId: input.artifactId, reason: "unsupported_mime" };
      }
      if (ref.byte_length > input.maximumBytes) {
        return { status: "unavailable", artifactId: input.artifactId, reason: "too_large" };
      }
      const bytes = await readFile(this.#contentPath(input.artifactId));
      const actualHash = sha256(bytes);
      if (actualHash !== ref.content_hash || bytes.byteLength !== ref.byte_length) {
        return {
          status: "corrupt",
          artifactId: input.artifactId,
          expectedHash: ref.content_hash,
          actualHash,
          reason: actualHash === ref.content_hash ? "byte length mismatch" : "content hash mismatch",
        };
      }
      return { status: "available", artifact: ref, bytes };
    } catch (error) {
      if (isNotFound(error)) {
        return { status: "unavailable", artifactId: input.artifactId, reason: "not_found" };
      }
      throw error;
    }
  }

  async #getVerified(input: {
    artifactId: string;
    projectId: string;
    runId: string;
  }, maximumBytes: number): Promise<ArtifactWireResponse> {
    try {
      const metadataText = await readFile(this.#metadataPath(input.artifactId), "utf8");
      const ref = ArtifactRefSchema.parse(JSON.parse(metadataText));
      if (ref.project_id !== input.projectId || ref.run_id !== input.runId) {
        return ArtifactWireResponseSchema.parse({
          status: "unavailable",
          artifact_id: input.artifactId,
          reason: "out_of_scope",
        });
      }
      if (!ALLOWED_WIRE_MIME_TYPES.has(ref.mime_type)) {
        return ArtifactWireResponseSchema.parse({
          status: "unavailable",
          artifact_id: input.artifactId,
          reason: "unsupported_mime",
        });
      }
      if (ref.byte_length > maximumBytes) {
        return ArtifactWireResponseSchema.parse({
          status: "unavailable",
          artifact_id: input.artifactId,
          reason: "too_large",
        });
      }
      const content = await readFile(this.#contentPath(input.artifactId), "utf8");
      const actualHash = sha256(content);
      if (actualHash !== ref.content_hash) {
        return ArtifactWireResponseSchema.parse({
          status: "corrupt",
          artifact_id: input.artifactId,
          expected_hash: ref.content_hash,
          actual_hash: actualHash,
          reason: "content hash mismatch",
        });
      }
      let wireContent: string;
      try {
        wireContent = sanitizeArtifactContent(content, ref.mime_type);
      } catch {
        return ArtifactWireResponseSchema.parse({
          status: "corrupt",
          artifact_id: input.artifactId,
          expected_hash: ref.content_hash,
          actual_hash: actualHash,
          reason: "artifact content does not match its declared MIME type",
        });
      }
      if (wireContent !== content) {
        return ArtifactWireResponseSchema.parse({
          status: "corrupt",
          artifact_id: input.artifactId,
          expected_hash: ref.content_hash,
          actual_hash: actualHash,
          reason: "artifact failed secondary redaction verification",
        });
      }
      return ArtifactWireResponseSchema.parse({ status: "available", artifact: ref, content: wireContent });
    } catch (error) {
      if (isNotFound(error)) {
        return ArtifactWireResponseSchema.parse({
          status: "unavailable",
          artifact_id: input.artifactId,
          reason: "not_found",
        });
      }
      throw error;
    }
  }

  #contentPath(artifactId: string): string {
    return join(this.#root, `${safeArtifactId(artifactId)}.data`);
  }

  #metadataPath(artifactId: string): string {
    return join(this.#root, `${safeArtifactId(artifactId)}.json`);
  }
}

function sanitizeArtifactContent(content: string, mimeType: string): string {
  if (mimeType !== "application/json") return redactSensitiveText(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    // Do not include a parser excerpt because it may itself contain the secret
    // that caused an invalid producer payload.
    throw new TypeError("application/json Artifact content is invalid JSON");
  }
  return JSON.stringify(redactStructuredArtifactValue(parsed), null, 2);
}

function safeArtifactId(artifactId: string): string {
  return artifactId.replace(/[^A-Za-z0-9_.-]/gu, "_");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
