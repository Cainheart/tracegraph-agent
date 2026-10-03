import { describe, expect, it } from "vitest";
import { PROJECTOR_VERSION, ReceiptSchema, SCHEMA_VERSION, type ArtifactRef, type RunProjection, type WireSessionEvent } from "@tracegraph/contracts";
import { generatedArtifacts } from "./generated-media";
const now = "2026-10-03T00:00:00.000Z";
const ref: ArtifactRef = { artifact_id: "artifact:image", kind: "image/png", mime_type: "image/png", content_hash: `sha256:${"a".repeat(64)}`, byte_length: 16, project_id: "project:image", run_id: "run:image", created_at: now };
const receipt = ReceiptSchema.parse({ receipt_id: "receipt:image", action_id: "action:image", tool_name: "generate_image", status: "success", transport_status: "success", business_status: "success", code: "image_generated", summary: "Image bytes persisted", started_at: now, completed_at: now, duration_ms: 1, artifact_refs: [ref] });
const event: WireSessionEvent = { schema_version: SCHEMA_VERSION, event_id: "event:image", project_id: ref.project_id, run_id: ref.run_id, action_id: receipt.action_id, type: "tool.completed", sequence: 1, occurred_at: now, summary: receipt.summary, artifact_refs: [ref], data: { receipt } };
const projection: Pick<RunProjection, "project_id" | "run_id" | "timeline" | "artifact_refs"> = { project_id: ref.project_id, run_id: ref.run_id, timeline: [event], artifact_refs: [ref] };
describe("generated media provenance", () => {
  it("requires a successful media tool receipt and exact canonical Artifact identity", () => { expect(generatedArtifacts(projection)).toEqual([{ artifactId: ref.artifact_id, projectId: ref.project_id, runId: ref.run_id, mediaType: "image/png", sha256: ref.content_hash, bytes: ref.byte_length, label: "Generated image" }]); });
  it("does not display user uploads or a non-media tool image output as a generated result", () => { expect(generatedArtifacts({ ...projection, timeline: [] })).toEqual([]); expect(generatedArtifacts({ ...projection, timeline: [{ ...event, data: { receipt: { ...receipt, tool_name: "read_file" } } }] })).toEqual([]); });
  it("does not promote transport success or unknown business results into generated results", () => { for (const business_status of ["failure", "unknown"] as const) expect(generatedArtifacts({ ...projection, timeline: [{ ...event, data: { receipt: { ...receipt, business_status } } }] })).toEqual([]); });
  it("rejects mismatched project/run/hash/MIME/size projections", () => { for (const patch of [{ project_id: "other" }, { run_id: "other" }, { content_hash: `sha256:${"b".repeat(64)}` }, { mime_type: "image/svg+xml" }, { byte_length: 32 }]) expect(generatedArtifacts({ ...projection, artifact_refs: [{ ...ref, ...patch } as ArtifactRef] })).toEqual([]); });
});
