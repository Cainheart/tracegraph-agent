import { describe, expect, it } from "vitest";
import {
  ApprovalCommandSchema,
  ArtifactWireResponseSchema,
  ContextBudgetSchema,
  ContextManifestSchema,
  ContextPolicySchema,
  CredentialBackendSchema,
  CredentialMigrationMarkerSchema,
  CredentialNameSchema,
  EventTypeSchema,
  GraphDeltaSchema,
  GraphSnapshotSchema,
  MemoryRecordSchema,
  ModelConfigUpdateRequestSchema,
  OpenLocalProjectRequestSchema,
  ProjectSummarySchema,
  PublicModelConfigResponseSchema,
  ReasoningEffortSchema,
  RelativePathSchema,
  RollbackActionCommandSchema,
  RollbackActionInputSchema,
  RollbackActionRequestSchema,
  SafeCredentialMetadataSchema,
  SESSION_FORMAT_VERSION,
  SessionEventReferenceSchema,
  SessionHeaderSchema,
  SessionListQuerySchema,
  SessionRecoveryReportSchema,
  SessionResumeResponseSchema,
  SecretReferenceSchema,
  StartChatRequestSchema,
  StartRunInputSchema,
  StartRunRequestSchema,
  ModelUsageReportSchema,
  TokenCalibrationFileSchema,
  TokenEstimateSchema,
  TokenUsageObservationSchema,
  WorkspaceHandleSchema,
} from "./index.js";

