import { describe, expect, it } from "vitest";
import {
  BUILTIN_PERMISSION_PRESETS,
  CurrentRunRecoveryStateV4Schema,
  EventTypeSchema,
  InterruptSubagentInputSchema,
  ListSubagentsInputSchema,
  PolicyDeniedDataSchema,
  PROJECTOR_VERSION,
  RunProjectionSchema,
  SCHEMA_VERSION,
  SendSubagentMessageInputSchema,
  SessionHeaderSchema,
  SessionListQuerySchema,
  SpawnSubagentInputSchema,
  SubagentCompletedDataSchema,
  SubagentFailedDataSchema,
  SubagentInterruptedDataSchema,
  SubagentLimitsSchema,
  SubagentListProjectionSchema,
  SubagentMessageSentDataSchema,
  SubagentOrchestrationRecoverySchema,
  SubagentProfileSchema,
  SubagentProjectionItemSchema,
  SubagentRunLinkSchema,
  SubagentSpecSchema,
  SubagentStartedDataSchema,
  SubagentUsageSchema,
  SubmitUserInputCommandSchema,
  SubmitUserInputRequestSchema,
  ToolNameSchema,
  UserInputQueuedDataSchema,
} from "./index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const NOW = "2026-09-19T12:00:00.000Z";

describe("G-07 subagent contracts", () => {
  it("keeps model spawn input free of resolved provider, prompt, allowlist, and parent authority", () => {
    const input = {
      profile_name: "code-explorer",
      task_packet: {
        task: "Inspect the projection implementation",
        constraints: ["Do not modify files"],
        acceptance_criteria: ["Report exact line references"],
      },
      context_scope: "isolated",
      budget: { max_steps: 8 },
    } as const;
    expect(SpawnSubagentInputSchema.parse(input)).toEqual(input);

    for (const authority of [
      { parent_run_id: "run:smuggled" },
      { provider_key: "untrusted-provider" },
      { role_prompt_version: "override" },
      { role_prompt_hash: HASH_A },
      { tool_allowlist: ["commit_patch"] },
      { depth: 0 },
    ]) {
      expect(() => SpawnSubagentInputSchema.parse({ ...input, ...authority })).toThrow();
    }
    expect(() => SpawnSubagentInputSchema.parse({ ...input, budget: {} })).toThrow(
      "must set at least one limit",
    );
  });

  it("validates trusted profiles and resolved isolated/forked specs", () => {
    expect(SubagentProfileSchema.parse({
      name: "code-explorer",
      provider_key: "primary",
      role_prompt_version: "explorer.v1",
      role_prompt_hash: HASH_A,
      tool_allowlist: ["read_file", "search"],
      default_budget: { max_steps: 8, max_tokens: 20_000 },
      budget_ceiling: { max_steps: 12, max_tokens: 30_000 },
    }).provider_key).toBe("primary");
    expect(() => SubagentProfileSchema.parse({
      name: "code-explorer",
      provider_key: "primary",
      role_prompt_version: "explorer.v1",
      role_prompt_hash: HASH_A,
      tool_allowlist: ["search", "search"],
      default_budget: { max_steps: 8, max_tokens: 20_000 },
      budget_ceiling: { max_steps: 7, max_tokens: 30_000 },
    })).toThrow();
    expect(() => SubagentProfileSchema.parse({
      name: "code-explorer",
      provider_key: "primary",
      role_prompt_version: "explorer.v1",
      role_prompt_hash: HASH_A,
      tool_allowlist: ["read_file", "search"],
      default_budget: { max_steps: 8, max_tokens: 30_001 },
      budget_ceiling: { max_steps: 12, max_tokens: 30_000 },
    })).toThrow("default max_tokens cannot exceed the profile ceiling");

    expect(SubagentSpecSchema.parse(spec()).context_scope).toBe("isolated");
    expect(() => SubagentSpecSchema.parse({
      ...spec(),
      context_scope: "fork",
    })).toThrow("require an exact parent Context manifest");
    expect(SubagentSpecSchema.parse({
      ...spec(),
      context_scope: "fork",
      fork_context_manifest_ref: "context:parent:7",
    }).fork_context_manifest_ref).toBe("context:parent:7");
    expect(() => SubagentSpecSchema.parse({
      ...spec(),
      fork_context_manifest_ref: "context:forbidden",
    })).toThrow("isolated subagents cannot inherit");
  });

  it("binds lifecycle payloads to one parent/child link and exact terminal result", () => {
    const started = startedData();
    expect(SubagentStartedDataSchema.parse(started)).toEqual(started);
    expect(() => SubagentStartedDataSchema.parse({
      ...started,
      spec: { ...started.spec, subagent_id: "subagent:other" },
    })).toThrow("spec must match");
    expect(() => SubagentStartedDataSchema.parse({
      ...started,
      spec: { ...started.spec, parent_run_id: "run:other-parent" },
    })).toThrow("spec must match");
    expect(() => SubagentStartedDataSchema.parse({
      ...started,
      spec: { ...started.spec, depth: 2 },
    })).toThrow("depth exceeds");

    const message = {
      link: link(),
      message: {
        message_id: "message:initial",
        kind: "initial_task",
        actor: "parent_agent",
        body: "Inspect the projection implementation",
        body_hash: HASH_B,
        sent_at: NOW,
      },
      _internal_message_digest: HASH_A,
    } as const;
    expect(SubagentMessageSentDataSchema.parse(message)).toEqual(message);
    expect(() => SubagentMessageSentDataSchema.parse({
      ...message,
      message: { ...message.message, actor: "user" },
    })).toThrow();

    const completed = {
      link: link(),
      result: result("completed"),
      child_terminal_event_id: "event:child-terminal",
      child_terminal_event_hash: HASH_A,
    } as const;
    expect(SubagentCompletedDataSchema.parse(completed).result.status).toBe("completed");
    expect(() => SubagentCompletedDataSchema.parse({
      ...completed,
      result: { ...completed.result, child_run_id: "run:other" },
    })).toThrow("result must match");

    expect(SubagentFailedDataSchema.parse({
      link: link(),
      result: result("budget_exceeded"),
      reason: "budget_exceeded",
      failure_stage: "execution",
      child_terminal_event_id: "event:child-failed",
      child_terminal_event_hash: HASH_B,
    }).reason).toBe("budget_exceeded");
    expect(() => SubagentFailedDataSchema.parse({
      link: link(),
      result: result("budget_exceeded"),
      reason: "provider_failed",
      failure_stage: "execution",
      child_terminal_event_id: "event:child-failed",
      child_terminal_event_hash: HASH_B,
    })).toThrow("must agree");
    expect(() => SubagentFailedDataSchema.parse({
      link: link(),
      result: result("failed"),
      reason: "provider_failed",
      failure_stage: "execution",
    })).toThrow("require child terminal proof");
  });

  it("rejects self-linked child Runs and Sessions", () => {
    expect(() => SubagentRunLinkSchema.parse({
      ...link(),
      child_run_id: "run:parent",
    })).toThrow("child Run must differ from parent Run");
    expect(() => SubagentRunLinkSchema.parse({
      ...link(),
      child_session_id: "session:parent",
    })).toThrow("independent child Session");
  });

  it("requires atomic terminal proof with launch/execution provenance", () => {
    const failed = {
      link: link(),
      result: result("failed"),
      reason: "provider_failed",
      failure_stage: "execution",
      child_terminal_event_id: "event:child-failed",
      child_terminal_event_hash: HASH_B,
    } as const;
    expect(() => SubagentFailedDataSchema.parse({
      ...failed,
      child_terminal_event_hash: undefined,
    })).toThrow("atomic pair");
    expect(() => SubagentFailedDataSchema.parse({
      ...failed,
      failure_stage: "launch",
    })).toThrow("launch failures cannot claim child terminal proof");

    expect(() => SubagentInterruptedDataSchema.parse({
      link: link(),
      result: {
        ...result("interrupted", [artifact("project:g07", "run:not-child")]),
        subagent_id: "subagent:not-linked",
        child_run_id: "run:not-linked",
      },
      reason: "Parent cancelled",
      child_terminal_event_id: "event:child-interrupted",
      child_terminal_event_hash: HASH_A,
    })).toThrow("result must match the Run link");
  });

  it("uses aggregate step/token accounting rather than a single-call estimate", () => {
    expect(SubagentUsageSchema.parse({
      steps: 3,
      input_tokens: 900,
      output_tokens: 100,
      total_tokens: 1_000,
      confidence: "provider_reported",
      costs: [{ amount: 0.05, currency: "USD" }],
    }).total_tokens).toBe(1_000);
    expect(() => SubagentUsageSchema.parse({
      steps: 3,
      input_tokens: 900,
      output_tokens: 100,
      total_tokens: 999,
      confidence: "estimated",
      costs: [],
    })).toThrow("must equal");
    expect(() => SubagentUsageSchema.parse({
      steps: 3,
      input_tokens: 900,
      output_tokens: 100,
      total_tokens: 1_000,
      confidence: "provider_reported",
      costs: [
        { amount: 0.04, currency: "USD" },
        { amount: 0.01, currency: "USD" },
      ],
    })).toThrow("unique by currency");
  });

  it("keeps recovered orchestration depth and durable delegation inseparable", () => {
    expect(() => SubagentOrchestrationRecoverySchema.parse({
      depth: 2,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
      delegation: { ...startedData(), spec: { ...spec(), depth: 2 } },
    })).toThrow("recovered agent depth exceeds its limit");
    expect(() => SubagentOrchestrationRecoverySchema.parse({
      depth: 0,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
      delegation: startedData(),
    })).toThrow("root Run cannot have a parent delegation");
    expect(() => SubagentOrchestrationRecoverySchema.parse({
      depth: 1,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    })).toThrow("child Run requires its durable delegation");
    expect(() => SubagentOrchestrationRecoverySchema.parse({
      depth: 2,
      limits: { max_parallel_subagents: 2, max_depth: 3 },
      delegation: startedData(),
    })).toThrow("delegation depth must match recovery depth");
    expect(() => SubagentOrchestrationRecoverySchema.parse({
      depth: 1,
      limits: { max_parallel_subagents: 3, max_depth: 1 },
      delegation: startedData(),
    })).toThrow("delegation limits must match recovery limits");
  });

  it("rejects internally inconsistent running and terminal subagent projections", () => {
    const running = runningProjectionItem();
    expect(SubagentProjectionItemSchema.parse(running).status).toBe("running");
    expect(() => SubagentProjectionItemSchema.parse({
      ...running,
      terminal_event_id: "event:impossible-terminal",
    })).toThrow("terminal subagent projection fields must be present together");
    expect(() => SubagentProjectionItemSchema.parse({
      ...running,
      child_terminal_event_id: "event:unpaired-proof",
    })).toThrow("child terminal proof is an atomic pair");

    const terminal = completedProjectionItem();
    expect(() => SubagentProjectionItemSchema.parse({
      ...terminal,
      child_terminal_event_id: undefined,
      child_terminal_event_hash: undefined,
    })).toThrow("terminal child execution requires canonical proof");
    expect(() => SubagentProjectionItemSchema.parse({
      ...terminal,
      result: result("interrupted"),
    })).toThrow("result status must match projected status");
    expect(() => SubagentProjectionItemSchema.parse({
      ...terminal,
      failure_reason: "not allowed for completed work",
    })).toThrow("failure reason");
    expect(() => SubagentProjectionItemSchema.parse({
      ...terminal,
      result: { ...terminal.result, subagent_id: "subagent:other" },
    })).toThrow("result must match projected subagent");
    expect(() => SubagentProjectionItemSchema.parse({
      ...terminal,
      result: { ...terminal.result, child_run_id: "run:other" },
    })).toThrow("result must match projected child Run");
    expect(() => SubagentProjectionItemSchema.parse({
      ...running,
      message_count: 1,
    })).toThrow("message_count and initial message must agree");
  });

  it("rejects duplicate child identities and inconsistent active counts", () => {
    const first = runningProjectionItem();
    const parseList = (items: readonly unknown[], activeCount: number, maxParallel = 2) =>
      SubagentListProjectionSchema.parse({
        items,
        active_count: activeCount,
        last_sequence: 2,
        limits: { max_parallel_subagents: maxParallel, max_depth: 1 },
      });

    expect(() => parseList([first, first], 2)).toThrow("subagent_id values must be unique");
    expect(() => parseList([
      first,
      withChildIdentity(first, "subagent:two", first.link.child_run_id, "session:child-two"),
    ], 2)).toThrow("child_run_id values must be unique");
    expect(() => parseList([
      first,
      withChildIdentity(first, "subagent:two", "run:child-two", first.link.child_session_id),
    ], 2)).toThrow("child_session_id values must be unique");
    expect(() => parseList([first], 0)).toThrow("active_count must equal running subagents");
    expect(() => parseList([
      first,
      withChildIdentity(first, "subagent:two", "run:child-two", "session:child-two"),
    ], 2, 1)).toThrow("active subagents exceed the effective limit");
  });

  it("adds four control tools and five append-compatible lifecycle events", () => {
    for (const tool of [
      "spawn_subagent",
      "send_subagent_message",
      "list_subagents",
      "interrupt_subagent",
    ] as const) {
      expect(ToolNameSchema.parse(tool)).toBe(tool);
      expect(BUILTIN_PERMISSION_PRESETS["read-only"].allowed_tools).toContain(tool);
      expect(BUILTIN_PERMISSION_PRESETS["workspace-write"].allowed_tools).toContain(tool);
      expect(BUILTIN_PERMISSION_PRESETS["full-write"].allowed_tools).toContain(tool);
    }
    for (const type of [
      "subagent.started",
      "subagent.message_sent",
      "subagent.completed",
      "subagent.failed",
      "subagent.interrupted",
    ] as const) {
      expect(EventTypeSchema.parse(type)).toBe(type);
    }
    expect(PolicyDeniedDataSchema.parse({
      decision: {
        decision_id: "policy-decision:subagent-tool",
        preset_key: "workspace-write",
        policy_digest: HASH_A,
        tool_name: "commit_patch",
        side_effect: "write",
        kind: "deny",
        source: "hard-constraint",
        explanation: "Child profile does not allow this tool",
      },
      code: "SUBAGENT_TOOL_NOT_ALLOWED",
      reason: "subagent_tool_allowlist",
    }).reason).toBe("subagent_tool_allowlist");
  });

  it("keeps parent_agent internal while preserving the strict browser request", () => {
    expect(SubmitUserInputCommandSchema.parse({
      type: "submit_user_input",
      command_id: "command:parent-message",
      input_id: "input:parent-message",
      project_id: "project:g07",
      run_id: "run:child",
      kind: "message",
      body: "Continue with the tests",
      actor: "parent_agent",
    }).actor).toBe("parent_agent");
    expect(UserInputQueuedDataSchema.parse({
      input: {
        input_id: "input:parent-message",
        run_id: "run:child",
        kind: "message",
        body: "Continue with the tests",
        actor: "parent_agent",
        submitted_at: NOW,
      },
    }).input.actor).toBe("parent_agent");
    expect(() => SubmitUserInputRequestSchema.parse({
      command_id: "command:browser",
      input_id: "input:browser",
      kind: "message",
      body: "Browser message",
      actor: "parent_agent",
    })).toThrow();
  });

  it("defaults legacy projections to no subagents and validates parent/child Artifact scope", () => {
    const legacy = RunProjectionSchema.parse(baseProjection());
    expect(legacy.projector_version).toBe(PROJECTOR_VERSION);
    expect(legacy.subagents).toEqual({
      items: [],
      active_count: 0,
      last_sequence: 0,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    });

    const completedItem = {
      link: link(),
      name: "code-explorer",
      provider_key: "primary",
      role_prompt_version: "explorer.v1",
      role_prompt_hash: HASH_A,
      tool_allowlist: ["read_file", "search"],
      context_scope: "isolated",
      budget: { max_steps: 8, max_tokens: 20_000 },
      depth: 1,
      status: "completed",
      started_event_id: "event:started",
      started_at: NOW,
      message_count: 1,
      initial_message_event_id: "event:initial-message",
      last_message_at: NOW,
      terminal_event_id: "event:completed",
      child_terminal_event_id: "event:child-terminal",
      child_terminal_event_hash: HASH_A,
      finished_at: NOW,
      result: result("completed", [artifact("project:g07", "run:child")]),
    } as const;
    expect(RunProjectionSchema.parse({
      ...baseProjection(),
      subagents: {
        items: [completedItem],
        active_count: 0,
        last_sequence: 3,
        limits: { max_parallel_subagents: 2, max_depth: 1 },
      },
    }).subagents.items).toHaveLength(1);
    expect(() => RunProjectionSchema.parse({
      ...baseProjection(),
      subagents: {
        items: [{
          ...completedItem,
          result: result("completed", [artifact("project:g07", "run:other")]),
        }],
        active_count: 0,
        last_sequence: 3,
        limits: { max_parallel_subagents: 2, max_depth: 1 },
      },
    })).toThrow("must belong to the projected project and child Run");
  });

  it("persists root/child orchestration in recovery v4 while leaving Session format v1", () => {
    const effectivePolicy = {
      policy_version: 1,
      preset: BUILTIN_PERMISSION_PRESETS["workspace-write"],
      host_rules: [],
      project_rules: [],
      policy_digest: HASH_A,
    } as const;
    expect(CurrentRunRecoveryStateV4Schema.parse({
      version: 4,
      kind: "run_recovery_state",
      task: "Coordinate child Runs",
      conversation_history: [],
      mode: "execute",
      reasoning_effort: "default",
      effective_policy: effectivePolicy,
      orchestration: {
        depth: 0,
        limits: { max_parallel_subagents: 2, max_depth: 1 },
      },
    }).orchestration.depth).toBe(0);
    expect(CurrentRunRecoveryStateV4Schema.parse({
      version: 4,
      kind: "run_recovery_state",
      task: "Inspect projection",
      conversation_history: [],
      mode: "execute",
      reasoning_effort: "default",
      effective_policy: effectivePolicy,
      orchestration: {
        depth: 1,
        limits: { max_parallel_subagents: 2, max_depth: 1 },
        delegation: startedData(),
      },
    }).orchestration.delegation?.link.child_session_id).toBe("session:child");
    expect(SessionHeaderSchema.parse({
      kind: "header",
      session_version: 1,
      session_id: "session:child",
      project_id: "project:g07",
      created_at: NOW,
      parent_session_id: "session:parent",
      run_ids: ["run:child"],
    }).parent_session_id).toBe("session:parent");
    expect(() => SessionHeaderSchema.parse({
      kind: "header",
      session_version: 1,
      session_id: "session:self",
      project_id: "project:g07",
      created_at: NOW,
      parent_session_id: "session:self",
      run_ids: [],
    })).toThrow("cannot be its own parent");
  });

  it("keeps ordinary Session history root-only with an explicit internal all view", () => {
    expect(SessionListQuerySchema.parse({})).toEqual({ limit: 50, view: "roots" });
    expect(SessionListQuerySchema.parse({ view: "all", limit: "25" })).toEqual({
      limit: 25,
      view: "all",
    });
    expect(() => SessionListQuerySchema.parse({ view: "children" })).toThrow();
  });

  it("keeps the remaining control inputs bounded and strict", () => {
    expect(SendSubagentMessageInputSchema.parse({
      subagent_id: "subagent:one",
      message: "Please also inspect replay",
    }).message).toContain("replay");
    expect(ListSubagentsInputSchema.parse({})).toEqual({});
    expect(InterruptSubagentInputSchema.parse({
      subagent_id: "subagent:one",
      reason: "Parent Run cancelled",
    }).reason).toContain("cancelled");
    expect(() => ListSubagentsInputSchema.parse({ parent_run_id: "run:smuggled" })).toThrow();
  });
});

