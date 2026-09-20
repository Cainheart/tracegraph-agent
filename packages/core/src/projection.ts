import {
  AttachmentAddedDataSchema,
  AttachmentListProjectionSchema,
  AttachmentOffloadedDataSchema,
  AttachmentRejectedDataSchema,
  CODE_INTEL_VERSION,
  CodeIntelUpdatedDataSchema,
  CodeStaleBaseDetectedDataSchema,
  LspDiagnosticsReceivedDataSchema,
  PROJECTOR_VERSION,
  MAX_PENDING_USER_INPUTS,
  MAX_USER_INPUT_BODY_CHARS,
  PendingApprovalSchema,
  PermissionConfiguredDataSchema,
  ReasoningEffortSchema,
  RunProjectionSchema,
  SandboxReportSchema,
  SCHEMA_VERSION,
  DEFAULT_SUBAGENT_LIMITS,
  SubagentCompletedDataSchema,
  SubagentFailedDataSchema,
  SubagentInterruptedDataSchema,
  SubagentLimitsSchema,
  SubagentListProjectionSchema,
  SubagentMessageSentDataSchema,
  SubagentProjectionItemSchema,
  SubagentStartedDataSchema,
  UserInputConsumedDataSchema,
  UserInputQueuedDataSchema,
  WireSessionEventSchema,
  type ArtifactRef,
  type AttachmentListProjection,
  type AttachmentProjectionItem,
  type InputQueueProjection,
  type PendingUserInput,
  type RunProjection,
  type SessionEvent,
  type SubagentListProjection,
  type SubagentProjectionItem,
  type SubagentRunLink,
  type WireSessionEvent,
} from "@tracegraph/contracts";
import { redactSensitiveText, redactStructuredValue } from "./crypto.js";
import { projectTeam } from "./team.js";
import { projectTodos } from "./todo.js";

