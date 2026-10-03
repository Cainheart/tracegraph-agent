import {
  RunProjectionSchema,
  SessionDeleteResponseSchema,
  IdentifierSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionReadResultSchema,
  SessionRecoveryReportSchema,
  SessionRenameRequestSchema,
  SessionResumeResponseSchema,
  SessionResumeRequestSchema,
  StartChatRequestSchema,
  StartRunInputSchema,
  StartRunRequestSchema,
  type RunProjection,
  type SessionDeleteResponse,
  type SessionListQuery,
  type SessionListResponse,
  type SessionReadResult,
  type SessionRecoveryReport,
  type SessionRenameRequest,
  type SessionResumeResponse,
  type WorkspaceHandle,
  type StartChatRequest,
  type StartRunRequest,
} from "@tracegraph/contracts";

/** Trusted composition dispatch still passes registration, admission and lease checks. */
export interface TrustedRunDispatch {
  readonly identity: string;
  release?():void;
  start(input: ReturnType<typeof StartRunInputSchema.parse>): Promise<RunProjection>;
}

export interface RunSessionRuntimePort {
  startRun(input: ReturnType<typeof StartRunInputSchema.parse>): Promise<RunProjection>;
  getProjection(runId: string): Promise<RunProjection>;
}

export interface RunSessionStorePort {
  recover(): Promise<SessionRecoveryReport>;
  list(query: SessionListQuery, scope: { projectIds: readonly string[] }): Promise<SessionListResponse>;
  read(sessionId: string): Promise<SessionReadResult>;
  rename(sessionId: string, input: SessionRenameRequest): Promise<SessionReadResult>;
  delete(sessionId: string): Promise<SessionDeleteResponse>;
  resume(input: {
    sessionId: string;
    commandId: string;
    workspace: WorkspaceHandle;
  }): Promise<SessionResumeResponse>;
}

export interface RunSessionControllerOptions {
  runtime: RunSessionRuntimePort;
  /** Legacy embedding defaults to one Run; unified Host coordinates canonical workspaces. */
  admission?: "single" | "workspace";
  prepareDispatch?(input:StartRunRequest,workspace:WorkspaceHandle):Promise<TrustedRunDispatch>;
  getDefaultReasoningEffort?():StartRunRequest["reasoning_effort"];
  beforeStart?(input:{workspace:WorkspaceHandle;commandId:string;sessionId?:string}):Promise<{release():void}>;
  /** Host authority may reject historical policy before any durable resume mutation. */
  beforeResume?(input:{workspace:WorkspaceHandle;session:SessionReadResult}):Promise<void>;
  onStarted?(projection:RunProjection,lease:{release():void}):void;
  /** Resolve current Host registrations on each operation; removed projects disappear immediately. */
  getWorkspace(projectId: string): WorkspaceHandle | undefined;
  getProjectIds(): readonly string[];
  getChatWorkspace?(): WorkspaceHandle | undefined;
  sessions?: RunSessionStorePort;
}

export class RunSessionControllerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RunSessionControllerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Application controller for the Run/Session client slice. It is independent
 * of HTTP and keeps only process-local command and active-Run coordination.
 */
export class RunSessionController {
  readonly #runtime: RunSessionRuntimePort;
  readonly #getWorkspace: RunSessionControllerOptions["getWorkspace"];
  readonly #getProjectIds: RunSessionControllerOptions["getProjectIds"];
  readonly #getChatWorkspace: NonNullable<RunSessionControllerOptions["getChatWorkspace"]>;
  readonly #sessions: RunSessionStorePort | undefined;
  readonly #startCommands = new Map<string, { runId: string; fingerprint: string }>();
  readonly #resumeCommands = new Map<string, { sessionId: string; result: SessionResumeResponse }>();
  readonly #admission: "single" | "workspace";
  readonly #getDefaultReasoningEffort:RunSessionControllerOptions["getDefaultReasoningEffort"];
  readonly #prepareDispatch:RunSessionControllerOptions["prepareDispatch"];
  readonly #beforeStart: RunSessionControllerOptions["beforeStart"];
  readonly #beforeResume: RunSessionControllerOptions["beforeResume"];
  readonly #onStarted: RunSessionControllerOptions["onStarted"];
  readonly #pendingResumes=new Map<string,{sessionId:string,result:Promise<SessionResumeResponse>}>();
  readonly #pendingCommands=new Map<string,{fingerprint:string,result:Promise<RunProjection>}>();
  readonly #activeRuns = new Map<string, RunProjection>();
  #runQueue: Promise<void> = Promise.resolve();

