import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, NonEmptyStringSchema } from "./common.js";

export const WorkspaceKindSchema = z.enum(["readonly_local", "disposable_fixture", "managed_local"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const CapabilityProfileSchema = z.object({
  index: z.boolean(),
  read: z.boolean(),
  search: z.boolean(),
  run_command: z.boolean(),
  preview_patch: z.boolean(),
  commit_patch: z.boolean(),
  test: z.boolean(),
});
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

export const WorkspaceHandleSchema = z.object({
  handle_id: IdentifierSchema,
  project_id: IdentifierSchema,
  real_root: NonEmptyStringSchema,
  workspace_kind: WorkspaceKindSchema,
  capabilities: CapabilityProfileSchema,
  created_at: IsoDateTimeSchema,
}).superRefine((value, context) => {
  if (value.workspace_kind === "readonly_local") {
    for (const capability of ["run_command", "preview_patch", "commit_patch", "test"] as const) {
      if (value.capabilities[capability]) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", capability],
          message: `readonly_local cannot enable ${capability}`,
        });
      }
    }
  }
});
export type WorkspaceHandle = z.infer<typeof WorkspaceHandleSchema>;

// A Host-owned, read-only description of where a registered project lives.
// Clients may display this value, but no mutation contract accepts it as a
// capability or filesystem path. Directory registration is performed by the
// local Host picker instead.
export const ProjectLocationSchema = z.object({
  kind: z.enum(["managed_storage", "linked_directory", "temporary"]),
  display_path: NonEmptyStringSchema,
  can_reveal: z.boolean(),
  access: z.enum(["read_write", "read_only"]),
});
export type ProjectLocation = z.infer<typeof ProjectLocationSchema>;

// Safe browser-facing project metadata. The opaque handle identity remains
// absent. `location` is informational only and is never accepted as an input
// to a run or project registration command.
export const ProjectSummarySchema = z.object({
  project_id: IdentifierSchema,
  label: NonEmptyStringSchema,
  workspace_kind: WorkspaceKindSchema,
  capabilities: CapabilityProfileSchema,
  location: ProjectLocationSchema.optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const READONLY_LOCAL_CAPABILITIES = Object.freeze({
  index: true,
  read: true,
  search: true,
  run_command: false,
  preview_patch: false,
  commit_patch: false,
  test: false,
}) satisfies CapabilityProfile;

export const DISPOSABLE_FIXTURE_CAPABILITIES = Object.freeze({
  index: true,
  read: true,
  search: true,
  run_command: true,
  preview_patch: true,
  commit_patch: true,
  test: true,
}) satisfies CapabilityProfile;

export const MANAGED_LOCAL_CAPABILITIES = DISPOSABLE_FIXTURE_CAPABILITIES;
