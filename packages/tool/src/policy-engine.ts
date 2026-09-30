import {
  BUILTIN_PERMISSION_PRESETS,
  EffectivePermissionPolicySchema,
  IdentifierSchema,
  PERMISSION_POLICY_FORMAT_VERSION,
  PermissionPresetSchema,
  PermissionSnapshotSchema,
  PolicyDecisionSchema,
  PolicyDocumentSchema,
  PolicyPathGlobSchema,
  PolicyToolNameSchema,
  Sha256Schema,
  type EffectivePermissionPolicy,
  type PermissionPreset,
  type PermissionSnapshot,
  type PolicyDecision,
  type PolicyDecisionKind,
  type PolicyRule,
  type RunMode,
  type ToolSideEffect,
} from "@tracegraph/contracts";
import { defaultIdFactory, sha256, stableStringify } from "./crypto.js";

/**
 * The contracts package owns the canonical preset values. Re-exporting the
 * exact frozen object here gives the Runtime one policy-oriented entry point
 * without allowing a second copy of the preset definitions to drift.
 */
export const CORE_BUILTIN_PERMISSION_PRESETS = BUILTIN_PERMISSION_PRESETS;

const PLAN_MODE_READ_TOOLS = new Set([
  "read_file",
  "list_dir",
  "search",
  "read_artifact",
  "list_artifacts",
  "todo_read",
]);

const DECISION_TIE_BREAK: Readonly<Record<PolicyDecisionKind, number>> = Object.freeze({
  deny: 0,
  ask: 1,
  allow: 2,
});

export interface CreateEffectivePermissionPolicyInput {
  preset: PermissionPreset;
  /** Host/user rules may choose allow, ask, or deny within the preset ceiling. */
  rules?: readonly PolicyRule[];
  /** Repository policy is untrusted and can only narrow the Host policy. */
  projectRules?: readonly PolicyRule[];
}

export interface CreatePolicyEngineInput extends CreateEffectivePermissionPolicyInput {
  idFactory?: (prefix: string) => string;
}

export interface RestorePolicyEngineInput {
  /**
   * A Host-validated, persisted policy snapshot. Its rules are already the
   * effective Host/project layers. The supplied digest and origin boundary
   * are deliberately preserved for recovery continuity.
   */
  effectivePolicy: EffectivePermissionPolicy;
  idFactory?: (prefix: string) => string;
}

export type PolicyEngineInput = CreatePolicyEngineInput | RestorePolicyEngineInput;

export interface PolicyEvaluationInput {
  toolName: string;
  sideEffect: ToolSideEffect;
  /** False is a non-delegable WorkspaceHandle denial. */
  capabilityAllowed?: boolean;
  runMode?: RunMode;
  /** Canonical workspace-relative POSIX path, when the Tool targets a path. */
  path?: string;
  diffLines?: number;
  sessionTags?: readonly string[];
  actionDigest?: string;
}

export interface ApprovalActionDigestInput {
  projectId: string;
  runId: string;
  actionId: string;
  toolName: string;
  workspaceHandleId: string;
  policyDigest: string;
  arguments: unknown;
  /** Workspace-relative path approved by policy. */
  path?: string;
  /** Preview-time canonical target identity; never emitted in clear text. */
  canonicalTarget?: string;
  baseHash?: string;
  patchHash?: string;
  scope: readonly string[];
}

interface PolicyLayers {
  readonly effective: EffectivePermissionPolicy;
  readonly hostRules: readonly PolicyRule[];
  readonly projectRules: readonly PolicyRule[];
}

interface HardConstraintInput {
  toolName: string;
  sideEffect: ToolSideEffect;
  capabilityAllowed?: boolean;
  runMode?: RunMode;
  path?: string;
  invalidPath: boolean;
}

/**
 * Build the immutable policy snapshot used by one Run. Rule order is
 * canonicalized because evaluation has explicit priority/tie semantics; the
 * digest therefore does not depend on JSON declaration order.
 */
