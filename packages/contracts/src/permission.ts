import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
  Sha256Schema,
  ToolNameSchema,
} from "./common.js";
import { BUILTIN_TOOL_NAMES } from "./action.js";
import { SandboxModeSchema } from "./sandbox.js";
import { ToolSideEffectSchema } from "./tool.js";

export const PERMISSION_PRESET_FORMAT_VERSION = 1 as const;
export const PERMISSION_POLICY_FORMAT_VERSION = 1 as const;
export const APPROVAL_TOKEN_FORMAT_VERSION = 1 as const;
export const MAX_PERMISSION_TOOLS = 256;
export const MAX_PERMISSION_PATH_SCOPES = 64;
export const MAX_POLICY_RULES = 256;
export const MAX_POLICY_SESSION_TAGS = 32;

/**
 * Policy tool names deliberately are not limited to today's built-in ToolName
 * enum. Future MCP tools use the same Host-owned policy boundary.
 */
export const PolicyToolNameSchema = ToolNameSchema;
export type PolicyToolName = z.infer<typeof PolicyToolNameSchema>;

/** POSIX-style, workspace-relative glob. Matching and symlink checks remain Host-owned. */
export const PolicyPathGlobSchema = NonEmptyStringSchema
  .max(500)
  .refine(
    (value) => (
      !value.startsWith("/")
      && !value.startsWith("\\")
      && !/^[A-Za-z]:/u.test(value)
      && !value.includes("\\")
      && !value.split("/").includes("..")
      && !/[\u0000-\u001f\u007f]/u.test(value)
    ),
    { message: "policy path glob must be a safe workspace-relative POSIX glob" },
  );
export type PolicyPathGlob = z.infer<typeof PolicyPathGlobSchema>;

export const PermissionPresetKeySchema = z.enum([
  "read-only",
  "workspace-write",
  "full-write",
  "custom",
]);
export type PermissionPresetKey = z.infer<typeof PermissionPresetKeySchema>;

export const BuiltinPermissionPresetKeySchema = z.enum([
  "read-only",
  "workspace-write",
  "full-write",
]);
export type BuiltinPermissionPresetKey = z.infer<typeof BuiltinPermissionPresetKeySchema>;

export const ApprovalPolicySchema = z.enum(["never", "on-write", "always"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

function validateBuiltinPresetPair(
  value: {
    key: PermissionPresetKey;
    sandbox_mode: z.infer<typeof SandboxModeSchema>;
    approval_policy: ApprovalPolicy;
  },
  context: z.core.$RefinementCtx,
): void {
  const expected = value.key === "read-only"
    ? { sandboxMode: "read-only", approvalPolicy: "never" }
    : value.key === "workspace-write"
      ? { sandboxMode: "workspace-write", approvalPolicy: "on-write" }
      : value.key === "full-write"
        ? { sandboxMode: "danger-full-access", approvalPolicy: "never" }
        : undefined;
  if (expected === undefined) return;
  if (value.sandbox_mode !== expected.sandboxMode) {
    context.addIssue({
      code: "custom",
      path: ["sandbox_mode"],
      message: `${value.key} requires sandbox_mode=${expected.sandboxMode}`,
    });
  }
  if (value.approval_policy !== expected.approvalPolicy) {
    context.addIssue({
      code: "custom",
      path: ["approval_policy"],
      message: `${value.key} requires approval_policy=${expected.approvalPolicy}`,
    });
  }
}

const UniqueAllowedToolsSchema = z.array(PolicyToolNameSchema)
  .max(MAX_PERMISSION_TOOLS)
  .superRefine((tools, context) => {
    if (new Set(tools).size !== tools.length) {
      context.addIssue({ code: "custom", message: "allowed_tools entries must be unique" });
    }
  });

const UniquePathScopesSchema = z.array(PolicyPathGlobSchema)
  .min(1)
  .max(MAX_PERMISSION_PATH_SCOPES)
  .superRefine((paths, context) => {
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "path_scope entries must be unique" });
    }
  });

/** A resolved named preset. Built-in names cannot misrepresent their sandbox/approval pair. */
export const PermissionPresetSchema = z.object({
  preset_version: z.literal(PERMISSION_PRESET_FORMAT_VERSION),
  key: PermissionPresetKeySchema,
  label: NonEmptyStringSchema.max(100),
  sandbox_mode: SandboxModeSchema,
  approval_policy: ApprovalPolicySchema,
  allowed_tools: UniqueAllowedToolsSchema,
  path_scope: UniquePathScopesSchema,
}).strict().superRefine(validateBuiltinPresetPair);
export type PermissionPreset = z.infer<typeof PermissionPresetSchema>;