function link() {
  return {
    subagent_id: "subagent:one",
    parent_run_id: "run:parent",
    parent_session_id: "session:parent",
    child_run_id: "run:child",
    child_session_id: "session:child",
  } as const;
}

function spec() {
  return {
    subagent_id: "subagent:one",
    parent_run_id: "run:parent",
    name: "code-explorer",
    provider_key: "primary",
    role_prompt_version: "explorer.v1",
    role_prompt_hash: HASH_A,
    tool_allowlist: ["read_file", "search"],
    context_scope: "isolated",
    budget: { max_steps: 8, max_tokens: 20_000 },
    depth: 1,
  } as const;
}

function startedData() {
  return {
    link: link(),
    spec: spec(),
    limits: { max_parallel_subagents: 2, max_depth: 1 },
    task_packet_hash: HASH_B,
  } as const;
}

function result(
  status: "completed" | "failed" | "interrupted" | "budget_exceeded",
  artifactRefs: ReturnType<typeof artifact>[] = [],
) {
  return {
    subagent_id: "subagent:one",
    child_run_id: "run:child",
    status,
    summary: "Child result summary",
    artifact_refs: artifactRefs,
    usage: {
      steps: 3,
      input_tokens: 900,
      output_tokens: 100,
      total_tokens: 1_000,
      confidence: "provider_reported",
      costs: [],
    },
  } as const;
}

