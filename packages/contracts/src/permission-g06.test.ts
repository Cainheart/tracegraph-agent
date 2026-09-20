import { describe, expect, it } from "vitest";
import {
  ApprovalBoundGrantSchema,
  ApprovalBoundValidatedActionSchema,
  ApprovalDeniedDataSchema,
  ApprovalTokenSchema,
  BoundPendingApprovalSchema,
  BoundRunRecoveryStateSchema,
  BUILTIN_PERMISSION_PRESETS,
  DEFAULT_PERMISSION_PRESET_KEY,
  EffectivePermissionPolicySchema,
  EventTypeSchema,
  LegacyPendingApprovalSchema,
  LegacyRunRecoveryStateSchema,
  PendingApprovalSchema,
  PermissionConfiguredDataSchema,
  PermissionPresetSchema,
  PermissionPresetUpdateRequestSchema,
  PermissionSettingsResponseSchema,
  PolicyDecisionSchema,
  PolicyDeniedDataSchema,
  PolicyDocumentSchema,
  PolicyEvaluatedDataSchema,
  PROJECTOR_VERSION,
  RunProjectionSchema,
  RunRecoveryStateSchema,
  StartRunRequestSchema,
  ValidatedActionSchema,
} from "./index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const ISSUED_AT = "2026-09-19T10:00:00.000+08:00";
const EXPIRES_AT = "2026-09-19T10:05:00.000+08:00";

function preview() {
  return {
    preview_id: "preview:g06",
    action_id: "action:g06",
    path: "src/index.ts",
    diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-old\n+new\n",
    base_hash: HASH_A,
    patch_hash: HASH_B,
    scope: ["src/index.ts"],
    expires_at: EXPIRES_AT,
  } as const;
}

function decision(kind: "allow" | "deny" | "ask" = "ask") {
  return {
    decision_id: "policy-decision:g06",
    preset_key: "workspace-write",
    policy_digest: HASH_A,
    tool_name: "commit_patch",
    side_effect: "write",
    kind,
    source: "configured-rule",
    matched_rule_id: "rule:write-approval",
    priority: 100,
    explanation: "Workspace writes require one-time approval.",
    action_digest: HASH_B,
  } as const;
}