export const DEFAULT_PERMISSION_PRESET_KEY: BuiltinPermissionPresetKey = "workspace-write";

function freezePermissionPreset(preset: PermissionPreset): Readonly<PermissionPreset> {
  Object.freeze(preset.allowed_tools);
  Object.freeze(preset.path_scope);
  return Object.freeze(preset);
}

export const BUILTIN_PERMISSION_PRESETS = Object.freeze({
  "read-only": freezePermissionPreset(PermissionPresetSchema.parse({
    preset_version: PERMISSION_PRESET_FORMAT_VERSION,
    key: "read-only",
    label: "Read only",
    sandbox_mode: "read-only",
    approval_policy: "never",
    allowed_tools: BUILTIN_TOOL_NAMES.filter((tool) => tool !== "commit_patch"),
    path_scope: ["**"],
  })),
  "workspace-write": freezePermissionPreset(PermissionPresetSchema.parse({
    preset_version: PERMISSION_PRESET_FORMAT_VERSION,
    key: "workspace-write",
    label: "Workspace write",
    sandbox_mode: "workspace-write",
    approval_policy: "on-write",
    allowed_tools: [...BUILTIN_TOOL_NAMES],
    path_scope: ["**"],
  })),
  "full-write": freezePermissionPreset(PermissionPresetSchema.parse({
    preset_version: PERMISSION_PRESET_FORMAT_VERSION,
    key: "full-write",
    label: "Full write",
    sandbox_mode: "danger-full-access",
    approval_policy: "never",
    allowed_tools: [...BUILTIN_TOOL_NAMES],
    path_scope: ["**"],
  })),
});

const SessionTagSchema = NonEmptyStringSchema.max(80);

export const PolicyRuleWhenSchema = z.object({
  tool: PolicyToolNameSchema.optional(),
  side_effect: ToolSideEffectSchema.optional(),
  path_glob: PolicyPathGlobSchema.optional(),
  max_diff_lines: z.number().int().nonnegative().max(1_000_000).optional(),
  session_tags: z.array(SessionTagSchema).max(MAX_POLICY_SESSION_TAGS).superRefine((tags, context) => {
    if (new Set(tags).size !== tags.length) {
      context.addIssue({ code: "custom", message: "session_tags entries must be unique" });
    }
  }).optional(),
}).strict();
export type PolicyRuleWhen = z.infer<typeof PolicyRuleWhenSchema>;

export const PolicyDecisionKindSchema = z.enum(["allow", "deny", "ask"]);
export type PolicyDecisionKind = z.infer<typeof PolicyDecisionKindSchema>;

export const PolicyRuleSchema = z.object({
  rule_id: IdentifierSchema,
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  when: PolicyRuleWhenSchema,
  then: PolicyDecisionKindSchema,
  explanation: NonEmptyStringSchema.max(1_000),
}).strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

const PolicyRulesSchema = z.array(PolicyRuleSchema).max(MAX_POLICY_RULES).superRefine((rules, context) => {
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    if (seen.has(rule.rule_id)) {
      context.addIssue({
        code: "custom",
        path: [index, "rule_id"],
        message: "policy rule_id values must be unique",
      });
    }
    seen.add(rule.rule_id);
  });
});

export const PolicyDocumentSchema = z.object({
  policy_version: z.literal(PERMISSION_POLICY_FORMAT_VERSION),
  rules: PolicyRulesSchema.default([]),
}).strict();
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/** Fully resolved, immutable policy input used by one Runtime. */
export const EffectivePermissionPolicySchema = z.object({
  policy_version: z.literal(PERMISSION_POLICY_FORMAT_VERSION),
  preset: PermissionPresetSchema,
  // The origin boundary is durable. A project rule may only narrow the Host
  // layer, so flattening the arrays would make a restart capable of changing
  // the result when priorities differ.
  host_rules: PolicyRulesSchema,
  project_rules: PolicyRulesSchema,
  policy_digest: Sha256Schema,
}).strict().superRefine((value, context) => {
  const hostRuleIds = new Set(value.host_rules.map(({ rule_id: ruleId }) => ruleId));
  value.project_rules.forEach((rule, index) => {
    if (hostRuleIds.has(rule.rule_id)) {
      context.addIssue({
        code: "custom",
        path: ["project_rules", index, "rule_id"],
        message: "rule_id values must be unique across Host and project policy layers",
      });
    }
    if (rule.then === "allow") {
      context.addIssue({
        code: "custom",
        path: ["project_rules", index, "then"],
        message: "project policy rules may only narrow access with ask or deny",
      });
    }
  });
});
export type EffectivePermissionPolicy = z.infer<typeof EffectivePermissionPolicySchema>;

