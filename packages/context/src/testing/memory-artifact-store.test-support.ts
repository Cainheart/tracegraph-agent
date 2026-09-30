import {
  ArtifactRefSchema,
  type ArtifactKind,
  type ArtifactRef,
  type ArtifactWireResponse,
} from "@tracegraph/contracts";
import { sha256 } from "@tracegraph/tool";
import type { ContextArtifactStore } from "../context-compaction.js";

/** A contract-test fake; production artifact persistence remains Core-owned. */
export class MemoryContextArtifactStore implements ContextArtifactStore {
  readonly #artifacts = new Map<string, { artifact: ArtifactRef; content: string }>();
  readonly #idFactory: (prefix: string) => string;
  readonly #now: () => Date;

  constructor(options: { idFactory?: (prefix: string) => string; now?: () => Date } = {}) {
    this.#idFactory = options.idFactory ?? ((prefix) => `${prefix}:test`);
    this.#now = options.now ?? (() => new Date("2026-09-18T00:00:00.000Z"));
  }

  async initialize(): Promise<void> {}

  async put(input: {
    projectId: string;
    runId: string;
    kind: ArtifactKind;
    mimeType: string;
    content: string;
  }): Promise<ArtifactRef> {
    const artifact = ArtifactRefSchema.parse({
      artifact_id: this.#idFactory("artifact"),
      kind: input.kind,
      content_hash: sha256(input.content),
      mime_type: input.mimeType,
      byte_length: Buffer.byteLength(input.content, "utf8"),
      project_id: input.projectId,
      run_id: input.runId,
      created_at: this.#now().toISOString(),
    });
    this.#artifacts.set(artifact.artifact_id, { artifact, content: input.content });
    return artifact;
  }

  async getInternal(input: {
    artifactId: string;
    projectId: string;
    runId: string;
  }): Promise<ArtifactWireResponse> {
    const stored = this.#artifacts.get(input.artifactId);
    if (stored === undefined) {
      return { status: "unavailable", artifact_id: input.artifactId, reason: "not_found" };
    }
    if (stored.artifact.project_id !== input.projectId || stored.artifact.run_id !== input.runId) {
      return { status: "unavailable", artifact_id: input.artifactId, reason: "out_of_scope" };
    }
    const byteLength = Buffer.byteLength(stored.content, "utf8");
    return {
      status: "available",
      artifact: stored.artifact,
      content: stored.content,
      range: { start: 0, end: byteLength, total: byteLength },
    };
  }
}