export function projectRun(events: readonly SessionEvent[]): RunProjection {
  const first = events[0];
  if (first === undefined || first.type !== "run.created") {
    throw new ProjectionError("run.created must be the first event");
  }
  const task = typeof first.data.task === "string" ? redactSensitiveText(first.data.task) : "";
  // `manual` is the pre-G09 spelling of execute and remains replay-only.
  let mode: RunProjection["mode"] = first.data.mode === "plan" ? "plan" : "execute";
  const parsedReasoningEffort = ReasoningEffortSchema.safeParse(first.data.reasoning_effort);
  const reasoningEffort = parsedReasoningEffort.success ? parsedReasoningEffort.data : "default";
  const workspaceKind = first.data.workspace_kind === "readonly_local"
    ? "readonly_local"
    : first.data.workspace_kind === "managed_local"
      ? "managed_local"
      : "disposable_fixture";
  const artifactMap = new Map<string, ArtifactRef>();
  let status: RunProjection["status"] = "created";
  let pendingApproval: RunProjection["pending_approval"];
  let pendingPlan: RunProjection["pending_plan"];
  let outcome: string | undefined;
  let failureCode: string | undefined;
  let needsManualReview = false;
  let sandboxReport: RunProjection["sandbox_report"];
  let permission: RunProjection["permission"];
  let diagnosticsSummary: RunProjection["diagnostics_summary"];
  let codeIntel: RunProjection["code_intel"];
  const inputQueue = projectInputQueue(events);
  const subagents = projectSubagents(events);
  const attachments = projectAttachments(events);
  const team = projectTeam(events);

  for (const event of events) {
    for (const artifact of event.artifact_refs) {
      artifactMap.set(artifact.artifact_id, artifact);
    }
    if (
      event.type === "sandbox.enforced"
      || event.type === "sandbox.disabled"
      || event.type === "tool.completed"
      || event.type === "tool.failed"
      || event.type === "tool.unknown"
    ) {
      const parsedSandboxReport = SandboxReportSchema.safeParse(event.data.sandbox_report);
      if (parsedSandboxReport.success) sandboxReport = parsedSandboxReport.data;
    }
    if (event.type === "permission.configured") {
      const parsedPermission = PermissionConfiguredDataSchema.safeParse(event.data);
      if (parsedPermission.success) permission = parsedPermission.data.permission;
    }
    switch (event.type) {
      case "run.started":
        status = event.data.phase === "indexing" ? "indexing" : "running";
        break;
      case "context.built":
        status = "running";
        break;
      case "plan.ready": {
        const todoIds = Array.isArray(event.data.todo_ids)
          ? event.data.todo_ids.filter((value): value is string => typeof value === "string")
          : [];
        pendingPlan = todoIds.length === 0
          ? undefined
          : { plan_event_id: event.event_id, todo_ids: todoIds };
        status = "awaiting_plan_approval";
        break;
      }
      case "plan.approved":
        mode = "execute";
        pendingPlan = undefined;
        status = "running";
        break;
      case "approval.requested": {
        const parsed = PendingApprovalSchema.safeParse(event.data.pending_approval);
        if (parsed.success) {
          pendingApproval = PendingApprovalSchema.parse({
            ...parsed.data,
            preview: {
              ...parsed.data.preview,
              diff: redactSensitiveText(parsed.data.preview.diff),
            },
          });
        }
        status = "awaiting_approval";
        break;
      }
      case "approval.granted":
      case "approval.denied":
      case "approval.expired":
        pendingApproval = undefined;
        status = "running";
        break;
      case "action.diverged":
        pendingApproval = undefined;
        needsManualReview = true;
        status = "needs_manual_review";
        failureCode = "action_diverged";
        break;
      case "run.interrupted":
        pendingApproval = undefined;
        // A hash divergence is stronger than the generic restart marker. It
        // must remain visible until a human resolves the workspace state.
        if (status !== "needs_manual_review") status = "interrupted";
        break;
      case "run.resumed":
        status = event.data.restored_status === "interrupted"
          ? "interrupted"
          : event.data.restored_status === "awaiting_plan_approval"
            ? "awaiting_plan_approval"
            : "running";
        break;
      case "run.completed":
        status = "completed";
        pendingPlan = undefined;
        pendingApproval = undefined;
        outcome = typeof event.data.outcome === "string"
          ? redactSensitiveText(event.data.outcome)
          : redactSensitiveText(event.summary);
        break;
      case "run.failed":
        status = "failed";
        pendingPlan = undefined;
        pendingApproval = undefined;
        outcome = redactSensitiveText(event.summary);
        failureCode = typeof event.data.code === "string" ? event.data.code : "run_failed";
        break;
      case "run.cancelled":
        status = "cancelled";
        pendingPlan = undefined;
        pendingApproval = undefined;
        outcome = redactSensitiveText(event.summary);
        break;
      case "lsp.diagnostics_received": {
        const parsed = LspDiagnosticsReceivedDataSchema.safeParse(event.data);
        if (parsed.success && parsed.data.project_id === first.project_id) {
          diagnosticsSummary = {
            server_name: parsed.data.server_name,
            files_scanned: parsed.data.files_scanned,
            diagnostic_count: parsed.data.diagnostic_count,
            error_count: parsed.data.error_count,
            warning_count: parsed.data.warning_count,
            information_count: parsed.data.information_count,
            hint_count: parsed.data.hint_count,
            truncated: parsed.data.truncated,
            sample: parsed.data.sample,
            diagnostics_hash: parsed.data.diagnostics_hash,
          };
          if (codeIntel !== undefined) {
            codeIntel = { ...codeIntel, diagnostics_summary: diagnosticsSummary };
          }
        }
        break;
      }
      case "code.intel_updated": {
        const parsed = CodeIntelUpdatedDataSchema.safeParse(event.data);
        if (!parsed.success || parsed.data.project_id !== first.project_id) {
          throw new ProjectionError(`invalid code.intel_updated payload at sequence ${event.sequence}`);
        }
        codeIntel = {
          version: CODE_INTEL_VERSION,
          git_context: parsed.data.git_context,
          ...(parsed.data.base_snapshot_id === undefined
            ? {}
            : { base_snapshot_id: parsed.data.base_snapshot_id }),
          ...(parsed.data.result_snapshot_id === undefined
            ? {}
            : { result_snapshot_id: parsed.data.result_snapshot_id }),
          changed_files: parsed.data.changed_files,
          changed_files_truncated: parsed.data.changed_files_truncated,
          changed_symbols: parsed.data.changed_symbols,
          changed_symbols_truncated: parsed.data.changed_symbols_truncated,
          ...(diagnosticsSummary === undefined ? {} : { diagnostics_summary: diagnosticsSummary }),
        };
        break;
      }
      case "code.stale_base_detected": {
        const parsed = CodeStaleBaseDetectedDataSchema.safeParse(event.data);
        if (!parsed.success || parsed.data.project_id !== first.project_id) {
          throw new ProjectionError(`invalid code.stale_base_detected payload at sequence ${event.sequence}`);
        }
        const prior = codeIntel;
        const latestDiagnostics = diagnosticsSummary ?? prior?.diagnostics_summary;
        codeIntel = {
          version: CODE_INTEL_VERSION,
          git_context: parsed.data.stale_base.actual,
          ...(prior?.base_snapshot_id === undefined ? {} : { base_snapshot_id: prior.base_snapshot_id }),
          ...(prior?.result_snapshot_id === undefined ? {} : { result_snapshot_id: prior.result_snapshot_id }),
          changed_files: prior?.changed_files ?? [],
          changed_files_truncated: prior?.changed_files_truncated ?? false,
          changed_symbols: prior?.changed_symbols ?? [],
          changed_symbols_truncated: prior?.changed_symbols_truncated ?? false,
          ...(latestDiagnostics === undefined ? {} : { diagnostics_summary: latestDiagnostics }),
          stale_base: parsed.data.stale_base,
        };
        break;
      }
      default:
        break;
    }
  }

  if (needsManualReview) {
    status = "needs_manual_review";
    pendingApproval = undefined;
    failureCode = "action_diverged";
  }

  return RunProjectionSchema.parse({
    schema_version: SCHEMA_VERSION,
    projector_version: PROJECTOR_VERSION,
    project_id: first.project_id,
    ...(first.session_id === undefined ? {} : { session_id: first.session_id }),
    run_id: first.run_id,
    task,
    mode,
    reasoning_effort: reasoningEffort,
    workspace_kind: workspaceKind,
    status,
    last_sequence: events.at(-1)?.sequence ?? 0,
    timeline: events.map(toWireEvent),
    todos: projectTodos(events),
    input_queue: inputQueue,
    subagents,
    attachments,
    ...(team === undefined ? {} : { team }),
    ...(pendingPlan === undefined ? {} : { pending_plan: pendingPlan }),
    ...(pendingApproval === undefined ? {} : { pending_approval: pendingApproval }),
    ...(sandboxReport === undefined ? {} : { sandbox_report: sandboxReport }),
    ...(permission === undefined ? {} : { permission }),
    ...(diagnosticsSummary === undefined ? {} : { diagnostics_summary: diagnosticsSummary }),
    ...(codeIntel === undefined ? {} : { code_intel: codeIntel }),
    artifact_refs: [...artifactMap.values()],
    ...(outcome === undefined ? {} : { outcome }),
    ...(failureCode === undefined ? {} : { failure_code: failureCode }),
  });
}