/** Bounded public snapshot; full rule documents stay on the Host side. */
export const PermissionSnapshotSchema = z.object({
  preset_key: PermissionPresetKeySchema,
  label: NonEmptyStringSchema.max(100),
  sandbox_mode: SandboxModeSchema,
  approval_policy: ApprovalPolicySchema,
  policy_digest: Sha256Schema,
}).strict().superRefine((value, context) => validateBuiltinPresetPair({
  key: value.preset_key,
  sandbox_mode: value.sandbox_mode,
  approval_policy: value.approval_policy,
}, context));
export type PermissionSnapshot = z.infer<typeof PermissionSnapshotSchema>;

export const PermissionPresetOptionSchema = z.object({
  key: BuiltinPermissionPresetKeySchema,
  label: NonEmptyStringSchema.max(100),
  sandbox_mode: SandboxModeSchema,
  approval_policy: ApprovalPolicySchema,
}).strict().superRefine(validateBuiltinPresetPair);
export type PermissionPresetOption = z.infer<typeof PermissionPresetOptionSchema>;

export const PermissionSettingsSourceSchema = z.enum([
  "default",
  "cli",
  "environment",
  "user-config",
  "project-policy",
  "combined",
]);
export type PermissionSettingsSource = z.infer<typeof PermissionSettingsSourceSchema>;

/** Browser-safe settings snapshot. Rules, path scopes, and local config paths are excluded. */
export const PermissionSettingsResponseSchema = z.object({
  active_preset: PermissionPresetKeySchema,
  sandbox_mode: SandboxModeSchema,
  approval_policy: ApprovalPolicySchema,
  policy_digest: Sha256Schema,
  ceiling: BuiltinPermissionPresetKeySchema,
  available_presets: z.array(PermissionPresetOptionSchema).min(1).max(3),
  source: PermissionSettingsSourceSchema,
  locked: z.boolean(),
  lock_reason: NonEmptyStringSchema.max(500).optional(),
}).strict().superRefine((value, context) => {
  const keys = value.available_presets.map(({ key }) => key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["available_presets"], message: "available preset keys must be unique" });
  }
  if (value.active_preset !== "custom" && !keys.includes(value.active_preset)) {
    context.addIssue({ code: "custom", path: ["active_preset"], message: "active built-in preset must be available" });
  }
  validateBuiltinPresetPair({
    key: value.active_preset,
    sandbox_mode: value.sandbox_mode,
    approval_policy: value.approval_policy,
  }, context);
  const rank: Readonly<Record<BuiltinPermissionPresetKey, number>> = {
    "read-only": 0,
    "workspace-write": 1,
    "full-write": 2,
  };
  if (value.active_preset !== "custom" && rank[value.active_preset] > rank[value.ceiling]) {
    context.addIssue({ code: "custom", path: ["active_preset"], message: "active preset exceeds the Host ceiling" });
  }
  value.available_presets.forEach((preset, index) => {
    if (rank[preset.key] > rank[value.ceiling]) {
      context.addIssue({
        code: "custom",
        path: ["available_presets", index, "key"],
        message: "available preset exceeds the Host ceiling",
      });
    }
  });
  if (value.locked !== (value.lock_reason !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["lock_reason"],
      message: "locked settings require lock_reason and unlocked settings must omit it",
    });
  }
});
export type PermissionSettingsResponse = z.infer<typeof PermissionSettingsResponseSchema>;

export const PermissionPresetUpdateRequestSchema = z.object({
  command_id: IdentifierSchema,
  preset_key: BuiltinPermissionPresetKeySchema,
}).strict();
export type PermissionPresetUpdateRequest = z.infer<typeof PermissionPresetUpdateRequestSchema>;

export const PolicyDecisionSourceSchema = z.enum([
  "hard-constraint",
  "configured-rule",
  "preset-default",
]);
export type PolicyDecisionSource = z.infer<typeof PolicyDecisionSourceSchema>;

