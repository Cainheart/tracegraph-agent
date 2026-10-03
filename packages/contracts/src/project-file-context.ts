import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "./common.js";
import { ProjectFilePathSchema } from "./project-files-feedback.js";

export const MAX_PROJECT_CONTEXT_FILES = 5;
export const MAX_PROJECT_CONTEXT_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_CONTEXT_TOTAL_BYTES = 128 * 1024;

/** Clients select a project-relative version, never supply its contents or authority. */
export const ProjectFileContextRefSchema = z.object({
  path: ProjectFilePathSchema,
  expected_sha256: Sha256Schema,
}).strict();
export const ProjectFileContextRefsSchema = ProjectFileContextRefSchema.array()
  .max(MAX_PROJECT_CONTEXT_FILES)
  .refine((refs) => new Set(refs.map((ref) => ref.path)).size === refs.length, "Select each project file once");

/** Private Host -> Core snapshot; not a browser or CLI request format. */
export const ProjectFileContextSnapshotSchema = z.object({
  project_id: IdentifierSchema,
  path: ProjectFilePathSchema,
  sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative().max(MAX_PROJECT_CONTEXT_FILE_BYTES),
  content: z.string().max(MAX_PROJECT_CONTEXT_FILE_BYTES),
}).strict().refine((value) => new TextEncoder().encode(value.content).byteLength === value.byte_length,
  "Snapshot length must describe its UTF-8 bytes");
export const ProjectFileContextSnapshotsSchema = ProjectFileContextSnapshotSchema.array()
  .max(MAX_PROJECT_CONTEXT_FILES)
  .refine((snapshots) => new Set(snapshots.map((snapshot) => snapshot.path)).size === snapshots.length,
    "Each snapshot must have a distinct path")
  .refine((snapshots) => snapshots.reduce((sum, snapshot) => sum + snapshot.byte_length, 0) <= MAX_PROJECT_CONTEXT_TOTAL_BYTES,
    "Selected project context exceeds the total byte limit");

export type ProjectFileContextRef = z.infer<typeof ProjectFileContextRefSchema>;
export type ProjectFileContextSnapshot = z.infer<typeof ProjectFileContextSnapshotSchema>;