  constructor(options: RunSessionControllerOptions) {
    this.#runtime = options.runtime;
    this.#admission = options.admission ?? "single";
    this.#prepareDispatch=options.prepareDispatch;
    this.#getDefaultReasoningEffort=options.getDefaultReasoningEffort;
    this.#beforeStart=options.beforeStart;this.#beforeResume=options.beforeResume;this.#onStarted=options.onStarted;
    this.#getWorkspace = options.getWorkspace;
    this.#getProjectIds = options.getProjectIds;
    this.#getChatWorkspace = options.getChatWorkspace ?? (() => undefined);
    this.#sessions = options.sessions;
  }

  withSerializedRunOperation<T>(operation: () => Promise<T>): Promise<T> {
    if(this.#admission === "workspace") return operation();
    const result = this.#runQueue.then(operation, operation);
    this.#runQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  startRun(inputValue: StartRunRequest, trusted?: TrustedRunDispatch): Promise<RunProjection> {
    const input=StartRunRequestSchema.parse(inputValue);
    const fingerprint=startRequestFingerprint(input,trusted?.identity);
    const pending=this.#pendingCommands.get(input.command_id);
    if(pending) {if(pending.fingerprint!==fingerprint) return Promise.reject(new RunSessionControllerError(409,"command_id_conflict","Command id was already used with a different request"));return pending.result;}
    const previous=this.#startCommands.get(input.command_id);
    if(previous){if(previous.fingerprint!==fingerprint)return Promise.reject(new RunSessionControllerError(409,"command_id_conflict","Command id was already used with a different request"));return this.getRun(previous.runId);}
    const workspace=this.#getWorkspace(input.project_id);
    const prepared=trusted?Promise.resolve(trusted):workspace?this.#prepareDispatch?.(input,workspace):undefined;
    void prepared?.catch(()=>undefined);
    const result=this.withSerializedRunOperation(async()=>{const dispatch=await prepared;try{return await this.#startRegisteredRun(input,dispatch,fingerprint);}catch(error){dispatch?.release?.();throw error;}});
    this.#pendingCommands.set(input.command_id,{fingerprint,result});
    void result.finally(()=>this.#pendingCommands.delete(input.command_id)).catch(()=>undefined);
    return result;
  }

  async startChat(inputValue: StartChatRequest): Promise<RunProjection> {
      const chatWorkspace = this.#getChatWorkspace();
      if (chatWorkspace === undefined) {
        throw new RunSessionControllerError(501, "plain_chat_unavailable", "This Host has no isolated chat workspace");
      }
      const chatInput = StartChatRequestSchema.parse(inputValue);
      const request = StartRunRequestSchema.parse({
        ...chatInput,
        project_id: chatWorkspace.project_id,
        mode: chatInput.mode ?? chatInput.run_options?.mode ?? "execute",
      });
      return this.startRun(request);
  }

  async getRun(runId: string): Promise<RunProjection> {
    const projection = RunProjectionSchema.parse(await this.#runtime.getProjection(runId));
    this.#assertRegisteredProject(projection.project_id);
    this.#observeRun(projection);
    return projection;
  }

  async listSessions(queryValue: unknown): Promise<SessionListResponse> {
    const sessions = this.#requireSessions();
    const query = SessionListQuerySchema.parse(queryValue);
    const projectIds = this.#getProjectIds();
    const registered = new Set(projectIds);
    if (query.project_id !== undefined) this.#assertRegisteredProject(query.project_id);
    const result = SessionListResponseSchema.parse(await sessions.list(query, { projectIds }));
    if (result.sessions.some((session) => !registered.has(session.project_id))) {
      throw new Error("Session controller returned a session outside the Host project scope");
    }
    return result;
  }

  async getSession(sessionId: string): Promise<SessionReadResult> {
    const parsedSessionId = IdentifierSchema.parse(sessionId);
    const result = SessionReadResultSchema.parse(await this.#requireSessions().read(parsedSessionId));
    if (result.header.session_id !== parsedSessionId) {
      throw new Error("Session controller returned a different session");
    }
    this.#assertRegisteredProject(result.header.project_id);
    return result;
  }

  async renameSession(sessionId: string, inputValue: SessionRenameRequest): Promise<SessionReadResult> {
    const session = await this.getSession(sessionId);
    const input = SessionRenameRequestSchema.parse(inputValue);
    const result = SessionReadResultSchema.parse(await this.#requireSessions().rename(session.header.session_id, input));
    if (result.header.session_id !== session.header.session_id || result.header.project_id !== session.header.project_id) {
      throw new Error("Session controller returned a rename result with mismatched identity");
    }
    return result;
  }

  deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    return this.withSerializedRunOperation(async () => {
      const session = await this.getSession(sessionId);
      const active = await this.getActiveRunProjections();
      if (active.some((run) => session.header.run_ids.includes(run.run_id))) {
        throw new RunSessionControllerError(409, "active_session_conflict", "Stop the active Run before deleting its Session");
      }
      const result = SessionDeleteResponseSchema.parse(await this.#requireSessions().delete(session.header.session_id));
      if (result.session_id !== session.header.session_id) throw new Error("Session controller returned a delete result with mismatched identity");
      return result;
    });
  }

  resumeSession(sessionId:string,inputValue:{command_id:string}):Promise<SessionResumeResponse> {
    const id=IdentifierSchema.parse(sessionId);const input=SessionResumeRequestSchema.parse(inputValue);
    const existing=this.#pendingResumes.get(input.command_id);if(existing){if(existing.sessionId!==id)return Promise.reject(new RunSessionControllerError(409,"command_id_conflict","Resume command id was already used for another Session"));return existing.result;}
    const result=this.#resumeSessionNow(id,input);this.#pendingResumes.set(input.command_id,{sessionId:id,result});void result.finally(()=>this.#pendingResumes.delete(input.command_id)).catch(()=>undefined);return result;
  }

  async #resumeSessionNow(sessionId: string, inputValue: { command_id: string }): Promise<SessionResumeResponse> {
    return this.withSerializedRunOperation(async () => {
      const parsedSessionId = IdentifierSchema.parse(sessionId);
      const input = SessionResumeRequestSchema.parse(inputValue);
      const session = await this.getSession(parsedSessionId);
      const previous = this.#resumeCommands.get(input.command_id);
      if (previous !== undefined) {
        if (previous.sessionId !== parsedSessionId) {
          throw new RunSessionControllerError(409, "command_id_conflict", "Resume command id was already used for another Session");
        }
        return previous.result;
      }
      const workspace = this.#getWorkspace(session.header.project_id);
      if (workspace === undefined) {
        throw new RunSessionControllerError(404, "session_project_unavailable", "Session is unavailable outside a registered project");
      }
      const lease=await this.#beforeStart?.({workspace,commandId:input.command_id,sessionId:parsedSessionId});
      try {
      await this.assertRunAdmission(session.header.project_id, parsedSessionId);
      await this.#beforeResume?.({workspace,session});
      const result = SessionResumeResponseSchema.parse(await this.#requireSessions().resume({
        sessionId: parsedSessionId,
        commandId: input.command_id,
        workspace,
      }));
      if (
        result.session_id !== parsedSessionId
        || result.project_id !== session.header.project_id
        || !session.header.run_ids.includes(result.run_id)
      ) {
        throw new Error("Session controller returned a resume result with mismatched identity");
      }
      const resumed = RunProjectionSchema.parse(await this.#runtime.getProjection(result.run_id));
      this.activateRunProjection(resumed);
      if(lease){if(isTerminalStatus(resumed.status))lease.release();else this.#onStarted?.(resumed,lease);}
      this.#resumeCommands.set(input.command_id, { sessionId: parsedSessionId, result });
      return result;
      }catch(error){lease?.release();throw error;}
    });
  }

  async getActiveRunProjections(): Promise<RunProjection[]> {
    const projections: RunProjection[] = [];
    for (const runId of [...this.#activeRuns.keys()]) {
      const projection = RunProjectionSchema.parse(await this.#runtime.getProjection(runId));
      this.#assertRegisteredProject(projection.project_id);
      this.#observeRun(projection);
      if (!isTerminalStatus(projection.status)) projections.push(projection);
    }
    return projections;
  }
  async getActiveRunProjection(): Promise<RunProjection | undefined> { return (await this.getActiveRunProjections())[0]; }
  async assertRunAdmission(projectId: string, sessionId?: string, exceptRunId?: string): Promise<void> {
    const workspace = this.#getWorkspace(projectId);
    if (!workspace) throw new RunSessionControllerError(404,"project_not_registered","Project is not registered");
    for (const active of await this.getActiveRunProjections()) {
      if (active.run_id === exceptRunId) continue;
      if (this.#admission === "single") throw new RunSessionControllerError(409,"active_run_conflict","This Host permits one active Run");
      if (sessionId !== undefined && active.session_id === sessionId) throw new RunSessionControllerError(409,"active_session_conflict","The Session already has an active Run");
      const other = this.#getWorkspace(active.project_id);
      if (other?.real_root === workspace.real_root && (workspace.capabilities.commit_patch || workspace.capabilities.run_command || workspace.capabilities.test || other.capabilities.commit_patch || other.capabilities.run_command || other.capabilities.test)) {
        throw new RunSessionControllerError(409,"workspace_write_conflict","A Run already owns this canonical workspace");
      }
    }
  }
  observeRunProjection(projectionValue: RunProjection): void { this.#observeRun(RunProjectionSchema.parse(projectionValue)); }
  activateRunProjection(projectionValue: RunProjection): void {
    const projection = RunProjectionSchema.parse(projectionValue);
    if (isTerminalStatus(projection.status)) this.#activeRuns.delete(projection.run_id);
    else this.#activeRuns.set(projection.run_id,projection);
  }

  async #startRegisteredRun(input: StartRunRequest, trusted?: TrustedRunDispatch, fingerprint=startRequestFingerprint(input,trusted?.identity)): Promise<RunProjection> {
    const previous = this.#startCommands.get(input.command_id);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        throw new RunSessionControllerError(409, "command_id_conflict", "Command id was already used with a different request");
      }
      return this.getRun(previous.runId);
    }

    const workspace = this.#getWorkspace(input.project_id);
    if (workspace === undefined) {
      throw new RunSessionControllerError(404, "project_not_registered", "Project is not registered by this Host");
    }
    if (input.session_id !== undefined) {
      const existingSession = await this.getSession(input.session_id);
      if (existingSession.header.project_id !== input.project_id) {
        throw new RunSessionControllerError(409, "session_project_mismatch", "Session belongs to another project");
      }
    }
    const lease=await this.#beforeStart?.({workspace,commandId:input.command_id,...(input.session_id===undefined?{}:{sessionId:input.session_id})});
    try {
    await this.assertRunAdmission(input.project_id,input.session_id);
    const runInput = StartRunInputSchema.parse({ ...input, workspace,reasoning_effort:input.reasoning_effort ?? this.#getDefaultReasoningEffort?.() ?? "default" });
    const projection = RunProjectionSchema.parse(await (trusted ? trusted.start(runInput) : this.#runtime.startRun(runInput)));
    if (projection.project_id !== input.project_id) {
      throw new Error("Runtime returned a Run outside the requested project");
    }
    this.#startCommands.set(input.command_id, { runId: projection.run_id, fingerprint });
    this.activateRunProjection(projection);
    if(lease){if(isTerminalStatus(projection.status))lease.release();else this.#onStarted?.(projection,lease);}
    return projection;
    } catch(error){lease?.release();throw error;}
  }

  #requireSessions(): RunSessionStorePort {
    if (this.#sessions === undefined) {
      throw new RunSessionControllerError(501, "session_store_unavailable", "This Host has no durable session store");
    }
    return this.#sessions;
  }

  #assertRegisteredProject(projectId: string): void {
    if (!this.#getProjectIds().includes(projectId)) {
      throw new RunSessionControllerError(404, "project_not_registered", "Run is unavailable outside a registered project");
    }
  }

  #observeRun(projection: RunProjection): void {
    if (isTerminalStatus(projection.status)) this.#activeRuns.delete(projection.run_id);
    else if (this.#activeRuns.has(projection.run_id)) this.#activeRuns.set(projection.run_id,projection);
  }
}

export type HostSessionController = RunSessionStorePort;
export type HostSessionScope = { readonly projectIds: readonly string[] };

function startRequestFingerprint(input: StartRunRequest, trustedIdentity?: string): string {
  return JSON.stringify([
    input.project_id,
    input.session_id ?? null,
    input.task,
    input.mode,
    input.reasoning_effort ?? null,
    input.conversation_history ?? [],
    input.attachment_upload_ids ?? [],
    input.file_contexts ?? [],
    trustedIdentity ?? null,
  ]);
}

function isTerminalStatus(status: RunProjection["status"]): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted"
    || status === "needs_manual_review";
}
