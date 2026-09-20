import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

export const SANDBOX_REPORT_FORMAT_VERSION = 1 as const;
export const MAX_SANDBOX_REPORT_ITEMS = 32;
export const MAX_SANDBOX_REPORT_ITEM_LENGTH = 500;

/**
 * The requested execution boundary. A missing platform backend must not
 * silently widen this value; the report records that case as `none` with an
 * explicit unmet constraint.
 */
export const SandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const SandboxEnforcementSchema = z.enum(["full", "partial", "none"]);
export type SandboxEnforcement = z.infer<typeof SandboxEnforcementSchema>;

export const SandboxPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export type SandboxPlatform = z.infer<typeof SandboxPlatformSchema>;

const SandboxReportItemSchema = NonEmptyStringSchema.max(MAX_SANDBOX_REPORT_ITEM_LENGTH);

function uniqueReportItems(
  field: "mechanisms" | "unmet_constraints",
  items: string[],
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item)) {
      context.addIssue({
        code: "custom",
        path: [field, index],
        message: `${field} entries must be unique`,
      });
    }
    seen.add(item);
  });
}

/**
 * Durable, provider-independent evidence of the boundary that was actually
 * applied. `mechanisms` lists active controls; `unmet_constraints` lists the
 * requested controls that could not be enforced. The version lets persisted
 * reports evolve independently from SessionEvent v1.
 */
export const SandboxReportSchema = z.object({
  report_version: z.literal(SANDBOX_REPORT_FORMAT_VERSION),
  mode: SandboxModeSchema,
  enforcement: SandboxEnforcementSchema,
  platform: SandboxPlatformSchema,
  mechanisms: z.array(SandboxReportItemSchema).max(MAX_SANDBOX_REPORT_ITEMS),
  unmet_constraints: z.array(SandboxReportItemSchema).max(MAX_SANDBOX_REPORT_ITEMS),
}).strict().superRefine((value, context) => {
  uniqueReportItems("mechanisms", value.mechanisms, context);
  uniqueReportItems("unmet_constraints", value.unmet_constraints, context);

  if (value.mode === "danger-full-access") {
    if (value.enforcement !== "none") {
      context.addIssue({
        code: "custom",
        path: ["enforcement"],
        message: "danger-full-access cannot claim sandbox enforcement",
      });
    }
    if (value.mechanisms.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["mechanisms"],
        message: "danger-full-access cannot claim active sandbox mechanisms",
      });
    }
  }

  if (value.enforcement === "full") {
    if (value.mechanisms.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["mechanisms"],
        message: "full enforcement requires at least one active mechanism",
      });
    }
    if (value.unmet_constraints.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["unmet_constraints"],
        message: "full enforcement cannot have unmet constraints",
      });
    }
  }

  if (value.enforcement === "partial") {
    if (value.mechanisms.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["mechanisms"],
        message: "partial enforcement requires at least one active mechanism",
      });
    }
    if (value.unmet_constraints.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["unmet_constraints"],
        message: "partial enforcement requires at least one unmet constraint",
      });
    }
  }

  if (value.enforcement === "none") {
    if (value.mechanisms.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["mechanisms"],
        message: "no enforcement cannot claim active sandbox mechanisms",
      });
    }
    if (value.mode !== "danger-full-access" && value.unmet_constraints.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["unmet_constraints"],
        message: "an unenforced restricted mode must name its unmet constraints",
      });
    }
  }
});
export type SandboxReport = z.infer<typeof SandboxReportSchema>;

export const SandboxConfiguredDataSchema = z.object({
  mode: SandboxModeSchema,
  platform: SandboxPlatformSchema,
}).strict();
export type SandboxConfiguredData = z.infer<typeof SandboxConfiguredDataSchema>;

export const SandboxEnforcedDataSchema = z.object({
  sandbox_report: SandboxReportSchema,
}).strict().superRefine((value, context) => {
  if (value.sandbox_report.enforcement === "none") {
    context.addIssue({
      code: "custom",
      path: ["sandbox_report", "enforcement"],
      message: "sandbox.enforced requires full or partial enforcement",
    });
  }
});
export type SandboxEnforcedData = z.infer<typeof SandboxEnforcedDataSchema>;

export const SandboxDisabledReasonSchema = z.enum([
  "explicit_danger_full_access",
  "enforcement_unavailable",
]);
export type SandboxDisabledReason = z.infer<typeof SandboxDisabledReasonSchema>;

export const SandboxDisabledDataSchema = z.object({
  reason: SandboxDisabledReasonSchema,
  sandbox_report: SandboxReportSchema,
}).strict().superRefine((value, context) => {
  if (value.sandbox_report.enforcement !== "none") {
    context.addIssue({
      code: "custom",
      path: ["sandbox_report", "enforcement"],
      message: "sandbox.disabled requires enforcement none",
    });
  }
  if (
    value.reason === "explicit_danger_full_access"
    && value.sandbox_report.mode !== "danger-full-access"
  ) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "explicit danger-full-access requires the danger-full-access mode",
    });
  }
  if (
    value.reason === "enforcement_unavailable"
    && value.sandbox_report.mode === "danger-full-access"
  ) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "danger-full-access is an explicit choice, not unavailable enforcement",
    });
  }
});
export type SandboxDisabledData = z.infer<typeof SandboxDisabledDataSchema>;
