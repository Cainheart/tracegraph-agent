import { chmod, lstat, mkdir, readFile, unlink, writeFile, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import {
  AttachmentMediaTypeSchema,
  MediaMimeTypeSchema,
  ArtifactRefSchema,
  ArtifactWireResponseSchema,
  type ArtifactKind,
  type ArtifactRef,
  type ArtifactWireResponse,
} from "@tracegraph/contracts";
import type { EvidencePrimitives } from "./ports.js";

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

export interface ArtifactStoreOptions {
  readonly primitives: EvidencePrimitives;
  readonly now?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  readonly maxWireBytes?: number;
  readonly maxInternalBytes?: number;
}

export class ArtifactStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #primitives: EvidencePrimitives;
  readonly #maxWireBytes: number;
  readonly #maxInternalBytes: number;

  constructor(root: string, options: ArtifactStoreOptions) {
    this.#root = root;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? options.primitives.defaultIdFactory;
    this.#primitives = options.primitives;
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
    const content = sanitizeArtifactContent(input.content, input.mimeType, this.#primitives);
    const bytes = Buffer.from(content, "utf8");
    const ref = ArtifactRefSchema.parse({
      artifact_id: artifactId,
      kind: input.kind,
      content_hash: this.#primitives.sha256(bytes),
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
    kind: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | "application/pdf";
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | "application/pdf";
    content: Uint8Array;
  }): Promise<ArtifactRef> {
    await this.initialize();
    const mediaType = input.mimeType === "application/pdf" ? input.mimeType : MediaMimeTypeSchema.parse(input.mimeType);
    if (input.kind !== mediaType) throw new TypeError("Attachment Artifact kind must match its MIME type");
    const bytes = Buffer.from(input.content);
    const artifactId = this.#idFactory("attachment");
    const ref = ArtifactRefSchema.parse({
      artifact_id: artifactId,
      kind: input.kind,
      content_hash: this.#primitives.sha256(bytes),
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
      const media = ref.mime_type === "application/pdf" ? AttachmentMediaTypeSchema.safeParse(ref.mime_type) : MediaMimeTypeSchema.safeParse(ref.mime_type);
      if (!media.success || ref.kind !== media.data) {
        return { status: "unavailable", artifactId: input.artifactId, reason: "unsupported_mime" };
      }
      if (ref.byte_length > input.maximumBytes) {
        return { status: "unavailable", artifactId: input.artifactId, reason: "too_large" };
      }
      const bytes = await readFile(this.#contentPath(input.artifactId));
      const actualHash = this.#primitives.sha256(bytes);
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

  /** Trusted retention boundary. Caller must establish capture provenance first.
   * Keeps metadata and all Ledger facts; never deletes directories or text. */
  async deleteBytesInternal(expected: ArtifactRef): Promise<{status:"deleted"|"already_absent";byteLength:number}> {
    const ref=ArtifactRefSchema.parse(expected);
    if(ref.mime_type!=="image/png"||ref.kind!=="image/png"||ref.byte_length>16*1024*1024)throw new TypeError("Only bounded registered PNG evidence can expire");
    if(await realpath(this.#root)!==resolve(this.#root))throw new TypeError("Artifact root cannot contain symbolic links");
    const root=await lstat(this.#root);
    if(!root.isDirectory()||root.isSymbolicLink()||(typeof process.getuid==="function"&&root.uid!==process.getuid()))throw new TypeError("Artifact root is not private");
    const metadata=await this.#safeBytes(this.#metadataPath(ref.artifact_id),16_384);
    if(JSON.stringify(ArtifactRefSchema.parse(JSON.parse(metadata.bytes.toString("utf8"))))!==JSON.stringify(ref))throw new TypeError("Artifact retention scope or metadata changed");
    let content;
    try{content=await this.#safeBytes(this.#contentPath(ref.artifact_id),16*1024*1024);}catch(error){if(isNotFound(error))return {status:"already_absent",byteLength:0};throw error;}
    if(content.bytes.byteLength!==ref.byte_length||this.#primitives.sha256(content.bytes)!==ref.content_hash)throw new TypeError("Artifact retention bytes changed");
    const current=await lstat(this.#contentPath(ref.artifact_id));
    if(current.dev!==content.dev||current.ino!==content.ino||!current.isFile()||current.isSymbolicLink()||current.nlink!==1)throw new TypeError("Artifact retention file changed");
    await unlink(this.#contentPath(ref.artifact_id));
    return {status:"deleted",byteLength:ref.byte_length};
  }

  /** Non-mutating retention reconciliation; never follows replacement links. */
  async inspectBytesInternal(expected:ArtifactRef):Promise<"available"|"absent"|"unverifiable"> {
    try{const ref=ArtifactRefSchema.parse(expected);
      if(ref.kind!=="image/png"||ref.mime_type!=="image/png"||await realpath(this.#root)!==resolve(this.#root))return "unverifiable";
      const metadata=await this.#safeBytes(this.#metadataPath(ref.artifact_id),16_384);
      if(JSON.stringify(ArtifactRefSchema.parse(JSON.parse(metadata.bytes.toString("utf8"))))!==JSON.stringify(ref))return "unverifiable";
      let content;try{content=await this.#safeBytes(this.#contentPath(ref.artifact_id),16*1024*1024);}catch(error){if(isNotFound(error))return "absent";throw error;}
      return content.bytes.byteLength===ref.byte_length&&this.#primitives.sha256(content.bytes)===ref.content_hash?"available":"unverifiable";
    }catch{return "unverifiable";}
  }

  async #safeBytes(path:string,maximum:number):Promise<{bytes:Buffer;dev:number;ino:number}> {
    const before=await lstat(path);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maximum||(typeof process.getuid==="function"&&before.uid!==process.getuid()))throw new TypeError("Artifact retention requires a bounded private regular file");
    const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{const info=await handle.stat();if(info.dev!==before.dev||info.ino!==before.ino||info.nlink!==1||!info.isFile()||info.size>maximum)throw new TypeError("Artifact retention identity changed");
      const bytes=Buffer.alloc(maximum+1);let offset=0;while(offset<bytes.length){const part=await handle.read(bytes,offset,bytes.length-offset,offset);if(!part.bytesRead)break;offset+=part.bytesRead;}
      if(offset>maximum)throw new TypeError("Artifact retention bytes exceed bounds");return {bytes:bytes.subarray(0,offset),dev:info.dev,ino:info.ino};
    }finally{await handle.close();}
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
      const actualHash = this.#primitives.sha256(content);
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
        wireContent = sanitizeArtifactContent(content, ref.mime_type, this.#primitives);
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

function sanitizeArtifactContent(
  content: string,
  mimeType: string,
  primitives: EvidencePrimitives,
): string {
  if (mimeType !== "application/json") return primitives.redactSensitiveText(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    // Do not include a parser excerpt because it may itself contain the secret
    // that caused an invalid producer payload.
    throw new TypeError("application/json Artifact content is invalid JSON");
  }
  return JSON.stringify(primitives.redactStructuredArtifactValue(parsed), null, 2);
}

function safeArtifactId(artifactId: string): string {
  return artifactId.replace(/[^A-Za-z0-9_.-]/gu, "_");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
