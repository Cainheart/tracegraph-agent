import {
  SessionDeleteResponseSchema,
  SessionListQuerySchema,
  SessionRecoveryReportSchema,
  SessionRenameRequestSchema,
  SessionResumeResponseSchema,
  type SessionDeleteResponse,
  type SessionListQuery,
  type SessionListResponse,
  type SessionReadResult,
  type SessionRecoveryReport,
  type SessionRenameRequest,
  type SessionResumeResponse,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { defaultIdFactory, redactSensitiveText, sha256 } from "./crypto.js";
import type { AgentRuntime } from "./runtime.js";
import {
  SessionCorruptionError,
  type SessionLease,
  type SessionStore,
} from "./session-store.js";

export interface DurableSessionControllerOptions {
  store: SessionStore;
  runtime: AgentRuntime;
  /** Resolve only Host-registered capabilities; persisted paths are never trusted. */
  workspaceResolver?: (
    projectId: string,
  ) => WorkspaceHandle | undefined | Promise<WorkspaceHandle | undefined>;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
}

/**
 * Composition-level session orchestration. The JSONL file is a searchable
 * index containing event references only; lifecycle facts and Run state remain
 * in the canonical event ledger owned by AgentRuntime.
 */
export class DurableSessionController {
  readonly #store: SessionStore;
  readonly #runtime: AgentRuntime;
  readonly #workspaceResolver: DurableSessionControllerOptions["workspaceResolver"];
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;

  constructor(options: DurableSessionControllerOptions) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#workspaceResolver = options.workspaceResolver;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
  }

  async recover(): Promise<SessionRecoveryReport> {
    await this.#store.initialize();
    // Take a stable summary snapshot before repair mutates update timestamps;
    // otherwise cursor pagination could skip or repeat a session mid-scan.
    const summaries = await this.#listAll();
    const truncatedSessionIds: string[] = [];
    const interruptedRunIds: string[] = [];
    const reconciledActionIds = new Set<string>();
    const abortedActionIds = new Set<string>();
    const divergedActionIds = new Set<string>();

    for (const summary of summaries) {
      const detail = await this.#store.readAll(summary.session_id);
      const lastRunId = detail.header.run_ids.at(-1);
      if (lastRunId === undefined) {
        if (detail.truncated) {
          throw new SessionCorruptionError("cannot audit a truncated session with no Run reference");
        }
        continue;
      }
      if (detail.truncated) {
        await this.#runtime.recordSessionFact({
          sessionId: detail.header.session_id,
          projectId: detail.header.project_id,
          runId: lastRunId,
          type: "session.tail_truncated",
          summary: "Incomplete session JSONL tail was removed during startup recovery",
          idempotencyKey: `session-tail:${sha256(`${detail.header.session_id}:${detail.entries.length}:${detail.entries.at(-1)?.entry_id ?? "header"}`)}`,
          data: { retained_entry_count: detail.entries.length },
        });
        truncatedSessionIds.push(detail.header.session_id);
      }

      let canonicalTitle: string | undefined;
      // A Session can contain multiple Runs. Scan every referenced Run so an
      // older nonterminal Run cannot remain silently "running" merely because
      // a later Run was appended to the same Session.
      for (const runId of detail.header.run_ids) {
        const workspace = await this.#workspaceResolver?.(detail.header.project_id);
        if (workspace !== undefined) {
          const actionRecovery = await this.#runtime.reconcileActions({
            sessionId: detail.header.session_id,
            projectId: detail.header.project_id,
            runId,
            workspace,
          });
          for (const actionId of actionRecovery.reconciledActionIds) reconciledActionIds.add(actionId);
          for (const actionId of actionRecovery.abortedActionIds) abortedActionIds.add(actionId);
          for (const actionId of actionRecovery.divergedActionIds) divergedActionIds.add(actionId);
        }
        const projection = await this.#runtime.getProjection(runId);
        if (projection.project_id !== detail.header.project_id || projection.session_id !== detail.header.session_id) {
          throw new SessionCorruptionError("session index points to a Run outside its project/session scope");
        }
        const titleEvent = [...projection.timeline]
          .reverse()
          .find((event) => event.type === "session.title_changed" && typeof event.data.title === "string");
        if (typeof titleEvent?.data.title === "string") canonicalTitle = titleEvent.data.title;
        if (!isFinishedStatus(projection.status) && projection.status !== "interrupted") {
          const interrupted = await this.#runtime.markRunInterrupted({
            sessionId: detail.header.session_id,
            projectId: detail.header.project_id,
            runId,
            reason: "host_restart",
          });
          if (interrupted.status === "interrupted") interruptedRunIds.push(runId);
        }
      }
      if (typeof canonicalTitle === "string" && canonicalTitle !== detail.header.title) {
        await this.#store.rename(detail.header.session_id, canonicalTitle);
      }
    }

    return SessionRecoveryReportSchema.parse({
      scanned_sessions: summaries.length,
      truncated_session_ids: truncatedSessionIds,
      interrupted_run_ids: interruptedRunIds,
      reconciled_action_ids: [...reconciledActionIds],
      aborted_action_ids: [...abortedActionIds],
      diverged_action_ids: [...divergedActionIds],
      recovered_at: this.#now().toISOString(),
    });
  }

  list(
    queryInput: SessionListQuery,
    scope: { projectIds: readonly string[] },
  ): Promise<SessionListResponse> {
    const query = SessionListQuerySchema.parse(queryInput);
    return this.#store.list(query, new Set(scope.projectIds));
  }

  read(sessionId: string): Promise<SessionReadResult> {
    return this.#store.readAll(sessionId);
  }

  async rename(sessionId: string, inputValue: SessionRenameRequest): Promise<SessionReadResult> {
    const input = SessionRenameRequestSchema.parse(inputValue);
    const safeTitle = redactSensitiveText(input.title);
    const lease = await this.#store.acquireLease(sessionId);
    try {
      // Re-read after acquiring the writer lease. The preliminary HTTP read is
      // only an authorization check and must not become mutation state.
      const detail = await this.#store.readAll(sessionId, lease);
      if (detail.header.title === safeTitle) return detail;
      const runId = requireLastRun(detail);
      await this.#repairTailIfNeeded(detail, lease, runId);
      await this.#runtime.recordSessionFact({
        sessionId,
        projectId: detail.header.project_id,
        runId,
        type: "session.title_changed",
        summary: "Session title changed",
        // Include the observed source title so A -> B -> A is represented by
        // three ordered facts, while a retry after "event committed, header
        // rewrite not yet completed" still resolves to the same event.
        idempotencyKey: `session-title:${sha256(`${sessionId}:${detail.header.title ?? ""}:${safeTitle}`)}`,
        data: { title: safeTitle },
      }, lease);
      await this.#store.rename(sessionId, safeTitle, lease);
      return this.#store.readAll(sessionId, lease);
    } finally {
      await lease.release();
    }
  }

  async delete(sessionId: string): Promise<SessionDeleteResponse> {
    const lease = await this.#store.acquireLease(sessionId);
    try {
      const detail = await this.#store.readAll(sessionId, lease);
      const runId = requireLastRun(detail);
      await this.#repairTailIfNeeded(detail, lease, runId);
      await this.#runtime.recordSessionFact({
        sessionId,
        projectId: detail.header.project_id,
        runId,
        type: "session.closed",
        summary: "Session moved to TraceGraph trash",
        idempotencyKey: `session-close:${sha256(sessionId)}`,
        data: { reason: "user_deleted" },
      }, lease);
      await this.#store.delete(sessionId, lease);
      return SessionDeleteResponseSchema.parse({ session_id: sessionId, deleted: true });
    } finally {
      await lease.release();
    }
  }

  async resume(input: {
    sessionId: string;
    commandId: string;
    workspace: WorkspaceHandle;
  }): Promise<SessionResumeResponse> {
    const detail = await this.#store.readAll(input.sessionId);
    const runId = requireLastRun(detail);
    if (input.workspace.project_id !== detail.header.project_id) {
      throw new SessionCorruptionError("resume WorkspaceHandle belongs to another project");
    }
    const projection = await this.#runtime.resumeRun({
      sessionId: input.sessionId,
      projectId: detail.header.project_id,
      runId,
      commandId: input.commandId,
      workspace: input.workspace,
    });
    return SessionResumeResponseSchema.parse({
      session_id: input.sessionId,
      project_id: detail.header.project_id,
      run_id: runId,
      status: projection.status === "awaiting_approval"
        ? "awaiting_approval"
        : projection.status === "awaiting_plan_approval"
          ? "awaiting_plan_approval"
          : "resumed",
      resumed_at: this.#now().toISOString(),
    });
  }

  async #repairTailIfNeeded(
    detail: SessionReadResult,
    lease: SessionLease,
    runId: string,
  ): Promise<void> {
    if (!detail.truncated) return;
    await this.#store.readAll(detail.header.session_id, lease);
    await this.#runtime.recordSessionFact({
      sessionId: detail.header.session_id,
      projectId: detail.header.project_id,
      runId,
      type: "session.tail_truncated",
      summary: "Incomplete session JSONL tail was removed before mutation",
      idempotencyKey: `session-tail:${sha256(`${detail.header.session_id}:${detail.entries.length}:${detail.entries.at(-1)?.entry_id ?? "header"}`)}`,
      data: { retained_entry_count: detail.entries.length },
    }, lease);
  }

  async #listAll(): Promise<SessionListResponse["sessions"]> {
    const all: SessionListResponse["sessions"] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#store.list({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      all.push(...page.sessions);
      cursor = page.next_cursor;
      if (all.length > 100_000) throw new SessionCorruptionError("session index exceeds recovery scan limit");
    } while (cursor !== undefined);
    return all;
  }
}

function requireLastRun(detail: SessionReadResult): string {
  const runId = detail.header.run_ids.at(-1);
  if (runId === undefined) {
    throw new SessionCorruptionError("session has no Run to receive its lifecycle event");
  }
  return runId;
}

function isFinishedStatus(status: string): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "needs_manual_review";
}