export function createEffectivePermissionPolicy(
  input: CreateEffectivePermissionPolicyInput,
): EffectivePermissionPolicy {
  return policyLayers(input).effective;
}

export function permissionSnapshot(policy: EffectivePermissionPolicy): PermissionSnapshot {
  const parsed = EffectivePermissionPolicySchema.parse(policy);
  return PermissionSnapshotSchema.parse({
    preset_key: parsed.preset.key,
    label: parsed.preset.label,
    sandbox_mode: parsed.preset.sandbox_mode,
    approval_policy: parsed.preset.approval_policy,
    policy_digest: parsed.policy_digest,
  });
}

/** Stable digest for a Host policy plus the separately constrained project layer. */
export function permissionPolicyDigest(input: CreateEffectivePermissionPolicyInput): `sha256:${string}` {
  const preset = PermissionPresetSchema.parse(input.preset);
  const hostRules = parseAndSortRules(input.rules ?? []);
  const projectRules = parseAndSortRules(input.projectRules ?? []);
  assertRuleIdsUnique(hostRules, projectRules);
  assertProjectRulesNarrow(projectRules);
  return sha256(stableStringify({
    domain: "tracegraph.permission-policy.v1",
    policy_version: PERMISSION_POLICY_FORMAT_VERSION,
    preset,
    host_rules: hostRules,
    project_rules: projectRules,
  }));
}

/**
 * Bind an approval to the exact canonical action and effective policy. The
 * returned hash contains no recoverable path, argument, or diff content.
 */
export function approvalActionDigest(input: ApprovalActionDigestInput): `sha256:${string}` {
  const projectId = IdentifierSchema.parse(input.projectId);
  const runId = IdentifierSchema.parse(input.runId);
  const actionId = IdentifierSchema.parse(input.actionId);
  const toolName = PolicyToolNameSchema.parse(input.toolName);
  const workspaceHandleId = IdentifierSchema.parse(input.workspaceHandleId);
  const policyDigest = Sha256Schema.parse(input.policyDigest);
  const scope = canonicalScope(input.scope);
  const path = input.path === undefined ? undefined : normalizePolicyPath(input.path);
  const canonicalTarget = input.canonicalTarget === undefined
    ? undefined
    : requireDigestString(input.canonicalTarget, "canonicalTarget");
  const baseHash = input.baseHash === undefined ? undefined : Sha256Schema.parse(input.baseHash);
  const patchHash = input.patchHash === undefined ? undefined : Sha256Schema.parse(input.patchHash);
  const argumentsDigest = sha256(stableStringify(input.arguments));
  return sha256(stableStringify({
    domain: "tracegraph.approval-action.v1",
    project_id: projectId,
    run_id: runId,
    action_id: actionId,
    tool_name: toolName,
    workspace_handle_id: workspaceHandleId,
    policy_digest: policyDigest,
    arguments_digest: argumentsDigest,
    path,
    canonical_target: canonicalTarget,
    base_hash: baseHash,
    patch_hash: patchHash,
    scope,
  }));
}

/** POSIX glob matcher with bounded `*`, `?`, and `**` semantics. */
export function matchesPolicyGlob(glob: string, candidatePath: string): boolean {
  const parsedGlob = PolicyPathGlobSchema.parse(glob);
  const normalizedPath = normalizePolicyPath(candidatePath);
  return globRegex(parsedGlob).test(normalizedPath);
}

export class PolicyEngine {
  readonly #effective: EffectivePermissionPolicy;
  readonly #hostRules: readonly PolicyRule[];
  readonly #projectRules: readonly PolicyRule[];
  readonly #idFactory: (prefix: string) => string;