describe("G-06 permission contracts", () => {
  it("defines honest, bounded built-in permission presets", () => {
    expect(DEFAULT_PERMISSION_PRESET_KEY).toBe("workspace-write");
    expect(BUILTIN_PERMISSION_PRESETS["read-only"]).toMatchObject({
      sandbox_mode: "read-only",
      approval_policy: "never",
    });
    expect(BUILTIN_PERMISSION_PRESETS["workspace-write"]).toMatchObject({
      sandbox_mode: "workspace-write",
      approval_policy: "on-write",
    });
    expect(BUILTIN_PERMISSION_PRESETS["full-write"]).toMatchObject({
      sandbox_mode: "danger-full-access",
      approval_policy: "never",
    });
    expect(BUILTIN_PERMISSION_PRESETS["read-only"].allowed_tools).not.toContain("commit_patch");

    expect(() => PermissionPresetSchema.parse({
      ...BUILTIN_PERMISSION_PRESETS["read-only"],
      sandbox_mode: "danger-full-access",
    })).toThrow(/requires sandbox_mode=read-only/u);
    expect(() => PermissionPresetSchema.parse({
      ...BUILTIN_PERMISSION_PRESETS["workspace-write"],
      approval_policy: "never",
    })).toThrow(/requires approval_policy=on-write/u);
    expect(() => PermissionPresetSchema.parse({
      ...BUILTIN_PERMISSION_PRESETS["workspace-write"],
      allowed_tools: ["read_file", "read_file"],
    })).toThrow(/must be unique/u);
    expect(() => PermissionPresetSchema.parse({
      ...BUILTIN_PERMISSION_PRESETS["workspace-write"],
      path_scope: ["../outside"],
    })).toThrow(/workspace-relative/u);
    expect(() => PermissionPresetSchema.parse({
      ...BUILTIN_PERMISSION_PRESETS["workspace-write"],
      injected: true,
    })).toThrow();
  });

  it("validates strict policy documents and explainable decisions", () => {
    const rule = {
      rule_id: "rule:write-approval",
      priority: 100,
      when: {
        tool: "future_mcp__write",
        side_effect: "write",
        path_glob: "src/**",
        max_diff_lines: 200,
        session_tags: ["interactive"],
      },
      then: "ask",
      explanation: "Workspace writes require one-time approval.",
    } as const;
    const document = PolicyDocumentSchema.parse({ policy_version: 1, rules: [rule] });
    expect(document.rules[0]?.when.tool).toBe("future_mcp__write");
    expect(() => PolicyDocumentSchema.parse({ policy_version: 1, rules: [rule, rule] }))
      .toThrow(/rule_id values must be unique/u);
    expect(() => PolicyDocumentSchema.parse({
      policy_version: 1,
      rules: [{ ...rule, when: { path_glob: "/etc/**" } }],
    })).toThrow(/workspace-relative/u);

    expect(PolicyDecisionSchema.parse(decision()).matched_rule_id).toBe("rule:write-approval");
    expect(() => PolicyDecisionSchema.parse({
      ...decision(),
      priority: undefined,
    })).toThrow(/both be present/u);
    expect(() => PolicyDecisionSchema.parse({
      ...decision(),
      explanation: "",
    })).toThrow();

    expect(PolicyEvaluatedDataSchema.parse({ decision: decision() }).decision.kind).toBe("ask");
    expect(PolicyDeniedDataSchema.parse({ decision: decision("deny"), code: "preset_denied" })
      .decision.kind).toBe("deny");
    expect(PolicyDeniedDataSchema.parse({
      decision: decision("deny"),
      code: "plan_mode_denied",
      reason: "plan_mode",
    }).reason).toBe("plan_mode");
    expect(() => PolicyDeniedDataSchema.parse({
      decision: decision("deny"),
      code: "plan_mode_denied",
      reason: "untrusted_reason",
    })).toThrow();
    expect(() => PolicyDeniedDataSchema.parse({ decision: decision("allow"), code: "bad" }))
      .toThrow(/requires a deny decision/u);
  });

  it("keeps public permission settings bounded and excludes custom updates", () => {
    const settings = PermissionSettingsResponseSchema.parse({
      active_preset: "workspace-write",
      sandbox_mode: "workspace-write",
      approval_policy: "on-write",
      policy_digest: HASH_A,
      ceiling: "workspace-write",
      available_presets: [
        {
          key: "read-only",
          label: "Read only",
          sandbox_mode: "read-only",
          approval_policy: "never",
        },
        {
          key: "workspace-write",
          label: "Workspace write",
          sandbox_mode: "workspace-write",
          approval_policy: "on-write",
        },
      ],
      source: "default",
      locked: false,
    });
    expect(settings).not.toHaveProperty("rules");
    expect(settings).not.toHaveProperty("path_scope");
    expect(() => PermissionSettingsResponseSchema.parse({ ...settings, locked: true }))
      .toThrow(/require lock_reason/u);
    expect(() => PermissionSettingsResponseSchema.parse({ ...settings, rules: [] })).toThrow();
    expect(PermissionPresetUpdateRequestSchema.parse({
      command_id: "command:g06",
      preset_key: "read-only",
    }).preset_key).toBe("read-only");
    expect(() => PermissionPresetUpdateRequestSchema.parse({
      command_id: "command:g06",
      preset_key: "custom",
    })).toThrow();
  });

  it("binds approval token claims and denial outcomes", () => {
    const token = ApprovalTokenSchema.parse({
      token_version: 1,
      token_id: "approval-token:g06",
      approval_id: "approval:g06",
      project_id: "project:g06",
      run_id: "run:g06",
      action_id: "action:g06",
      action_digest: HASH_B,
      policy_digest: HASH_A,
      scope: ["src/index.ts"],
      issued_at: ISSUED_AT,
      expires_at: EXPIRES_AT,
      single_use: true,
    });
    expect(token.single_use).toBe(true);
    expect(() => ApprovalTokenSchema.parse({ ...token, single_use: false })).toThrow();
    expect(() => ApprovalTokenSchema.parse({ ...token, expires_at: ISSUED_AT })).toThrow(/expire after/u);
    expect(() => ApprovalTokenSchema.parse({ ...token, bearer_secret: "must-not-cross-wire" })).toThrow();

    expect(ApprovalDeniedDataSchema.parse({
      approval_id: "approval:g06",
      action_id: "action:g06",
      action_digest: HASH_B,
      outcome: "unavailable",
      reason: "digest_mismatch",
      explanation: "The approved action digest no longer matches.",
    }).outcome).toBe("unavailable");
    expect(() => ApprovalDeniedDataSchema.parse({
      approval_id: "approval:g06",
      action_id: "action:g06",
      action_digest: HASH_B,
      outcome: "rejected",
      reason: "token_consumed",
      explanation: "The token was already consumed.",
    })).toThrow(/requires outcome=unavailable/u);
  });

  it("keeps legacy actions readable and requires full bindings for the new flow", () => {
    const legacyAction = {
      action_id: "action:g06",
      tool_name: "commit_patch",
      arguments: {},
      project_id: "project:g06",
      run_id: "run:g06",
      workspace_handle_id: "workspace:g06",
      validated_at: ISSUED_AT,
      approval_id: "approval:g06",
    } as const;
    expect(ValidatedActionSchema.parse(legacyAction).approval_token_id).toBeUndefined();
    expect(() => ApprovalBoundValidatedActionSchema.parse(legacyAction)).toThrow();
    expect(ApprovalBoundValidatedActionSchema.parse({
      ...legacyAction,
      approval_token_id: "approval-token:g06",
      action_digest: HASH_B,
      policy_digest: HASH_A,
    }).approval_token_id).toBe("approval-token:g06");

    const legacyGrant = {
      approval_id: "approval:g06",
      action_id: "action:g06",
      base_hash: HASH_A,
      patch_hash: HASH_B,
      scope: ["src/index.ts"],
      expires_at: EXPIRES_AT,
      granted_at: ISSUED_AT,
      consumed_at: ISSUED_AT,
    } as const;
    expect(ApprovalBoundGrantSchema.parse({
      ...legacyGrant,
      token_id: "approval-token:g06",
      action_digest: HASH_B,
      policy_digest: HASH_A,
      outcome: "allowed-once",
      single_use: true,
    }).single_use).toBe(true);
    expect(() => ApprovalBoundGrantSchema.parse({
      ...legacyGrant,
      token_id: "approval-token:g06",
      action_digest: HASH_B,
      policy_digest: HASH_A,
      outcome: "allowed-once",
      single_use: true,
      consumed_at: "2026-09-19T10:06:00.000+08:00",
    })).toThrow(/after it expires/u);
  });

  it("replays legacy pending approvals while requiring bindings on new writes", () => {
    const legacy = {
      approval_id: "approval:g06",
      action_id: "action:g06",
      risk: "high",
      preview: preview(),
    } as const;
    expect(LegacyPendingApprovalSchema.parse(legacy).approval_id).toBe("approval:g06");
    expect(PendingApprovalSchema.parse(legacy).approval_id).toBe("approval:g06");
    expect(() => BoundPendingApprovalSchema.parse(legacy)).toThrow();
    const bound = BoundPendingApprovalSchema.parse({
      ...legacy,
      tool_name: "commit_patch",
      action_digest: HASH_B,
      policy_digest: HASH_A,
    });
    expect(PendingApprovalSchema.parse(bound)).toEqual(bound);
  });

  it("versions recovery state and keeps permission projection optional", () => {
    const legacy = {
      version: 1,
      kind: "run_recovery_state",
      task: "Inspect the workspace",
      conversation_history: [],
      mode: "manual",
      reasoning_effort: "default",
    } as const;
    expect(LegacyRunRecoveryStateSchema.parse(legacy).version).toBe(1);
    expect(RunRecoveryStateSchema.parse(legacy).version).toBe(1);

    const effective = EffectivePermissionPolicySchema.parse({
      policy_version: 1,
      preset: BUILTIN_PERMISSION_PRESETS["workspace-write"],
      host_rules: [],
      project_rules: [],
      policy_digest: HASH_A,
    });
    expect(BoundRunRecoveryStateSchema.parse({
      ...legacy,
      version: 2,
      effective_policy: effective,
    }).effective_policy.policy_digest).toBe(HASH_A);

    const hostAllow = {
      rule_id: "rule:host-allow",
      priority: 100,
      when: { tool: "commit_patch" },
      then: "allow",
      explanation: "Host allows this action.",
    } as const;
    const projectDeny = {
      rule_id: "rule:project-deny",
      priority: 1,
      when: { tool: "commit_patch" },
      then: "deny",
      explanation: "Project policy narrows access.",
    } as const;
    expect(EffectivePermissionPolicySchema.parse({
      ...effective,
      host_rules: [hostAllow],
      project_rules: [projectDeny],
    })).toMatchObject({
      host_rules: [{ rule_id: "rule:host-allow" }],
      project_rules: [{ rule_id: "rule:project-deny" }],
    });
    expect(() => EffectivePermissionPolicySchema.parse({
      ...effective,
      host_rules: [hostAllow],
      project_rules: [{ ...projectDeny, rule_id: "rule:host-allow" }],
    })).toThrow(/unique across Host and project/u);
    expect(() => EffectivePermissionPolicySchema.parse({
      ...effective,
      host_rules: [],
      project_rules: [{ ...projectDeny, then: "allow" }],
    })).toThrow(/may only narrow access/u);

    const projection = {
      schema_version: "tracegraph.session-event.v1",
      projector_version: PROJECTOR_VERSION,
      project_id: "project:g06",
      run_id: "run:g06",
      task: "Inspect the workspace",
      mode: "execute",
      workspace_kind: "managed_local",
      status: "running",
      last_sequence: 0,
      timeline: [],
      artifact_refs: [],
    } as const;
    expect(RunProjectionSchema.parse(projection).permission).toBeUndefined();
    const permission = {
      preset_key: "workspace-write",
      label: "Workspace write",
      sandbox_mode: "workspace-write",
      approval_policy: "on-write",
      policy_digest: HASH_A,
    } as const;
    expect(RunProjectionSchema.parse({ ...projection, permission }).permission).toEqual(permission);
    expect(PermissionConfiguredDataSchema.parse({ permission }).permission.preset_key)
      .toBe("workspace-write");
  });

  it("adds permission events without allowing browser privilege smuggling", () => {
    expect(EventTypeSchema.parse("permission.configured")).toBe("permission.configured");
    expect(EventTypeSchema.parse("policy.evaluated")).toBe("policy.evaluated");

    const request = {
      command_id: "command:g06",
      project_id: "project:g06",
      task: "Inspect the workspace",
      mode: "execute",
    } as const;
    expect(StartRunRequestSchema.parse(request)).toEqual(request);
    for (const injected of [
      { permission_preset: "full-write" },
      { sandbox_mode: "danger-full-access" },
      { approval_token: "forged" },
      { policy: { rules: [] } },
    ]) {
      expect(() => StartRunRequestSchema.parse({ ...request, ...injected })).toThrow();
    }
  });
});
