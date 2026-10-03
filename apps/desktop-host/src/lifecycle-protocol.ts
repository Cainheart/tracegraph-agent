import { isAbsolute } from "node:path";
import { SessionRecoveryReportSchema, WorkspaceHandleSchema } from "@tracegraph/contracts";
import { z } from "zod";

const VersionSchema = z.string().min(1).max(128);

export const DesktopHostStartMessageSchema = z.object({
  kind: z.literal("start"),
  expected_host_version: VersionSchema,
  protocol_version: VersionSchema,
  data_dir: z.string().min(1).max(4_096).refine(isAbsolute, "data_dir must be absolute"),
  projects: z.array(z.object({ workspace: WorkspaceHandleSchema }).strict()).max(128),
}).strict();
export type DesktopHostStartMessage = z.infer<typeof DesktopHostStartMessageSchema>;

export const DesktopHostReadyMessageSchema = z.object({
  kind: z.literal("ready"),
  package_name: z.literal("@tracegraph/desktop-host"),
  package_version: VersionSchema,
  protocol_version: VersionSchema,
  session_recovery: SessionRecoveryReportSchema,
}).strict();
export type DesktopHostReadyMessage = z.infer<typeof DesktopHostReadyMessageSchema>;

export const DesktopHostStartupErrorSchema = z.object({
  kind: z.literal("startup_error"),
  code: z.enum(["version_mismatch", "invalid_start", "startup_failed"]),
  message: z.string().min(1).max(500),
  actual_host_version: VersionSchema.optional(),
  actual_protocol_version: VersionSchema.optional(),
}).strict();
export type DesktopHostStartupErrorMessage = z.infer<typeof DesktopHostStartupErrorSchema>;