/**
 * Rebuild the G-18 attachment view from strict, content-free ledger facts.
 * Raw bytes stay in the Artifact Store; replay only trusts a ref when the
 * matching attachment Artifact was linked by the committed added event.
 */
function projectAttachments(events: readonly SessionEvent[]): AttachmentListProjection {
  const first = events[0];
  const expectedProjectId = first?.project_id;
  const expectedRunId = first?.run_id;
  const items = new Map<string, AttachmentProjectionItem>();
  let lastSequence = 0;
  let runStarted = false;

  for (const event of events) {
    if (event.type === "run.started") runStarted = true;
    if (
      event.type === "attachment.added"
      || event.type === "attachment.rejected"
      || event.type === "attachment.offloaded"
    ) {
      if (event.project_id !== expectedProjectId || event.run_id !== expectedRunId) {
        throw new ProjectionError(`attachment event scope mismatch at sequence ${event.sequence}`);
      }
      if (runStarted) {
        throw new ProjectionError(`attachment event follows run.started at sequence ${event.sequence}`);
      }
    }
    if (event.type === "attachment.added") {
      const parsed = AttachmentAddedDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidAttachmentPayload(event);
      const data = parsed.data;
      if (items.has(data.upload_id)) {
        throw new ProjectionError(`duplicate attachment upload_id ${data.upload_id}`);
      }
      const canonical = event.artifact_refs.find(
        (artifact) => artifact.artifact_id === data.attachment.attachment_id,
      );
      if (
        canonical === undefined
        || canonical.project_id !== event.project_id
        || canonical.run_id !== event.run_id
        || canonical.kind !== data.attachment.media_type
        || canonical.mime_type !== data.attachment.media_type
        || canonical.byte_length !== data.attachment.bytes
        || canonical.content_hash !== data.attachment.sha256
      ) {
        throw new ProjectionError(`attachment.added Artifact proof mismatch at sequence ${event.sequence}`);
      }
      if (
        data.attachment.extracted_text_artifact_id !== undefined
        && !event.artifact_refs.some((artifact) => (
          artifact.artifact_id === data.attachment.extracted_text_artifact_id
          && artifact.project_id === event.project_id
          && artifact.run_id === event.run_id
          && artifact.mime_type === "text/plain"
        ))
      ) {
        throw new ProjectionError(`attachment.added extracted-text proof mismatch at sequence ${event.sequence}`);
      }
      items.set(data.upload_id, { ...data, status: "added" });
      lastSequence = event.sequence;
      continue;
    }

    if (event.type === "attachment.rejected") {
      const parsed = AttachmentRejectedDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidAttachmentPayload(event);
      if (items.has(parsed.data.upload_id)) {
        throw new ProjectionError(`duplicate attachment upload_id ${parsed.data.upload_id}`);
      }
      items.set(parsed.data.upload_id, { ...parsed.data, status: "rejected" });
      lastSequence = event.sequence;
      continue;
    }

    if (event.type === "attachment.offloaded") {
      const parsed = AttachmentOffloadedDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidAttachmentPayload(event);
      const existing = items.get(parsed.data.upload_id);
      if (existing === undefined || existing.status === "rejected") {
        throw new ProjectionError(`attachment.offloaded has no added upload at sequence ${event.sequence}`);
      }
      if (
        existing.status === "offloaded"
        || JSON.stringify(existing.attachment) !== JSON.stringify(parsed.data.attachment)
      ) {
        throw new ProjectionError(`attachment.offloaded conflicts with its added event at sequence ${event.sequence}`);
      }
      items.set(parsed.data.upload_id, {
        ...existing,
        status: "offloaded",
        offload_reason: parsed.data.reason,
      });
      lastSequence = event.sequence;
    }
  }

  return AttachmentListProjectionSchema.parse({ items: [...items.values()], last_sequence: lastSequence });
}