describe("canonical contracts", () => {
  it("keeps rollback authority server-owned and defaults force to false", () => {
    expect(RollbackActionRequestSchema.parse({
      command_id: "cmd-rollback",
    })).toEqual({
      command_id: "cmd-rollback",
      force: false,
    });
    expect(() => RollbackActionRequestSchema.parse({
      command_id: "cmd-rollback",
      project_id: "project-smuggled",
    })).toThrow();
    expect(RollbackActionCommandSchema.parse({
      type: "rollback_action",
      command_id: "cmd-rollback",
      project_id: "project-1",
      run_id: "run-1",
      action_id: "action-1",
    })).toMatchObject({
      force: false,
      project_id: "project-1",
      run_id: "run-1",
      action_id: "action-1",
    });
    expect(() => RollbackActionInputSchema.parse({
      type: "rollback_action",
      command_id: "cmd-rollback",
      project_id: "project-1",
      run_id: "run-1",
      action_id: "action-1",
      workspace: {
        handle_id: "workspace-other",
        project_id: "project-other",
        real_root: "/tmp/other",
        workspace_kind: "disposable_fixture",
        capabilities: {
          index: true,
          read: true,
          search: true,
          run_command: true,
          preview_patch: true,
          commit_patch: true,
          test: true,
        },
        created_at: "2026-09-18T00:00:00.000Z",
      },
    })).toThrow(/workspace project_id must match rollback project_id/u);
  });

  it("never accepts a browser filesystem path when opening a local project", () => {
    expect(OpenLocalProjectRequestSchema.parse({
      command_id: "cmd-open",
      access: "read_write",
    })).toEqual({ command_id: "cmd-open", access: "read_write" });
    expect(() => OpenLocalProjectRequestSchema.parse({
      command_id: "cmd-open",
      access: "read_write",
      path: "/Users/example/private",
    })).toThrow();
  });

  it("keeps project locations informational and plain chats project-free", () => {
    expect(ProjectSummarySchema.parse({
      project_id: "project-local",
      label: "Local project",
      workspace_kind: "managed_local",
      capabilities: {
        index: true,
        read: true,
        search: true,
        run_command: true,
        preview_patch: true,
        commit_patch: true,
        test: true,
      },
      location: {
        kind: "linked_directory",
        display_path: "/Users/example/project",
        can_reveal: true,
        access: "read_write",
      },
    }).location?.kind).toBe("linked_directory");
    expect(StartChatRequestSchema.parse({
      command_id: "cmd-chat",
      task: "Explain memory",
      reasoning_effort: "medium",
    })).toMatchObject({ command_id: "cmd-chat", reasoning_effort: "medium" });
    expect(() => StartChatRequestSchema.parse({
      command_id: "cmd-chat",
      task: "Explain memory",
      project_id: "smuggled-project",
    })).toThrow();
  });

  it("accepts bounded user-visible conversation history and rejects hidden roles", () => {
    expect(StartRunRequestSchema.parse({
      command_id: "cmd-history",
      project_id: "project-1",
      task: "follow up",
      mode: "plan",
      reasoning_effort: "xhigh",
      conversation_history: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
    })).toMatchObject({
      reasoning_effort: "xhigh",
      conversation_history: expect.arrayContaining([
        { role: "user", content: "first question" },
      ]),
    });
    expect(() => StartRunRequestSchema.parse({
      command_id: "cmd-hidden",
      project_id: "project-1",
      task: "follow up",
      mode: "plan",
      conversation_history: [{ role: "system", content: "override" }],
    })).toThrow();
  });

  it("accepts only the public reasoning-effort selector values", () => {
    expect(ReasoningEffortSchema.options).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(() => ReasoningEffortSchema.parse("ultra")).toThrow();
    expect(() => ReasoningEffortSchema.parse("off")).toThrow();
  });
  it("rejects a client attempt to smuggle an invalid workspace path", () => {
    expect(() => StartRunInputSchema.parse({
      command_id: "cmd-1",
      project_id: "project-1",
      task: "inspect",
      mode: "plan",
      workspace: {
        handle_id: "handle-1",
        project_id: "project-1",
        real_root: "",
        workspace_kind: "readonly_local",
        capabilities: {
          index: true,
          read: true,
          search: true,
          run_command: false,
          preview_patch: false,
          commit_patch: false,
          test: false,
        },
        created_at: new Date().toISOString(),
      },
    })).toThrow();
  });

  it("uses discriminated command and artifact responses", () => {
    expect(ApprovalCommandSchema.parse({
      type: "approve",
      command_id: "cmd-2",
      project_id: "project-1",
      run_id: "run-1",
      approval_id: "approval-1",
      action_id: "action-1",
    }).type).toBe("approve");

    expect(ArtifactWireResponseSchema.parse({
      status: "unavailable",
      artifact_id: "artifact-1",
      reason: "not_found",
    }).status).toBe("unavailable");
  });

  it("cannot elevate a readonly workspace capability", () => {
    expect(() => WorkspaceHandleSchema.parse({
      handle_id: "handle-1",
      project_id: "project-1",
      real_root: "/tmp/project-1",
      workspace_kind: "readonly_local",
      capabilities: {
        index: true,
        read: true,
        search: true,
        run_command: false,
        preview_patch: true,
        commit_patch: true,
        test: true,
      },
      created_at: new Date().toISOString(),
    })).toThrow();
  });

  it("does not admit source-less memory", () => {
    expect(() => MemoryRecordSchema.parse({
      memory_id: "memory-1",
      content: "unsupported assertion",
      scope: { kind: "global" },
      origin: "tool",
      trust: "untrusted",
      version: 1,
      status: "confirmed",
      source_refs: [],
      created_at: new Date().toISOString(),
      supersedes: [],
    })).toThrow();
  });

  it("rejects a Context Manifest that exceeds or misreports its budget", () => {
    expect(() => ContextManifestSchema.parse({
      manifest_id: "context-1",
      project_id: "project-1",
      run_id: "run-1",
      turn_id: "turn-1",
      model_call_id: "model-call-1",
      token_limit: 100,
      reserved_output_tokens: 20,
      input_tokens: 90,
      items: [{
        item_id: "item-1",
        section: "goal",
        label: "Goal",
        source: { source_id: "user-1", source_type: "user", trust: "trusted" },
        original_tokens: 90,
        included_tokens: 90,
        action: "pinned",
        reason: "user_goal",
      }],
      fixed_constraints_preserved: true,
      created_at: "2026-09-16T00:00:00.000Z",
    })).toThrow("input token usage exceeds the available context budget");
  });

  it("parses an older Context Manifest artifact without applied_strategy", () => {
    const legacy = ContextManifestSchema.parse({
      manifest_id: "context-legacy",
      project_id: "project-legacy",
      run_id: "run-legacy",
      turn_id: "turn-legacy",
      model_call_id: "model-call-legacy",
      token_limit: 1_000,
      reserved_output_tokens: 200,
      input_tokens: 1,
      compression: {
        strategy: "none",
        trigger: "within_budget",
        before_tokens: 1,
        after_tokens: 1,
        original_history_tokens: 0,
        checkpoint_tokens: 0,
        preserved_recent_message_count: 0,
        compacted_history_message_count: 0,
      },
      items: [{
        item_id: "item-legacy",
        section: "goal",
        label: "Goal",
        source: { source_id: "user-legacy", source_type: "user", trust: "trusted" },
        original_tokens: 1,
        included_tokens: 1,
        action: "pinned",
        reason: "user_goal",
      }],
      fixed_constraints_preserved: true,
      created_at: "2026-09-16T00:00:00.000Z",
    });

    expect(legacy.compression).toMatchObject({
      strategy: "none",
      applied_strategy: "none",
    });
  });

  it("binds Context token-estimate totals and sections to the visible manifest items", () => {
    const manifest = {
      manifest_id: "context-metered",
      project_id: "project-metered",
      run_id: "run-metered",
      turn_id: "turn-metered",
      model_call_id: "model-call-metered",
      token_limit: 1_000,
      reserved_output_tokens: 200,
      input_tokens: 8,
      token_estimate: {
        estimator_id: "heuristic_v2",
        confidence: "estimated",
        input_tokens: 8,
        output_tokens: 0,
        per_section: { system: 3, goal: 5, history: 0, tool: 0, repo: 0, memory: 0 },
      },
      items: [{
        item_id: "item-system-metered",
        section: "system",
        label: "Rules",
        source: { source_id: "system-metered", source_type: "system", trust: "trusted" },
        original_tokens: 3,
        included_tokens: 3,
        action: "pinned",
        reason: "security_anchor",
      }, {
        item_id: "item-goal-metered",
        section: "goal",
        label: "Goal",
        source: { source_id: "user-metered", source_type: "user", trust: "trusted" },
        original_tokens: 5,
        included_tokens: 5,
        action: "pinned",
        reason: "user_goal",
      }],
      fixed_constraints_preserved: true,
      created_at: "2026-09-18T00:00:00.000Z",
    } as const;

    expect(ContextManifestSchema.parse(manifest).input_tokens).toBe(8);
    expect(() => ContextManifestSchema.parse({
      ...manifest,
      token_estimate: {
        ...manifest.token_estimate,
        input_tokens: 9,
        per_section: { ...manifest.token_estimate.per_section, goal: 6 },
      },
    })).toThrow("token estimate input usage must equal manifest input_tokens");
    expect(() => ContextManifestSchema.parse({
      ...manifest,
      token_estimate: {
        ...manifest.token_estimate,
        per_section: { ...manifest.token_estimate.per_section, system: 4, goal: 4 },
      },
    })).toThrow("token estimate section usage must equal visible manifest item usage");
    expect(() => ContextManifestSchema.parse({
      ...manifest,
      budget: {
        input_budget_tokens: 700,
        warning_threshold_tokens: 400,
        compression_threshold_tokens: 600,
        token_estimator: "heuristic_v2",
        status: "healthy",
      },
    })).toThrow("input budget must equal token_limit minus reserved_output_tokens");
  });

  it("keeps context policy thresholds ordered and leaves an input budget", () => {
    expect(ContextPolicySchema.parse({
      window_tokens: 258_000,
      reserved_output_tokens: 32_000,
      warning_ratio: 0.7,
      compression_ratio: 0.8,
      recent_history_messages: 16,
      history_checkpoint_tokens: 4_096,
      tool_budget_ratio: 0.1,
      token_estimator: "heuristic_v2",
    })).toMatchObject({
      window_tokens: 258_000,
      reserved_output_tokens: 32_000,
      warning_ratio: 0.7,
      compression_ratio: 0.8,
    });
    expect(() => ContextPolicySchema.parse({
      window_tokens: 258_000,
      reserved_output_tokens: 258_000,
      warning_ratio: 0.8,
      compression_ratio: 0.7,
      recent_history_messages: 16,
      history_checkpoint_tokens: 4_096,
      tool_budget_ratio: 0.1,
      token_estimator: "heuristic_v2",
    })).toThrow();
    expect(() => ContextBudgetSchema.parse({
      input_budget_tokens: 800,
      warning_threshold_tokens: 700,
      compression_threshold_tokens: 600,
      token_estimator: "heuristic_v2",
      status: "healthy",
    })).toThrow("compression threshold must be greater than warning threshold");
  });

  it("enforces exhaustive Token estimates and canonical provider usage totals", () => {
    const perSection = {
      system: 2,
      goal: 3,
      history: 5,
      tool: 7,
      repo: 11,
      memory: 13,
    } as const;
    expect(TokenEstimateSchema.parse({
      estimator_id: "heuristic_v2",
      confidence: "estimated",
      input_tokens: 41,
      output_tokens: 0,
      per_section: perSection,
    }).input_tokens).toBe(41);
    expect(() => TokenEstimateSchema.parse({
      estimator_id: "provider-response",
      confidence: "provider_reported",
      input_tokens: 41,
      output_tokens: 0,
      per_section: perSection,
    })).toThrow();
    expect(() => TokenEstimateSchema.parse({
      estimator_id: "heuristic_v2",
      confidence: "estimated",
      input_tokens: 40,
      output_tokens: 0,
      per_section: perSection,
    })).toThrow("per_section token counts must sum to input_tokens");
    expect(() => TokenEstimateSchema.parse({
      estimator_id: "heuristic_v2",
      confidence: "estimated",
      input_tokens: 28,
      output_tokens: 0,
      per_section: { ...perSection, memory: undefined },
    })).toThrow();

    const usage = ModelUsageReportSchema.parse({
      provider: "openai",
      model: "gpt-5.6-sol",
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 80,
      reasoning_output_tokens: 5,
      total_tokens: 120,
      request_kind: "initial",
      request_sequence: 1,
      provider_reported_cost: { amount: 0.012, currency: "USD" },
    });
    expect(usage.total_tokens).toBe(120);
    expect(() => ModelUsageReportSchema.parse({ ...usage, total_tokens: 200 })).toThrow(
      "total_tokens must equal input_tokens plus output_tokens",
    );
    expect(() => TokenUsageObservationSchema.parse({
      model_call_id: "model-call:invalid-confidence",
      provider: usage.provider,
      model: usage.model,
      estimator_id: "heuristic_v2",
      confidence: "estimated",
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      estimated_input_tokens: 100,
      delta_ratio: 1,
      anomaly: false,
      calibration_applied: false,
      calibration_revision: 0,
      request_kind: "initial",
      request_sequence: 1,
    })).toThrow();
    expect(() => ModelUsageReportSchema.parse({ ...usage, cached_input_tokens: 101 })).toThrow();
    expect(() => ModelUsageReportSchema.parse({ ...usage, secret: "not permitted" })).toThrow();
  });

  it("rejects duplicate or malformed persisted token calibration entries", () => {
    const entry = {
      provider: "openai",
      model: "gpt-5.6-sol",
      samples: [{ ratio: 1.25, observed_at: "2026-09-18T00:00:00.000Z" }],
    } as const;
    expect(TokenCalibrationFileSchema.parse({
      version: 1,
      revision: 1,
      updated_at: "2026-09-18T00:00:00.000Z",
      entries: [entry],
    }).entries).toHaveLength(1);
    expect(() => TokenCalibrationFileSchema.parse({
      version: 1,
      revision: 2,
      updated_at: "2026-09-18T00:00:00.000Z",
      entries: [entry, entry],
    })).toThrow("provider/model calibration entries must be unique");
    expect(() => TokenCalibrationFileSchema.parse({
      version: 99,
      revision: 1,
      updated_at: "2026-09-18T00:00:00.000Z",
      entries: [entry],
    })).toThrow();
  });

  it("rejects Windows and UNC absolute paths on every host platform", () => {
    expect(() => RelativePathSchema.parse("C:\\Users\\cain\\secret.txt")).toThrow();
    expect(() => RelativePathSchema.parse("C:secret.txt")).toThrow();
    expect(() => RelativePathSchema.parse("\\rooted\\secret.txt")).toThrow();
    expect(() => RelativePathSchema.parse("\\\\server\\share\\secret.txt")).toThrow();
  });

  it("rejects duplicate graph ids and dangling graph edges", () => {
    const workspaceHash = `sha256:${"a".repeat(64)}`;
    expect(() => GraphSnapshotSchema.parse({
      snapshot_id: "snapshot:1",
      project_id: "project:1",
      workspace_hash: workspaceHash,
      created_at: "2026-09-16T00:00:00.000Z",
      nodes: [
        { id: "file:a.ts", kind: "file", label: "a.ts", file_path: "a.ts" },
        { id: "file:a.ts", kind: "file", label: "duplicate.ts", file_path: "duplicate.ts" },
      ],
      edges: [{
        id: "edge:1",
        kind: "static_import",
        source_node_id: "file:a.ts",
        target_node_id: "file:missing.ts",
        file_path: "a.ts",
        confidence: "high",
        resolution: "resolved",
      }],
    })).toThrow();
  });

  it("requires graph delta evidence that matches its change kind", () => {
    expect(() => GraphDeltaSchema.parse({
      graph_delta_id: "delta:1",
      project_id: "project:1",
      base_snapshot_id: "snapshot:1",
      result_snapshot_id: "snapshot:2",
      created_at: "2026-09-16T00:00:00.000Z",
      node_changes: [{ change: "added" }],
      edge_changes: [],
    })).toThrow("added graph change requires after");
  });

  it("accepts safe credential references and metadata", () => {
    expect(CredentialNameSchema.parse("TRACEGRAPH_OPENAI_KEY")).toBe("TRACEGRAPH_OPENAI_KEY");
    expect(SecretReferenceSchema.parse("${secret:TRACEGRAPH_OPENAI_KEY}")).toBe("${secret:TRACEGRAPH_OPENAI_KEY}");
    expect(SafeCredentialMetadataSchema.parse({
      name: "TRACEGRAPH_OPENAI_KEY",
      backend: "macos_keychain",
      writable: true,
      last_updated_at: "2026-09-18T00:00:00.000Z",
    })).toEqual({
      name: "TRACEGRAPH_OPENAI_KEY",
      backend: "macos_keychain",
      writable: true,
      last_updated_at: "2026-09-18T00:00:00.000Z",
    });
    expect(EventTypeSchema.parse("credentials.migrated")).toBe("credentials.migrated");
    expect(CredentialMigrationMarkerSchema.parse({
      migration_id: "c74ecf39-f0cd-4376-80a8-4a78188891d8",
      credential: {
        name: "TRACEGRAPH_OPENAI_KEY",
        backend: "macos_keychain",
        writable: true,
      },
      secret_reference: "${secret:TRACEGRAPH_OPENAI_KEY}",
      migrated_at: "2026-09-18T00:00:00.000Z",
    })).toMatchObject({ migration_id: "c74ecf39-f0cd-4376-80a8-4a78188891d8" });
    expect(() => CredentialMigrationMarkerSchema.parse({
      migration_id: "c74ecf39-f0cd-4376-80a8-4a78188891d8",
      credential: {
        name: "TRACEGRAPH_DEEPSEEK_KEY",
        backend: "macos_keychain",
        writable: true,
      },
      secret_reference: "${secret:TRACEGRAPH_OPENAI_KEY}",
      migrated_at: "2026-09-18T00:00:00.000Z",
    })).toThrow();
  });

  it("accepts a write-only model API key in an update request", () => {
    expect(ModelConfigUpdateRequestSchema.parse({
      provider: "openai",
      protocol: "openai-chat-completions",
      base_url: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      api_key: "new-secret",
    })).toMatchObject({
      provider: "openai",
      api_key: "new-secret",
    });
  });

  it("rejects plaintext where a secret reference is required", () => {
    expect(() => SecretReferenceSchema.parse("sk-plaintext-secret")).toThrow();
    expect(() => SecretReferenceSchema.parse("${secret:lowercase-name}")).toThrow();
    expect(() => CredentialNameSchema.parse("tracegraph_openai_key")).toThrow();
    expect(() => CredentialBackendSchema.parse("plaintext_file")).toThrow();
  });

  it("never admits an API key into public model configuration", () => {
    const safe = {
      provider: "openai",
      protocol: "openai-chat-completions",
      configured: true,
      base_url: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      has_key: true,
      credential: {
        name: "TRACEGRAPH_OPENAI_KEY",
        backend: "environment",
        writable: false,
      },
    } as const;
    expect(PublicModelConfigResponseSchema.parse(safe)).toEqual(safe);
    expect(() => PublicModelConfigResponseSchema.parse({
      ...safe,
      api_key: "must-not-cross-the-wire",
    })).toThrow();
    expect(() => SafeCredentialMetadataSchema.parse({
      ...safe.credential,
      value: "must-not-cross-the-wire",
    })).toThrow();
  });

  it("defines strict, reference-only session JSONL records", () => {
    expect(SessionHeaderSchema.parse({
      kind: "header",
      session_version: SESSION_FORMAT_VERSION,
      session_id: "session-1",
      project_id: "project-1",
      created_at: "2026-09-18T00:00:00.000Z",
    })).toMatchObject({ run_ids: [] });

    const reference = {
      kind: "event_ref",
      session_version: SESSION_FORMAT_VERSION,
      entry_id: "entry-1",
      created_at: "2026-09-18T00:00:01.000Z",
      event_ref: { event_id: "event-1", run_id: "run-1", sequence: 1 },
    } as const;
    expect(SessionEventReferenceSchema.parse(reference)).toEqual(reference);
    expect(() => SessionEventReferenceSchema.parse({
      ...reference,
      event: { type: "run.created", summary: "must not be copied" },
    })).toThrow();
  });

  it("exposes bounded session route and recovery contracts", () => {
    expect(SessionListQuerySchema.parse({ limit: "25", q: "needle" })).toEqual({
      limit: 25,
      q: "needle",
      view: "roots",
    });
    expect(() => SessionListQuerySchema.parse({ limit: 101 })).toThrow();
    expect(SessionResumeResponseSchema.parse({
      session_id: "session-1",
      project_id: "project-1",
      run_id: "run-1",
      status: "awaiting_approval",
      resumed_at: "2026-09-18T00:00:02.000Z",
    }).status).toBe("awaiting_approval");
    expect(SessionRecoveryReportSchema.parse({
      scanned_sessions: 2,
      truncated_session_ids: ["session-1"],
      interrupted_run_ids: ["run-1"],
      recovered_at: "2026-09-18T00:00:02.000Z",
    }).scanned_sessions).toBe(2);
    for (const type of [
      "session.opened",
      "session.closed",
      "session.title_changed",
      "session.tail_truncated",
      "run.interrupted",
      "run.resumed",
    ]) {
      expect(EventTypeSchema.parse(type)).toBe(type);
    }
  });
});
