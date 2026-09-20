import {
  PermissionPresetSchema,
  type PolicyRule,
} from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import {
  CORE_BUILTIN_PERMISSION_PRESETS,
  PolicyEngine,
  approvalActionDigest,
  createEffectivePermissionPolicy,
  matchesPolicyGlob,
  permissionPolicyDigest,
  permissionSnapshot,
} from "./policy-engine.js";

describe("PolicyEngine", () => {
  it("exposes the canonical built-in presets and their default decisions", () => {
    const readonly = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["read-only"],
      idFactory: fixedIds(),
    });
    expect(readonly.evaluate({ toolName: "read_file", sideEffect: "read" })).toMatchObject({
      kind: "allow",
      source: "preset-default",
      preset_key: "read-only",
    });
    expect(readonly.evaluate({ toolName: "commit_patch", sideEffect: "write" })).toMatchObject({
      kind: "deny",
      source: "hard-constraint",
      preset_key: "read-only",
    });

    const workspaceWrite = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      idFactory: fixedIds(),
    });
    expect(workspaceWrite.evaluate({ toolName: "commit_patch", sideEffect: "write" })).toMatchObject({
      kind: "ask",
      source: "preset-default",
    });
    expect(workspaceWrite.evaluate({ toolName: "run_test", sideEffect: "execute" })).toMatchObject({
      kind: "allow",
      source: "preset-default",
    });

    const fullWrite = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["full-write"],
      idFactory: fixedIds(),
    });
    expect(fullWrite.evaluate({ toolName: "commit_patch", sideEffect: "write" })).toMatchObject({
      kind: "allow",
      source: "preset-default",
    });
  });

  it("uses priority descending, then deny over ask over allow, then rule id", () => {
    const highPriorityAllow = rule("rule:high-allow", 30, "allow", "High-priority explicit allow");
    const lowerPriorityDeny = rule("rule:lower-deny", 20, "deny", "Lower-priority deny");
    const prioritized = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [lowerPriorityDeny, highPriorityAllow],
      idFactory: fixedIds(),
    });
    expect(prioritized.evaluate({ toolName: "commit_patch", sideEffect: "write" })).toMatchObject({
      kind: "allow",
      matched_rule_id: "rule:high-allow",
      priority: 30,
      explanation: "High-priority explicit allow",
    });

    const tied = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [
        rule("rule:z-ask", 40, "ask", "Ask on ties"),
        rule("rule:z-deny", 40, "deny", "Deny on ties"),
        rule("rule:a-deny", 40, "deny", "Lexically first deny"),
        rule("rule:a-allow", 40, "allow", "Allow on ties"),
      ],
      idFactory: fixedIds(),
    });
    expect(tied.evaluate({ toolName: "read_file", sideEffect: "read" })).toMatchObject({
      kind: "deny",
      matched_rule_id: "rule:a-deny",
      explanation: "Lexically first deny",
    });
  });

  it("matches conjunctive tool, side-effect, glob, diff, and session-tag conditions", () => {
    const conditional: PolicyRule = {
      rule_id: "rule:conditional",
      priority: 50,
      when: {
        tool: "commit_patch",
        side_effect: "write",
        path_glob: "src/**/*.ts",
        max_diff_lines: 20,
        session_tags: ["trusted", "interactive"],
      },
      then: "deny",
      explanation: "Matched every bounded condition",
    };
    const engine = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [conditional],
      idFactory: fixedIds(),
    });

    expect(engine.evaluate({
      toolName: "commit_patch",
      sideEffect: "write",
      path: "src/app.ts",
      diffLines: 20,
      sessionTags: ["interactive", "trusted", "extra"],
    })).toMatchObject({ kind: "deny", matched_rule_id: "rule:conditional" });
    expect(engine.evaluate({
      toolName: "commit_patch",
      sideEffect: "write",
      path: "src/nested/app.ts",
      diffLines: 21,
      sessionTags: ["interactive", "trusted"],
    })).toMatchObject({ kind: "ask", source: "preset-default" });
    expect(engine.evaluate({
      toolName: "commit_patch",
      sideEffect: "write",
      path: "src/nested/app.js",
      diffLines: 10,
      sessionTags: ["interactive", "trusted"],
    })).toMatchObject({ kind: "ask", source: "preset-default" });
  });

  it("allows project policy to narrow but never broaden the Host decision", () => {
    const hostAllow = rule("rule:host-allow", 100, "allow", "Host allows the write");
    const projectAllow = rule("rule:project-allow", 1_000, "allow", "Repository asks to allow");
    const projectAsk = rule("rule:project-ask", -100, "ask", "Repository requires review");
    const projectDeny = rule("rule:project-deny", -200, "deny", "Repository denies the write");

    const narrowedToAsk = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [hostAllow],
      projectRules: [projectAsk],
      idFactory: fixedIds(),
    });
    expect(narrowedToAsk.evaluate({ toolName: "commit_patch", sideEffect: "write" })).toMatchObject({
      kind: "ask",
      matched_rule_id: "rule:project-ask",
    });

    const narrowedToDeny = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [hostAllow],
      projectRules: [projectDeny],
      idFactory: fixedIds(),
    });
    expect(narrowedToDeny.evaluate({ toolName: "commit_patch", sideEffect: "write" })).toMatchObject({
      kind: "deny",
      matched_rule_id: "rule:project-deny",
    });

    expect(() => new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      projectRules: [projectAllow],
    })).toThrowError(expect.objectContaining({ code: "project_rule_broadens" }));
  });

  it("applies non-delegable capability, plan, preset, sandbox, path, and invalid-path denials", () => {
    const allowCommit = rule("rule:allow-commit", 1_000, "allow", "Try to bypass hard constraints");
    const readonly = new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["read-only"],
      rules: [allowCommit],
      idFactory: fixedIds(),
    });
    expect(readonly.evaluate({ toolName: "commit_patch", sideEffect: "write" })).toMatchObject({
      kind: "deny",
      source: "hard-constraint",
    });

    const scoped = new PolicyEngine({
      preset: customPreset({ allowedTools: ["read_file", "preview_patch"], pathScope: ["src/**"] }),
      rules: [rule("rule:allow", 1_000, "allow", "Configured allow")],
      idFactory: fixedIds(),
    });
    expect(scoped.evaluate({
      toolName: "read_file",
      sideEffect: "read",
      capabilityAllowed: false,
      path: "src/app.ts",
    })).toMatchObject({ kind: "deny", source: "hard-constraint" });
    expect(scoped.evaluate({ toolName: "preview_patch", sideEffect: "read", runMode: "plan", path: "src/app.ts" }))
      .toMatchObject({ kind: "deny", explanation: expect.stringContaining("plan mode") });
    expect(scoped.evaluate({ toolName: "read_file", sideEffect: "read", path: "README.md" }))
      .toMatchObject({ kind: "deny", explanation: expect.stringContaining("outside") });
    expect(scoped.evaluate({ toolName: "read_file", sideEffect: "read", path: "../secret" }))
      .toMatchObject({ kind: "deny", explanation: expect.stringContaining("invalid") });
  });

  it("canonicalizes policy and action digests without exposing source values", () => {
    const firstRule = rule("rule:a", 10, "ask", "Ask first");
    const secondRule = rule("rule:b", 5, "deny", "Deny second");
    const first = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [secondRule, firstRule],
    });
    const second = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [firstRule, secondRule],
    });
    expect(first.policy_digest).toBe(second.policy_digest);
    expect(permissionSnapshot(first)).toMatchObject({
      preset_key: "workspace-write",
      policy_digest: first.policy_digest,
    });
    expect(permissionPolicyDigest({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [firstRule],
      projectRules: [secondRule],
    })).not.toBe(permissionPolicyDigest({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [secondRule, firstRule],
    }));

    const base = actionDigestInput(first.policy_digest);
    const digest = approvalActionDigest(base);
    const reordered = approvalActionDigest({
      ...base,
      arguments: { replacement: "after", path: "src/app.ts", expected: "before" },
      scope: ["src/other.ts", "src/app.ts"],
    });
    expect(reordered).toBe(digest);
    expect(digest).not.toContain("src/app.ts");
    expect(approvalActionDigest({ ...base, patchHash: hash("d") })).not.toBe(digest);
    expect(approvalActionDigest({ ...base, canonicalTarget: "/workspace/src/other.ts" })).not.toBe(digest);
    expect(approvalActionDigest({ ...base, policyDigest: hash("c") })).not.toBe(digest);
  });

  it("restores a Host-validated effective policy without changing its frozen digest", () => {
    const effective = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [rule("rule:restored-host", 1_000, "allow", "Persisted Host allow")],
      projectRules: [rule("rule:restored-project", -1_000, "ask", "Persisted project review")],
    });
    const persisted = { ...effective, policy_digest: hash("e") };
    const restored = PolicyEngine.fromEffective(persisted, { idFactory: fixedIds() });

    expect(restored.effectivePolicy().policy_digest).toBe(hash("e"));
    expect(restored.snapshot().policy_digest).toBe(hash("e"));
    expect(restored.evaluate({ toolName: "read_file", sideEffect: "read" })).toMatchObject({
      kind: "ask",
      source: "configured-rule",
      matched_rule_id: "rule:restored-project",
      policy_digest: hash("e"),
    });
  });

  it("matches globstar across zero or many path segments", () => {
    expect(matchesPolicyGlob("**", ".")).toBe(true);
    expect(matchesPolicyGlob("src/**/*.ts", "src/app.ts")).toBe(true);
    expect(matchesPolicyGlob("src/**/*.ts", "src/lib/app.ts")).toBe(true);
    expect(matchesPolicyGlob("src/*.ts", "src/lib/app.ts")).toBe(false);
    expect(matchesPolicyGlob("src/?.ts", "src/a.ts")).toBe(true);
  });

  it("rejects duplicate rule identities across Host and project layers", () => {
    const duplicate = rule("rule:duplicate", 1, "deny", "Duplicate");
    expect(() => new PolicyEngine({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [duplicate],
      projectRules: [duplicate],
    })).toThrowError(expect.objectContaining({ code: "duplicate_rule_id" }));
  });
});

function rule(
  ruleId: string,
  priority: number,
  then: "allow" | "ask" | "deny",
  explanation: string,
): PolicyRule {
  return { rule_id: ruleId, priority, when: {}, then, explanation };
}

function customPreset(input: { allowedTools: string[]; pathScope: string[] }) {
  return PermissionPresetSchema.parse({
    preset_version: 1,
    key: "custom",
    label: "Scoped custom policy",
    sandbox_mode: "workspace-write",
    approval_policy: "never",
    allowed_tools: input.allowedTools,
    path_scope: input.pathScope,
  });
}

function fixedIds() {
  let next = 0;
  return (prefix: string) => `${prefix}:${++next}`;
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function actionDigestInput(policyDigest: string) {
  return {
    projectId: "project:test",
    runId: "run:test",
    actionId: "action:test",
    toolName: "commit_patch",
    workspaceHandleId: "workspace:test",
    policyDigest,
    arguments: { path: "src/app.ts", expected: "before", replacement: "after" },
    path: "src/app.ts",
    canonicalTarget: "/workspace/src/app.ts",
    baseHash: hash("a"),
    patchHash: hash("b"),
    scope: ["src/app.ts", "src/other.ts"],
  };
}