function invalidAttachmentPayload(event: SessionEvent): ProjectionError {
  return new ProjectionError(`invalid ${event.type} payload at sequence ${event.sequence}`);
}

/**
 * Rebuild the parent-side G-07 control-plane view without reading a child
 * ledger. Child execution facts remain isolated; terminal payloads carry only
 * a bounded result and the hash-linked child terminal proof.
 */
function projectSubagents(events: readonly SessionEvent[]): SubagentListProjection {
  const first = events[0];
  const expectedRunId = first?.run_id;
  const expectedSessionId = first?.session_id;
  let limits: SubagentListProjection["limits"] = { ...DEFAULT_SUBAGENT_LIMITS };
  if (first !== undefined && Object.hasOwn(first.data, "subagent_limits")) {
    const parsedLimits = SubagentLimitsSchema.safeParse(first.data.subagent_limits);
    if (!parsedLimits.success) {
      throw new ProjectionError("invalid run.created subagent_limits payload");
    }
    limits = parsedLimits.data;
  }

  const items = new Map<string, SubagentProjectionItem>();
  const childRunIds = new Set<string>();
  const childSessionIds = new Set<string>();
  const messageIds = new Set<string>();
  let parentTerminalSeen = false;

  for (const event of events) {
    const isSubagentEvent = event.type.startsWith("subagent.");
    if (isSubagentEvent && parentTerminalSeen) {
      throw new ProjectionError(`subagent event follows parent terminal event at sequence ${event.sequence}`);
    }

    if (event.type === "subagent.started") {
      const parsed = SubagentStartedDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidSubagentPayload(event);
      assertParentEventScope(event, parsed.data.link, expectedRunId, expectedSessionId);
      if (!sameSubagentLimits(parsed.data.limits, limits)) {
        throw new ProjectionError(`subagent.started effective limits mismatch at sequence ${event.sequence}`);
      }
      if (items.has(parsed.data.link.subagent_id)) {
        throw new ProjectionError(`duplicate subagent_id ${parsed.data.link.subagent_id}`);
      }
      if (childRunIds.has(parsed.data.link.child_run_id)) {
        throw new ProjectionError(`duplicate child_run_id ${parsed.data.link.child_run_id}`);
      }
      if (childSessionIds.has(parsed.data.link.child_session_id)) {
        throw new ProjectionError(`duplicate child_session_id ${parsed.data.link.child_session_id}`);
      }
      const activeCount = [...items.values()].filter(({ status }) => status === "running").length;
      if (activeCount >= limits.max_parallel_subagents) {
        throw new ProjectionError(`subagent concurrency exceeds ${limits.max_parallel_subagents}`);
      }
      const item = SubagentProjectionItemSchema.parse({
        link: parsed.data.link,
        name: parsed.data.spec.name,
        provider_key: parsed.data.spec.provider_key,
        role_prompt_version: parsed.data.spec.role_prompt_version,
        role_prompt_hash: parsed.data.spec.role_prompt_hash,
        tool_allowlist: parsed.data.spec.tool_allowlist,
        context_scope: parsed.data.spec.context_scope,
        budget: parsed.data.spec.budget,
        depth: parsed.data.spec.depth,
        status: "running",
        started_event_id: event.event_id,
        started_at: event.occurred_at,
        message_count: 0,
      });
      items.set(parsed.data.link.subagent_id, item);
      childRunIds.add(parsed.data.link.child_run_id);
      childSessionIds.add(parsed.data.link.child_session_id);
      continue;
    }

    if (event.type === "subagent.message_sent") {
      const parsed = SubagentMessageSentDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidSubagentPayload(event);
      assertParentEventScope(event, parsed.data.link, expectedRunId, expectedSessionId);
      const current = requireRunningSubagent(items, parsed.data.link, event);
      if (messageIds.has(parsed.data.message.message_id)) {
        throw new ProjectionError(`duplicate subagent message_id ${parsed.data.message.message_id}`);
      }
      if (current.message_count === 0 && parsed.data.message.kind !== "initial_task") {
        throw new ProjectionError(`first subagent message must be initial_task at sequence ${event.sequence}`);
      }
      if (current.message_count > 0 && parsed.data.message.kind === "initial_task") {
        throw new ProjectionError(`subagent initial task was sent more than once at sequence ${event.sequence}`);
      }
      if (Date.parse(parsed.data.message.sent_at) < Date.parse(current.started_at)) {
        throw new ProjectionError(`subagent message predates start at sequence ${event.sequence}`);
      }
      messageIds.add(parsed.data.message.message_id);
      items.set(current.link.subagent_id, SubagentProjectionItemSchema.parse({
        ...current,
        message_count: current.message_count + 1,
        ...(current.initial_message_event_id === undefined
          ? { initial_message_event_id: event.event_id }
          : {}),
        last_message_at: parsed.data.message.sent_at,
      }));
      continue;
    }

    if (event.type === "subagent.completed") {
      const parsed = SubagentCompletedDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidSubagentPayload(event);
      finishSubagent(items, parsed.data.link, event, {
        status: "completed",
        result: parsed.data.result,
        childTerminalEventId: parsed.data.child_terminal_event_id,
        childTerminalEventHash: parsed.data.child_terminal_event_hash,
      }, expectedRunId, expectedSessionId);
      continue;
    }

    if (event.type === "subagent.failed") {
      const parsed = SubagentFailedDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidSubagentPayload(event);
      finishSubagent(items, parsed.data.link, event, {
        status: parsed.data.result.status,
        result: parsed.data.result,
        failureReason: parsed.data.reason,
        allowMissingInitialTask: parsed.data.failure_stage === "launch",
        ...(parsed.data.child_terminal_event_id === undefined
          ? {}
          : { childTerminalEventId: parsed.data.child_terminal_event_id }),
        ...(parsed.data.child_terminal_event_hash === undefined
          ? {}
          : { childTerminalEventHash: parsed.data.child_terminal_event_hash }),
      }, expectedRunId, expectedSessionId);
      continue;
    }

    if (event.type === "subagent.interrupted") {
      const parsed = SubagentInterruptedDataSchema.safeParse(event.data);
      if (!parsed.success) throw invalidSubagentPayload(event);
      finishSubagent(items, parsed.data.link, event, {
        status: "interrupted",
        result: parsed.data.result,
        failureReason: parsed.data.reason,
        childTerminalEventId: parsed.data.child_terminal_event_id,
        childTerminalEventHash: parsed.data.child_terminal_event_hash,
      }, expectedRunId, expectedSessionId);
      continue;
    }

    if (
      event.type === "run.completed"
      || event.type === "run.failed"
      || event.type === "run.cancelled"
    ) {
      const active = [...items.values()].filter(({ status }) => status === "running");
      if (active.length > 0) {
        throw new ProjectionError(`parent Run terminated with ${active.length} active subagent(s)`);
      }
      parentTerminalSeen = true;
    }
  }

  const projectedItems = [...items.values()];
  return SubagentListProjectionSchema.parse({
    items: projectedItems,
    active_count: projectedItems.filter(({ status }) => status === "running").length,
    last_sequence: events.at(-1)?.sequence ?? 0,
    limits,
  });
}