export const PolicyDecisionSchema = z.object({
  decision_id: IdentifierSchema,
  preset_key: PermissionPresetKeySchema,
  policy_digest: Sha256Schema,
  tool_name: PolicyToolNameSchema,
  side_effect: ToolSideEffectSchema,
  kind: PolicyDecisionKindSchema,
  source: PolicyDecisionSourceSchema,
  matched_rule_id: IdentifierSchema.optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  explanation: NonEmptyStringSchema.max(1_000),
  action_digest: Sha256Schema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.matched_rule_id === undefined) !== (value.priority === undefined)) {
    context.addIssue({
      code: "custom",
      message: "matched_rule_id and priority must either both be present or both be absent",
    });
  }
  if (value.source === "configured-rule" && value.matched_rule_id === undefined) {
    context.addIssue({
      code: "custom",
      path: ["matched_rule_id"],
      message: "configured-rule decisions require matched_rule_id and priority",
    });
  }
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const PermissionConfiguredDataSchema = z.object({
  permission: PermissionSnapshotSchema,
}).strict();
export type PermissionConfiguredData = z.infer<typeof PermissionConfiguredDataSchema>;

export const PolicyEvaluatedDataSchema = z.object({
  decision: PolicyDecisionSchema,
}).strict();
export type PolicyEvaluatedData = z.infer<typeof PolicyEvaluatedDataSchema>;

export const PolicyDeniedDataSchema = z.object({
  decision: PolicyDecisionSchema,
  code: NonEmptyStringSchema.max(160),
  /** Stable machine reason for hard orchestration constraints such as Plan Mode. */
  reason: z.enum(["plan_mode", "subagent_tool_allowlist", "skill_tool_allowlist"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision.kind !== "deny") {
    context.addIssue({ code: "custom", path: ["decision", "kind"], message: "policy.denied requires a deny decision" });
  }
});
export type PolicyDeniedData = z.infer<typeof PolicyDeniedDataSchema>;

export const ApprovalOutcomeSchema = z.enum([
  "allowed-once",
  "rejected",
  "cancelled",
  "unavailable",
]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

export const ApprovalDenialReasonSchema = z.enum([
  "rejected",
  "cancelled",
  "unavailable",
  "digest_mismatch",
  "token_expired",
  "token_consumed",
]);
export type ApprovalDenialReason = z.infer<typeof ApprovalDenialReasonSchema>;

const ApprovalScopeSchema = z.array(RelativePathSchema)
  .min(1)
  .max(MAX_PERMISSION_PATH_SCOPES)
  .superRefine((scope, context) => {
    if (new Set(scope).size !== scope.length) {
      context.addIssue({ code: "custom", message: "approval token scope entries must be unique" });
    }
  });

/** Public claims for a Host-owned, opaque, atomically consumed token. */
export const ApprovalTokenSchema = z.object({
  token_version: z.literal(APPROVAL_TOKEN_FORMAT_VERSION),
  token_id: IdentifierSchema,
  approval_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  action_id: IdentifierSchema,
  action_digest: Sha256Schema,
  policy_digest: Sha256Schema,
  scope: ApprovalScopeSchema,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  single_use: z.literal(true),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "approval token must expire after it is issued" });
  }
});
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;

export const ApprovalRequestedDataSchema = z.object({
  approval_id: IdentifierSchema,
  action_id: IdentifierSchema,
  tool_name: PolicyToolNameSchema,
  action_digest: Sha256Schema,
  policy_digest: Sha256Schema,
  expires_at: IsoDateTimeSchema,
}).strict();
export type ApprovalRequestedData = z.infer<typeof ApprovalRequestedDataSchema>;

export const ApprovalGrantedDataSchema = z.object({
  outcome: z.literal("allowed-once"),
  token: ApprovalTokenSchema,
}).strict();
export type ApprovalGrantedData = z.infer<typeof ApprovalGrantedDataSchema>;

export const ApprovalDeniedDataSchema = z.object({
  approval_id: IdentifierSchema,
  action_id: IdentifierSchema,
  action_digest: Sha256Schema,
  outcome: z.enum(["rejected", "cancelled", "unavailable"]),
  reason: ApprovalDenialReasonSchema,
  explanation: NonEmptyStringSchema.max(1_000),
}).strict().superRefine((value, context) => {
  const expectedOutcome = value.reason === "rejected"
    ? "rejected"
    : value.reason === "cancelled"
      ? "cancelled"
      : "unavailable";
  if (value.outcome !== expectedOutcome) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: `${value.reason} requires outcome=${expectedOutcome}`,
    });
  }
});
export type ApprovalDeniedData = z.infer<typeof ApprovalDeniedDataSchema>;

export const ApprovalExpiredDataSchema = z.object({
  approval_id: IdentifierSchema,
  action_id: IdentifierSchema,
  action_digest: Sha256Schema,
  expired_at: IsoDateTimeSchema,
}).strict();
export type ApprovalExpiredData = z.infer<typeof ApprovalExpiredDataSchema>;