  constructor(input: PolicyEngineInput) {
    if ("effectivePolicy" in input) {
      const effective = EffectivePermissionPolicySchema.parse(input.effectivePolicy);
      this.#effective = effective;
      this.#hostRules = parseAndSortRules(effective.host_rules);
      this.#projectRules = parseAndSortRules(effective.project_rules);
    } else {
      const layers = policyLayers(input);
      this.#effective = layers.effective;
      this.#hostRules = layers.hostRules;
      this.#projectRules = layers.projectRules;
    }
    this.#idFactory = input.idFactory ?? defaultIdFactory;
  }

  /** Restore a policy frozen into Run recovery state without changing its digest. */
  static fromEffective(
    effectivePolicy: EffectivePermissionPolicy,
    options: Pick<RestorePolicyEngineInput, "idFactory"> = {},
  ): PolicyEngine {
    return new PolicyEngine({
      effectivePolicy,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    });
  }

  effectivePolicy(): EffectivePermissionPolicy {
    return this.#effective;
  }

  snapshot(): PermissionSnapshot {
    return permissionSnapshot(this.#effective);
  }

  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const toolName = PolicyToolNameSchema.parse(input.toolName);
    const actionDigest = input.actionDigest === undefined
      ? undefined
      : Sha256Schema.parse(input.actionDigest);
    let normalizedPath: string | undefined;
    let invalidPath = false;
    if (input.path !== undefined) {
      try {
        normalizedPath = normalizePolicyPath(input.path);
      } catch {
        invalidPath = true;
      }
    }
    const tags = normalizeSessionTags(input.sessionTags ?? []);
    const common = {
      decision_id: IdentifierSchema.parse(this.#idFactory("policy-decision")),
      preset_key: this.#effective.preset.key,
      policy_digest: this.#effective.policy_digest,
      tool_name: toolName,
      side_effect: input.sideEffect,
      ...(actionDigest === undefined ? {} : { action_digest: actionDigest }),
    } as const;

    const hardDenial = this.#hardDenial({
      toolName,
      sideEffect: input.sideEffect,
      ...(input.capabilityAllowed === undefined ? {} : { capabilityAllowed: input.capabilityAllowed }),
      ...(input.runMode === undefined ? {} : { runMode: input.runMode }),
      ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
      invalidPath,
    });
    if (hardDenial !== undefined) {
      return PolicyDecisionSchema.parse({
        ...common,
        kind: "deny",
        source: "hard-constraint",
        explanation: hardDenial,
      });
    }

    const diffLines = normalizeDiffLines(input.diffLines);
    const ruleInput: MatchedRuleInput = {
      toolName,
      sideEffect: input.sideEffect,
      sessionTags: tags,
      ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
      ...(diffLines === undefined ? {} : { diffLines }),
    };
    const hostRule = this.#hostRules.find((rule) => ruleMatches(rule, ruleInput));
    const base = hostRule === undefined
      ? presetDefault(this.#effective.preset, input.sideEffect)
      : ruleDecision(hostRule);
    // Project allow rules are no-ops by design and therefore cannot shadow a
    // lower-priority project ask/deny that genuinely narrows Host authority.
    const projectRule = this.#projectRules.find(
      (rule) => rule.then !== "allow" && ruleMatches(rule, ruleInput),
    );
    const selected = narrowWithProjectRule(base, projectRule);