function finishSubagent(
  items: Map<string, SubagentProjectionItem>,
  link: SubagentRunLink,
  event: SessionEvent,
  terminal: {
    status: "completed" | "failed" | "interrupted" | "budget_exceeded";
    result: NonNullable<SubagentProjectionItem["result"]>;
    failureReason?: string;
    allowMissingInitialTask?: boolean;
    childTerminalEventId?: string;
    childTerminalEventHash?: string;
  },
  expectedRunId: string | undefined,
  expectedSessionId: string | undefined,
): void {
  assertParentEventScope(event, link, expectedRunId, expectedSessionId);
  const current = requireRunningSubagent(items, link, event);
  if (
    !terminal.allowMissingInitialTask
    && (current.initial_message_event_id === undefined || current.message_count === 0)
  ) {
    throw new ProjectionError(`subagent terminal event is missing its initial task at sequence ${event.sequence}`);
  }
  items.set(current.link.subagent_id, SubagentProjectionItemSchema.parse({
    ...current,
    status: terminal.status,
    terminal_event_id: event.event_id,
    ...(terminal.failureReason === undefined ? {} : { failure_reason: terminal.failureReason }),
    ...(terminal.childTerminalEventId === undefined
      ? {}
      : { child_terminal_event_id: terminal.childTerminalEventId }),
    ...(terminal.childTerminalEventHash === undefined
      ? {}
      : { child_terminal_event_hash: terminal.childTerminalEventHash }),
    finished_at: event.occurred_at,
    result: {
      ...terminal.result,
      summary: redactSensitiveText(terminal.result.summary),
    },
  }));
}