function runningProjectionItem() {
  return {
    link: link(),
    name: "code-explorer",
    provider_key: "primary",
    role_prompt_version: "explorer.v1",
    role_prompt_hash: HASH_A,
    tool_allowlist: ["read_file", "search"],
    context_scope: "isolated",
    budget: { max_steps: 8, max_tokens: 20_000 },
    depth: 1,
    status: "running",
    started_event_id: "event:started",
    started_at: NOW,
    message_count: 0,
  } as const;
}

function completedProjectionItem() {
  return {
    ...runningProjectionItem(),
    status: "completed",
    terminal_event_id: "event:completed",
    child_terminal_event_id: "event:child-terminal",
    child_terminal_event_hash: HASH_A,
    finished_at: NOW,
    result: result("completed"),
  } as const;
}

function withChildIdentity(
  item: ReturnType<typeof runningProjectionItem>,
  subagentId: string,
  childRunId: string,
  childSessionId: string,
) {
  return {
    ...item,
    link: {
      ...item.link,
      subagent_id: subagentId,
      child_run_id: childRunId,
      child_session_id: childSessionId,
    },
  };
}

function artifact(projectId: string, runId: string) {
  return {
    artifact_id: "artifact:child-report",
    kind: "report",
    content_hash: HASH_A,
    mime_type: "text/markdown",
    byte_length: 100,
    project_id: projectId,
    run_id: runId,
    created_at: NOW,
  } as const;
}

function baseProjection() {
  return {
    schema_version: SCHEMA_VERSION,
    projector_version: PROJECTOR_VERSION,
    project_id: "project:g07",
    session_id: "session:parent",
    run_id: "run:parent",
    task: "Delegate bounded work",
    mode: "execute",
    reasoning_effort: "default",
    workspace_kind: "managed_local",
    status: "running",
    last_sequence: 0,
    timeline: [],
    todos: { items: [], last_sequence: 0 },
    input_queue: { pending: [] },
    artifact_refs: [],
  } as const;
}
