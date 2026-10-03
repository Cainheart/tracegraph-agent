import { ReceiptSchema, type RunProjection } from "@tracegraph/contracts";
import type { GeneratedArtifact } from "./model";
const mediaTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const tools = new Set(["generate_image", "render_diagram", "render_chart"]);
/** Generated previews require a successful actual tool receipt, never a user-upload MIME match. */
export function generatedArtifacts(projection: Pick<RunProjection, "project_id" | "run_id" | "timeline" | "artifact_refs">): GeneratedArtifact[] {
  const artifacts = new Map<string, GeneratedArtifact>();
  for (const event of projection.timeline) {
    if (event.type !== "tool.completed" || event.project_id !== projection.project_id || event.run_id !== projection.run_id) continue;
    const parsed = ReceiptSchema.safeParse(event.data.receipt);
    if (!parsed.success || parsed.data.business_status !== "success" || !tools.has(parsed.data.tool_name)) continue;
    for (const ref of parsed.data.artifact_refs) {
      if (ref.project_id !== projection.project_id || ref.run_id !== projection.run_id || !mediaTypes.has(ref.mime_type)) continue;
      if (!projection.artifact_refs.some((recorded) => recorded.artifact_id === ref.artifact_id && recorded.project_id === ref.project_id && recorded.run_id === ref.run_id && recorded.content_hash === ref.content_hash && recorded.mime_type === ref.mime_type && recorded.byte_length === ref.byte_length)) continue;
      artifacts.set(ref.artifact_id, { artifactId: ref.artifact_id, projectId: ref.project_id, runId: ref.run_id, mediaType: ref.mime_type as GeneratedArtifact["mediaType"], sha256: ref.content_hash, bytes: ref.byte_length, label: parsed.data.tool_name === "generate_image" ? "Generated image" : parsed.data.tool_name === "render_diagram" ? "Generated diagram" : "Generated chart" });
    }
  }
  return [...artifacts.values()];
}