function requireRunningSubagent(
  items: ReadonlyMap<string, SubagentProjectionItem>,
  link: SubagentRunLink,
  event: SessionEvent,
): SubagentProjectionItem {
  const current = items.get(link.subagent_id);
  if (current === undefined) {
    throw new ProjectionError(`${event.type} references unknown subagent_id ${link.subagent_id}`);
  }
  if (!sameSubagentLink(current.link, link)) {
    throw new ProjectionError(`${event.type} changes subagent Run linkage at sequence ${event.sequence}`);
  }
  if (current.status !== "running") {
    throw new ProjectionError(`${event.type} follows subagent terminal state at sequence ${event.sequence}`);
  }
  return current;
}

function assertParentEventScope(
  event: SessionEvent,
  link: SubagentRunLink,
  expectedRunId: string | undefined,
  expectedSessionId: string | undefined,
): void {
  if (
    event.run_id !== expectedRunId
    || link.parent_run_id !== event.run_id
    || event.session_id !== expectedSessionId
    || link.parent_session_id !== event.session_id
  ) {
    throw new ProjectionError(`subagent parent scope mismatch at sequence ${event.sequence}`);
  }
}

function sameSubagentLink(left: SubagentRunLink, right: SubagentRunLink): boolean {
  return left.subagent_id === right.subagent_id
    && left.parent_run_id === right.parent_run_id
    && left.parent_session_id === right.parent_session_id
    && left.child_run_id === right.child_run_id
    && left.child_session_id === right.child_session_id;
}