    return PolicyDecisionSchema.parse({
      ...common,
      kind: selected.kind,
      source: selected.source,
      explanation: selected.explanation,
      ...(selected.rule === undefined
        ? {}
        : { matched_rule_id: selected.rule.rule_id, priority: selected.rule.priority }),
    });
  }

  #hardDenial(input: HardConstraintInput): string | undefined {
    if (input.invalidPath) {
      return `${input.toolName} has an invalid policy path`;
    }
    if (input.capabilityAllowed === false) {
      return `Workspace capability does not allow ${input.toolName}`;
    }
    if (input.runMode === "plan") {
      const allowed = input.toolName === "todo_write"
        ? input.sideEffect === "none"
        : (PLAN_MODE_READ_TOOLS.has(input.toolName) || input.toolName.startsWith("mcp_"))
          && (input.sideEffect === "none" || input.sideEffect === "read");
      if (!allowed) {
        return `${input.toolName} is not available in plan mode`;
      }
    }
    if (!this.#effective.preset.allowed_tools.includes(input.toolName)) {
      return `Permission preset ${this.#effective.preset.key} does not allow ${input.toolName}`;
    }
    if (
      this.#effective.preset.sandbox_mode === "read-only"
      && input.sideEffect === "write"
    ) {
      return `${input.toolName} cannot write under the read-only permission preset`;
    }
    if (input.path !== undefined && !this.#effective.preset.path_scope.some(
      (glob) => matchesPolicyGlob(glob, input.path!),
    )) {
      return `${input.toolName} targets a path outside the permission preset scope`;
    }
    return undefined;
  }
}

interface MatchedRuleInput {
  toolName: string;
  sideEffect: ToolSideEffect;
  path?: string;
  diffLines?: number;
  sessionTags: ReadonlySet<string>;
}

interface SelectedDecision {
  kind: PolicyDecisionKind;
  source: "configured-rule" | "preset-default";
  explanation: string;
  rule?: PolicyRule;
}

function policyLayers(input: CreateEffectivePermissionPolicyInput): PolicyLayers {
  const preset = PermissionPresetSchema.parse(input.preset);
  const hostRules = parseAndSortRules(input.rules ?? []);
  const projectRules = parseAndSortRules(input.projectRules ?? []);
  assertRuleIdsUnique(hostRules, projectRules);
  assertProjectRulesNarrow(projectRules);
  const policyDigest = permissionPolicyDigest({ preset, rules: hostRules, projectRules });
  const effective = EffectivePermissionPolicySchema.parse({
    policy_version: PERMISSION_POLICY_FORMAT_VERSION,
    preset,
    host_rules: hostRules,
    project_rules: projectRules,
    policy_digest: policyDigest,
  });
  return { effective, hostRules, projectRules };
}

function parseAndSortRules(rules: readonly PolicyRule[]): readonly PolicyRule[] {
  return [...PolicyDocumentSchema.parse({
    policy_version: PERMISSION_POLICY_FORMAT_VERSION,
    rules,
  }).rules].sort(compareRules);
}

function compareRules(left: PolicyRule, right: PolicyRule): number {
  return right.priority - left.priority
    || DECISION_TIE_BREAK[left.then] - DECISION_TIE_BREAK[right.then]
    || left.rule_id.localeCompare(right.rule_id);
}

function assertRuleIdsUnique(hostRules: readonly PolicyRule[], projectRules: readonly PolicyRule[]): void {
  const seen = new Set(hostRules.map(({ rule_id: ruleId }) => ruleId));
  const duplicate = projectRules.find(({ rule_id: ruleId }) => seen.has(ruleId));
  if (duplicate !== undefined) {
    throw new PolicyEngineError(
      "duplicate_rule_id",
      `Policy rule id ${duplicate.rule_id} occurs in both Host and project policy`,
    );
  }
}

function assertProjectRulesNarrow(projectRules: readonly PolicyRule[]): void {
  const broadeningRule = projectRules.find(({ then }) => then === "allow");
  if (broadeningRule !== undefined) {
    throw new PolicyEngineError(
      "project_rule_broadens",
      `Project policy rule ${broadeningRule.rule_id} cannot allow access`,
    );
  }
}