function sameSubagentLimits(
  left: { max_parallel_subagents: number; max_depth: number },
  right: { max_parallel_subagents: number; max_depth: number },
): boolean {
  return left.max_parallel_subagents === right.max_parallel_subagents
    && left.max_depth === right.max_depth;
}

function invalidSubagentPayload(event: SessionEvent): ProjectionError {
  return new ProjectionError(`invalid ${event.type} payload at sequence ${event.sequence}`);
}

/** Rebuild the durable steering mailbox without trusting arbitrary event.data.
 * New G-14 events fail closed; ledgers that predate G-14 have no such events
 * and naturally return the empty queue. */
function projectInputQueue(events: readonly SessionEvent[]): InputQueueProjection {
  const expectedRunId = events[0]?.run_id;
  const inputs = new Map<string, {
    input: PendingUserInput;
    inputDigest?: string;
    queuedEventIds: Set<string>;
    consumed: boolean;
  }>();
  const pending = new Map<string, PendingUserInput>();
  let lastConsumed: InputQueueProjection["last_consumed"];

  for (const event of events) {
    if (event.type === "user.input_queued") {
      if (event.run_id !== expectedRunId) {
        throw new ProjectionError(`user.input_queued ledger scope mismatch at sequence ${event.sequence}`);
      }
      const parsed = UserInputQueuedDataSchema.safeParse(event.data);
      if (!parsed.success) {
        throw new ProjectionError(`invalid user.input_queued payload at sequence ${event.sequence}`);
      }
      if (parsed.data.input.run_id !== event.run_id) {
        throw new ProjectionError(`user.input_queued run scope mismatch at sequence ${event.sequence}`);
      }

      const existing = inputs.get(parsed.data.input.input_id);
      if (existing !== undefined) {
        const bothHaveRawDigest = existing.inputDigest !== undefined
          && parsed.data._internal_input_digest !== undefined;
        if (
          !sameCanonicalInputIdentity(existing.input, parsed.data.input)
          || (bothHaveRawDigest
            ? existing.inputDigest !== parsed.data._internal_input_digest
            : existing.input.body !== parsed.data.input.body)
        ) {
          throw new ProjectionError(`conflicting duplicate input_id ${parsed.data.input.input_id}`);
        }
        existing.queuedEventIds.add(event.event_id);
        continue;
      }
      if (pending.size >= MAX_PENDING_USER_INPUTS) {
        throw new ProjectionError(`pending user input queue exceeds ${MAX_PENDING_USER_INPUTS} items`);
      }
      inputs.set(parsed.data.input.input_id, {
        input: parsed.data.input,
        ...(parsed.data._internal_input_digest === undefined
          ? {}
          : { inputDigest: parsed.data._internal_input_digest }),
        queuedEventIds: new Set([event.event_id]),
        consumed: false,
      });
      pending.set(parsed.data.input.input_id, parsed.data.input);
      continue;
    }

    if (event.type === "user.input_consumed") {
      if (event.run_id !== expectedRunId) {
        throw new ProjectionError(`user.input_consumed ledger scope mismatch at sequence ${event.sequence}`);
      }
      const parsed = UserInputConsumedDataSchema.safeParse(event.data);
      if (!parsed.success) {
        throw new ProjectionError(`invalid user.input_consumed payload at sequence ${event.sequence}`);
      }
      const queued = inputs.get(parsed.data.input_id);
      if (queued === undefined || queued.consumed) {
        throw new ProjectionError(`user.input_consumed references unknown or consumed input_id ${parsed.data.input_id}`);
      }
      const nextPendingInputId = pending.keys().next().value as string | undefined;
      // Ordinary steering is FIFO. Cancellation is the sole control-lane
      // exception: it may preempt older messages so the reserved emergency
      // slot remains useful while those messages stay truthfully pending.
      if (queued.input.kind !== "cancel" && nextPendingInputId !== parsed.data.input_id) {
        throw new ProjectionError(`user.input_consumed violates FIFO order for ${parsed.data.input_id}`);
      }
      if (queued.input.kind !== parsed.data.kind) {
        throw new ProjectionError(`user.input_consumed kind mismatch for ${parsed.data.input_id}`);
      }
      if (!queued.queuedEventIds.has(parsed.data.queued_event_id)) {
        throw new ProjectionError(`user.input_consumed queued_event_id mismatch for ${parsed.data.input_id}`);
      }
      if (Date.parse(parsed.data.consumed_at) < Date.parse(queued.input.submitted_at)) {
        throw new ProjectionError(`user.input_consumed predates submission for ${parsed.data.input_id}`);
      }
      if (lastConsumed !== undefined && parsed.data.at_step <= lastConsumed.at_step) {
        throw new ProjectionError("user.input_consumed at_step must increase monotonically");
      }
      queued.consumed = true;
      pending.delete(parsed.data.input_id);
      lastConsumed = parsed.data;
    }
  }

  return {
    pending: [...pending.values()].map((input) => ({
      ...input,
      // Registering a secret after the Event was written can expand its
      // replacement text. Keep dynamic redaction inside the public contract
      // bound so a newly-known secret cannot make projection replay fail.
      body: redactSensitiveText(input.body).slice(0, MAX_USER_INPUT_BODY_CHARS),
    })),
    ...(lastConsumed === undefined ? {} : { last_consumed: lastConsumed }),
  };
}

function sameCanonicalInputIdentity(left: PendingUserInput, right: PendingUserInput): boolean {
  return left.input_id === right.input_id
    && left.run_id === right.run_id
    && left.kind === right.kind
    && left.actor === right.actor
    && left.submitted_at === right.submitted_at;
}

export function toWireEvent(event: SessionEvent): WireSessionEvent {
  return WireSessionEventSchema.parse({
    schema_version: event.schema_version,
    event_id: event.event_id,
    project_id: event.project_id,
    run_id: event.run_id,
    ...(event.session_id === undefined ? {} : { session_id: event.session_id }),
    sequence: event.sequence,
    occurred_at: event.occurred_at,
    type: event.type,
    summary: redactSensitiveText(event.summary),
    artifact_refs: event.artifact_refs,
    ...(event.turn_id === undefined ? {} : { turn_id: event.turn_id }),
    ...(event.operation_id === undefined ? {} : { operation_id: event.operation_id }),
    ...(event.parent_event_id === undefined ? {} : { parent_event_id: event.parent_event_id }),
    ...(event.caused_by_event_id === undefined ? {} : { caused_by_event_id: event.caused_by_event_id }),
    ...(event.context_manifest_ref === undefined ? {} : { context_manifest_ref: event.context_manifest_ref }),
    ...(event.model_call_id === undefined ? {} : { model_call_id: event.model_call_id }),
    ...(event.action_id === undefined ? {} : { action_id: event.action_id }),
    ...(event.patch_event_id === undefined ? {} : { patch_event_id: event.patch_event_id }),
    ...(event.graph_delta_id === undefined ? {} : { graph_delta_id: event.graph_delta_id }),
    ...(event.test_receipt_id === undefined ? {} : { test_receipt_id: event.test_receipt_id }),
    data: redactStructuredValue(publicEventData(event.data)) as Record<string, unknown>,
  });
}

function publicEventData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !key.startsWith("_internal_")),
  );
}

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}