function ruleMatches(rule: PolicyRule, input: MatchedRuleInput): boolean {
  const when = rule.when;
  if (when.tool !== undefined && when.tool !== input.toolName) return false;
  if (when.side_effect !== undefined && when.side_effect !== input.sideEffect) return false;
  if (when.path_glob !== undefined) {
    if (input.path === undefined || !matchesPolicyGlob(when.path_glob, input.path)) return false;
  }
  if (when.max_diff_lines !== undefined) {
    if (input.diffLines === undefined || input.diffLines > when.max_diff_lines) return false;
  }
  if (when.session_tags !== undefined && !when.session_tags.every((tag) => input.sessionTags.has(tag))) {
    return false;
  }
  return true;
}

function ruleDecision(rule: PolicyRule): SelectedDecision {
  return {
    kind: rule.then,
    source: "configured-rule",
    explanation: rule.explanation,
    rule,
  };
}

function presetDefault(preset: PermissionPreset, sideEffect: ToolSideEffect): SelectedDecision {
  if (preset.approval_policy === "always") {
    return {
      kind: "ask",
      source: "preset-default",
      explanation: `Permission preset ${preset.key} requires approval for every Tool action`,
    };
  }
  if (preset.approval_policy === "on-write" && sideEffect === "write") {
    return {
      kind: "ask",
      source: "preset-default",
      explanation: `Permission preset ${preset.key} requires approval for write actions`,
    };
  }
  return {
    kind: "allow",
    source: "preset-default",
    explanation: `Permission preset ${preset.key} allows this Tool action`,
  };
}

function narrowWithProjectRule(
  base: SelectedDecision,
  projectRule: PolicyRule | undefined,
): SelectedDecision {
  if (projectRule === undefined || projectRule.then === "allow") return base;
  if (base.kind === "deny") return base;
  if (projectRule.then === "deny") return ruleDecision(projectRule);
  if (projectRule.then === "ask" && base.kind === "allow") return ruleDecision(projectRule);
  return base;
}

function normalizeDiffLines(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new PolicyEngineError("invalid_diff_lines", "diffLines must be a non-negative bounded integer");
  }
  return value;
}

function normalizeSessionTags(tags: readonly string[]): ReadonlySet<string> {
  if (tags.length > 32) throw new PolicyEngineError("invalid_session_tags", "Too many policy session tags");
  const normalized = tags.map((tag) => tag.trim());
  if (normalized.some((tag) => tag.length === 0 || tag.length > 80) || new Set(normalized).size !== normalized.length) {
    throw new PolicyEngineError("invalid_session_tags", "Policy session tags must be unique bounded strings");
  }
  return new Set(normalized);
}

function canonicalScope(scope: readonly string[]): readonly string[] {
  if (scope.length === 0 || scope.length > 64) {
    throw new PolicyEngineError("invalid_scope", "Approval scope must contain between 1 and 64 paths");
  }
  const normalized = scope.map(normalizePolicyPath).sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) {
    throw new PolicyEngineError("invalid_scope", "Approval scope paths must be unique");
  }
  return normalized;
}

function normalizePolicyPath(path: string): string {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (
    trimmed.length === 0
    || trimmed.startsWith("/")
    || /^[A-Za-z]:/u.test(trimmed)
    || /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new PolicyEngineError("invalid_path", "Policy path must be a safe workspace-relative path");
  }
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new PolicyEngineError("invalid_path", "Policy path cannot traverse outside the workspace");
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function globRegex(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length;) {
    const current = glob[index]!;
    if (current === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 3;
      } else {
        pattern += ".*";
        index += 2;
      }
      continue;
    }
    if (current === "*") {
      pattern += "[^/]*";
      index += 1;
      continue;
    }
    if (current === "?") {
      pattern += "[^/]";
      index += 1;
      continue;
    }
    pattern += /[\\^$.*+?()[\]{}|]/u.test(current) ? `\\${current}` : current;
    index += 1;
  }
  return new RegExp(`${pattern}$`, "u");
}

function requireDigestString(value: string, name: string): string {
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PolicyEngineError("invalid_digest_input", `${name} must be a bounded non-empty string`);
  }
  return value;
}

export class PolicyEngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PolicyEngineError";
  }
}
