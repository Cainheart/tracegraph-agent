import {ImageProviderConfigUpdateSchema,ImageProviderConfigSnapshotSchema,StartMediaRunRequestSchema,MediaMimeTypeSchema,MAX_GENERATED_IMAGE_BYTES,type ImageProviderConfigSnapshot,type ImageProviderConfigUpdate} from "@tracegraph/contracts";
import {createMediaInstructionAdapter,createMediaTaskTitle} from "@tracegraph/core";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import {
  MemoryExperienceController,
  RunSessionController,
  RunSessionControllerError,
  type HostSessionController,
} from "@tracegraph/api";
import {
  ApprovalCommandSchema,
  ApprovePlanCommandSchema,
  ApprovePlanRequestSchema,
  AttachmentStageReceiptSchema,
  AttachmentUploadRequestSchema,
  ArtifactWireResponseSchema,
  ExtensionCommandInvocationSchema,
  ExtensionCommandResultSchema,
  ExtensionReloadCommandSchema,
  ExtensionStatusSchema,
  IdentifierSchema,
  OpenLocalProjectRequestSchema,
  ProjectSummarySchema,
  RemoveProjectRequestSchema,
  ReplayDiffQuerySchema,
  ReplayDiffSchema,
  ReplaySessionResponseSchema,
  ReplaySnapshotRequestSchema,
  ReplaySnapshotSchema,
  RevealProjectRequestSchema,
  RollbackActionInputSchema,
  RollbackActionRequestSchema,
  RunProjectionSchema,
  StartChatRequestSchema,
  StartRunRequestSchema,
  StopRunCommandSchema,
  SubmitUserInputCommandSchema,
  SubmitUserInputRequestSchema,
  SubmitUserInputResultSchema,
  CreateTeamRequestSchema,
  TeamHeartbeatRequestSchema,
  TeamMailboxClaimRequestSchema,
  TeamMailboxSendRequestSchema,
  TeamMutationResultSchema,
  TeamProjectionSchema,
  TeamReadResponseSchema,
  TeamSweepLostMembersRequestSchema,
  TeamTaskWriteRequestSchema,
  TelemetryStatusSchema,
  TodoListSchema,
  TodoMutationResultSchema,
  TodoWriteRequestSchema,
  UsageSnapshotSchema,
  ExperienceLifecycleReviewRequestSchema,
  MemoryCandidateCreateRequestSchema,
  MemoryCorrectionRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryReviewRequestSchema,
  MemoryRevokeRequestSchema,
  LivePublicActivitySchema,
  MCP_SERVER_NAME_SCHEMA,
  ModelSurfaceEventSchema,
  ModelConfigUpdateRequestSchema,
  McpRestartRequestSchema,
  McpServerStatusSchema,
  McpStatusSnapshotSchema,
  LspStatusSnapshotSchema,
  PermissionPresetUpdateRequestSchema,
  PermissionSettingsResponseSchema,
  PublicModelConfigResponseSchema,
  SessionDeleteResponseSchema,
  SessionReadResultSchema,
  SessionRecoveryReportSchema,
  SessionRenameRequestSchema,
  SessionResumeRequestSchema,
  SkillProjectInspectionSchema,
  WireSessionEventSchema,
  type LivePublicActivity,
  type AttachmentUploadRequest,
  type ExtensionCommandInvocation,
  type ExtensionCommandResult,
  type ExtensionReloadCommand,
  type ExtensionStatus,
  type ModelSurfaceEvent,
  type ModelConfigUpdateRequest,
  type McpRestartRequest,
  type McpServerStatus,
  type McpStatusSnapshot,
  type LspStatusSnapshot,
  type PublicModelConfigResponse,
  type PermissionPresetUpdateRequest,
  type PermissionSettingsResponse,
  type SessionEvent,
  type SessionReadResult,
  type SessionRenameRequest,
  type WireSessionEvent,
  type SkillProjectInspection,
  type ProjectLocation,
  type ProjectSummary,
  type ReplaySnapshot,
  type RunProjection,
  type TelemetryStatus,
  type TeamMutationResult,
  type TeamProjection,
  type UsageSnapshot,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import {
  ReplayError,
  RuntimeCommandError,
  TodoDomainError,
  redactSecrets,
  redactSensitiveText,
  redactStructuredArtifactValue,
  toWireEvent,
  type AgentRuntime,
} from "@tracegraph/core";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z, ZodError } from "zod";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:4310",
  "http://localhost:4310",
] as const;
// StartRun is the only wire command allowed to carry the contract-bounded
// conversation window (160 × 8,000 characters). Keep every other route on
// Fastify's much smaller global ceiling.
const MAX_RUN_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
// The product limit is 30 MiB. Leave a small transport-only margin so Core can
// durably stage a business-level `too_large` rejection for the next Run,
// while still bounding unauthenticated parser work and memory use.
const MAX_ATTACHMENT_TRANSPORT_BYTES = 31 * 1024 * 1024;
const ATTACHMENT_CONTENT_TYPE = "application/octet-stream";

export interface TraceGraphHostOptions {
  runtime: AgentRuntime;
  /** Only authenticated sockets of the private local transport may bypass loopback address checks. */
  isPrivateLocalRequest?: (request: FastifyRequest) => boolean;
  mutationLifecycle?: { enter():void; leave():void };
  admission?: "single" | "workspace";
  prepareRunDispatch?(input:import("@tracegraph/contracts").StartRunRequest,workspace:WorkspaceHandle):Promise<import("@tracegraph/api").TrustedRunDispatch>;
  getDefaultReasoningEffort?:import("@tracegraph/api").RunSessionControllerOptions["getDefaultReasoningEffort"];
  beforeRunStart?: import("@tracegraph/api").RunSessionControllerOptions["beforeStart"];
  beforeSessionResume?: import("@tracegraph/api").RunSessionControllerOptions["beforeResume"];
  beforeRunApproval?(projection:RunProjection):Promise<void>;
  onRunStarted?: import("@tracegraph/api").RunSessionControllerOptions["onStarted"];
  withWorkspaceWrite?<T>(workspace:WorkspaceHandle,commandId:string,operation:()=>Promise<T>):Promise<T>;
  projects: readonly RegisteredProject[];
  allowedOrigins?: readonly string[];
  capabilityToken?: string;
  tokenTtlMs?: number;
  /** Short-lived, Host-owned authority used while inspecting historical state. */
  replayTokenTtlMs?: number;
  /** Process-local bound preventing an authenticated client from minting tokens forever. */
  maxReplayCapabilities?: number;
  now?: () => Date;
  logger?: boolean;
  /** Test/embedding seam; every emitted line still passes the redaction hook. */
  loggerStream?: { write(message: string): void };
  projectFactory?: (input: { name: string; template: "typescript" }) => Promise<RegisteredProject>;
  localProjectSelector?: (input: { access: "read_write" | "read_only" }) => Promise<RegisteredProject | undefined>;
  /** Remove a Host-selected local directory from the persistent registry. */
  localProjectRemover?: (project: RegisteredProject) => Promise<void>;
  /** Remove a Host-managed project. The composition root decides whether this
   * means deleting or archiving its private managed workspace. */
  projectRemover?: (project: RegisteredProject) => Promise<void>;
  projectRevealer?: (project: RegisteredProject) => Promise<void>;
  chatProject?: RegisteredProject;
  imageSettings?: {get():Promise<ImageProviderConfigSnapshot>;configure(input:ImageProviderConfigUpdate):Promise<ImageProviderConfigSnapshot>;clear():Promise<ImageProviderConfigSnapshot>};
  modelSettings?: {
    get(): PublicModelConfigResponse | Promise<PublicModelConfigResponse>;
    configure(input: {
      provider: ModelConfigUpdateRequest["provider"];
      protocol: ModelConfigUpdateRequest["protocol"];
      baseUrl: string;
      model: string;
      apiKey?: string;
    }): void | Promise<void>;
  };
  /** Host-owned permission configuration; browser input can only select a preset. */
  permissionSettings?: {
    get(): PermissionSettingsResponse | Promise<PermissionSettingsResponse>;
    configure(input: PermissionPresetUpdateRequest): void | Promise<void>;
  };
  /** Host-owned extension control plane. Implementations must resolve only
   * trusted catalog entries; the HTTP layer never accepts module paths. */
  extensions?: {
    list(): readonly ExtensionStatus[] | Promise<readonly ExtensionStatus[]>;
    reload(input: ExtensionReloadCommand): ExtensionStatus | Promise<ExtensionStatus>;
    runCommand(input: ExtensionCommandInvocation): ExtensionCommandResult | Promise<ExtensionCommandResult>;
  };
  /** Host-owned MCP lifecycle/status control plane. The manager itself stays
   * in Core; this seam only exposes bounded status and an idempotent restart. */
  mcp?: {
    get(): McpStatusSnapshot | Promise<McpStatusSnapshot>;
    restart(serverName: string, input: McpRestartRequest): McpServerStatus | Promise<McpServerStatus>;
  };
  /** Host-owned native LSP lifecycle/status control plane. */
  lsp?: {
    get(): LspStatusSnapshot | Promise<LspStatusSnapshot>;
  };
  /** Host-owned aggregate usage projection backed by the canonical event ledger. */
  usage?: {
    get(): UsageSnapshot | Promise<UsageSnapshot>;
  };
  /**
   * Durable session control is injected by the composition root. The Host
   * owns authentication, project scoping, and HTTP semantics; the controller
   * owns leases, JSONL persistence, ledger recovery, and resume execution.
   */
  sessions?: HostSessionController;
}

export type { HostSessionController, HostSessionScope } from "@tracegraph/api";

export interface RegisteredProject {
  label: string;
  workspace: WorkspaceHandle;
  location?: ProjectLocation;
}

export interface TraceGraphHost {
  app: FastifyInstance;
  /** The currently issued loopback capability. It can rotate after its TTL. */
  readonly token: string;
  /** The current loopback capability expiry. It advances with a safe renewal. */
  readonly expiresAt: string;
  listen(options?: { port?: number; host?: "127.0.0.1" | "::1" }): Promise<string>;
  close(): Promise<void>;
  readonly runSessions: RunSessionController;
  registerProject(project: RegisteredProject): void;
  /** Remove registration only; filesystem ownership belongs to a separate explicit operation. */
  unregisterProject(projectId:string):void;
  getRegisteredProject(projectId: string): RegisteredProject | undefined;
  listRegisteredProjects(): RegisteredProject[];
}

type ReplayCapabilityClaims = {
  readonly replayId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly selectedSequence: number;
  readonly headSequence: number;
  readonly expiresAtMs: number;
  readonly artifactIds: ReadonlySet<string>;
};

type HostCapabilityPrincipal =
  | { readonly kind: "live" }
  | {
      readonly kind: "replay";
      readonly tokenDigest: string;
      readonly claims: ReplayCapabilityClaims;
    };

const DEFAULT_REPLAY_TOKEN_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_REPLAY_CAPABILITIES = 64;

export async function createTraceGraphHost(
  options: TraceGraphHostOptions,
): Promise<TraceGraphHost> {
  const now = options.now ?? (() => new Date());
  const tokenTtlMs = options.tokenTtlMs ?? 8 * 60 * 60 * 1_000;
  let token = options.capabilityToken ?? randomBytes(32).toString("base64url");
  let expiresAtMs = now().getTime() + tokenTtlMs;
  let expiresAt = new Date(expiresAtMs).toISOString();
  // A browser uses bootstrap only from the allowed loopback origin.  When its
  // live bearer has expired, renew it there so the SDK's established
  // 401 -> bootstrap -> retry path can recover without ever involving model
  // credentials.  Do not rotate a still-valid bearer: separate tabs may be
  // using it concurrently.
  const renewLiveCapabilityIfExpired = (): void => {
    if (now().getTime() < expiresAtMs) return;
    token = randomBytes(32).toString("base64url");
    expiresAtMs = now().getTime() + tokenTtlMs;
    expiresAt = new Date(expiresAtMs).toISOString();
  };
  const replayTokenTtlMs = options.replayTokenTtlMs ?? DEFAULT_REPLAY_TOKEN_TTL_MS;
  const maxReplayCapabilities = options.maxReplayCapabilities ?? DEFAULT_MAX_REPLAY_CAPABILITIES;
  if (!Number.isSafeInteger(replayTokenTtlMs) || replayTokenTtlMs <= 0) {
    throw new TypeError("replayTokenTtlMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxReplayCapabilities) || maxReplayCapabilities <= 0) {
    throw new TypeError("maxReplayCapabilities must be a positive safe integer");
  }
  const replayCapabilities = new Map<string, ReplayCapabilityClaims>();
  const requestCapabilities = new WeakMap<object, HostCapabilityPrincipal>();
  const pruneReplayCapabilities = (): void => {
    const currentTime = now().getTime();
    for (const [digest, claims] of replayCapabilities) {
      if (currentTime >= claims.expiresAtMs) replayCapabilities.delete(digest);
    }
  };
  const authenticateCapability = (request: FastifyRequest): HostCapabilityPrincipal => {
    const bearer = readBearerToken(request);
    if (tokensEqual(bearer, token)) {
      if (now().getTime() >= expiresAtMs) {
        throw new HostCapabilityError(401, "capability_expired", "Capability token expired");
      }
      return { kind: "live" };
    }
    const tokenDigest = digestCapabilityToken(bearer);
    const claims = replayCapabilities.get(tokenDigest);
    if (claims === undefined) {
      throw new HostCapabilityError(401, "capability_invalid", "Capability token is invalid");
    }
    if (now().getTime() >= claims.expiresAtMs) {
      replayCapabilities.delete(tokenDigest);
      throw new HostCapabilityError(401, "capability_expired", "Capability token expired");
    }
    pruneReplayCapabilities();
    return { kind: "replay", tokenDigest, claims };
  };
  const mintReplayCapability = (
    snapshot: ReplaySnapshot,
    prior?: Extract<HostCapabilityPrincipal, { kind: "replay" }>,
  ): { replayId: string; replayToken: string; expiresAtMs: number } => {
    pruneReplayCapabilities();
    if (
      prior !== undefined
      && replayCapabilities.get(prior.tokenDigest) !== prior.claims
    ) {
      // Authentication happens before Runtime rebuilds the requested prefix.
      // A concurrent step may rotate the same bearer while that await is in
      // flight, so revalidate at the synchronous commit point before minting.
      // Otherwise two requests authenticated with one old bearer could both
      // leave a new replay capability behind.
      throw new HostCapabilityError(
        401,
        "replay_capability_stale",
        "Replay capability was already rotated or expired",
      );
    }
    // A successful replay step rotates its bearer. The previous snapshot can
    // no longer be used to fetch evidence outside the newly selected prefix.
    if (prior !== undefined) replayCapabilities.delete(prior.tokenDigest);
    if (replayCapabilities.size >= maxReplayCapabilities) {
      throw new HostCapabilityError(
        429,
        "replay_capability_capacity",
        "Too many replay capabilities are active",
      );
    }
    const replayId = `replay:${randomBytes(16).toString("base64url")}`;
    const replayToken = randomBytes(32).toString("base64url");
    const expiresAtForReplay = Math.min(expiresAtMs, now().getTime() + replayTokenTtlMs);
    replayCapabilities.set(digestCapabilityToken(replayToken), {
      replayId,
      sessionId: snapshot.session_id,
      projectId: snapshot.project_id,
      runId: snapshot.run_id,
      selectedSequence: snapshot.until_sequence,
      headSequence: snapshot.head_sequence,
      expiresAtMs: expiresAtForReplay,
      artifactIds: new Set(snapshot.projection.artifact_refs.map((artifact) => artifact.artifact_id)),
    });
    return { replayId, replayToken, expiresAtMs: expiresAtForReplay };
  };
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const visibleProjects = new Map(
    options.projects.map((project) => [project.workspace.project_id, project] as const),
  );
  if (visibleProjects.size !== options.projects.length) {
    throw new Error("Registered TraceGraph project ids must be unique");
  }
  const projects = new Map(visibleProjects);
  if (options.chatProject) {
    if (projects.has(options.chatProject.workspace.project_id)) {
      throw new Error("Chat workspace project id must be unique");
    }
    projects.set(options.chatProject.workspace.project_id, options.chatProject);
  }
  const runSessionController = new RunSessionController({
    runtime: options.runtime,
    admission: options.admission ?? "single",
    ...(options.prepareRunDispatch?{prepareDispatch:options.prepareRunDispatch}:{}),
    ...(options.getDefaultReasoningEffort?{getDefaultReasoningEffort:options.getDefaultReasoningEffort}:{}),
    ...(options.beforeRunStart?{beforeStart:options.beforeRunStart}:{}),
    ...(options.beforeSessionResume?{beforeResume:options.beforeSessionResume}:{}),
    ...(options.onRunStarted?{onStarted:options.onRunStarted}:{}),
    getWorkspace: (projectId) => projects.get(projectId)?.workspace,
    getProjectIds: () => [...projects.keys()],
    getChatWorkspace: () => options.chatProject?.workspace,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  });
  const memoryExperienceController = new MemoryExperienceController({
    runtime: options.runtime,
    getProjectIds: () => [...visibleProjects.keys()],
  });
  const localProjectCommands = new Map<string, { access: "read_write" | "read_only"; projectId?: string }>();
  const removeProjectCommands = new Map<string, string>();
  const permissionCommands = new Map<string, PermissionPresetUpdateRequest["preset_key"]>();
  const extensionReloadCommands = new Map<string, {
    fingerprint: string;
    result: Promise<ExtensionStatus>;
  }>();
  const extensionRunCommands = new Map<string, {
    fingerprint: string;
    result: Promise<ExtensionCommandResult>;
  }>();
  const mcpRestartCommands = new Map<string, {
    fingerprint: string;
    result: Promise<McpServerStatus>;
  }>();
  let localProjectQueue: Promise<void> = Promise.resolve();
  const serializeLocalProjectSelection = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = localProjectQueue.then(operation, operation);
    localProjectQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const logger = options.logger === true
    ? {
        ...(options.loggerStream === undefined ? {} : { stream: options.loggerStream }),
        redact: {
          paths: [
            "req.headers.authorization",
            'req.headers["x-outlive-local-token"]',
            "req.headers.cookie",
            "req.body.api_key",
            "body.api_key",
            "api_key",
          ],
          censor: "[REDACTED]",
        },
        // This is the final logging boundary. It covers opaque registered
        // values even when they occur in an otherwise innocuous message.
        hooks: {
          streamWrite: redactHostLogLine,
        },
      }
    : false;
  const app = Fastify({
    logger,
    forceCloseConnections:true,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
  });
  app.addContentTypeParser(
    ATTACHMENT_CONTENT_TYPE,
    { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_TRANSPORT_BYTES },
    (_request, body, done) => done(null, body),
  );
  const recovery = SessionRecoveryReportSchema.parse(
    options.sessions === undefined
      ? {
          scanned_sessions: 0,
          truncated_session_ids: [],
          interrupted_run_ids: [],
          recovered_at: now().toISOString(),
        }
      : await options.sessions.recover(),
  );
  if (options.sessions !== undefined) {
    app.log.info({ recovery }, "Durable session recovery completed");
  }

  await app.register(cors, {
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "x-tracegraph-command-id",
    ],
    exposedHeaders: ["content-type", "content-length", "x-tracegraph-content-sha256"],
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(null, false);
    },
  });

  app.setErrorHandler((error, request, reply) => {
    const safeTyped=error as {code?:unknown;statusCode?:unknown;message?:unknown};
    if(typeof safeTyped.code === "string" && /^[a-z][a-z0-9_]{0,100}$/u.test(safeTyped.code) && typeof safeTyped.statusCode === "number" && safeTyped.statusCode>=400 && safeTyped.statusCode<=599 && (request.url.startsWith("/api/workbench/") || ["model_config_readonly","credential_storage_failed","credential_required","migration_busy","migration_source_required","workspace_queue_cancelled","host_restarting","file_context_unavailable","file_context_revision_conflict","file_context_limit","file_context_not_text","file_read_approval_required","file_read_policy_denied","file_scope_denied","file_symlink_denied","file_hardlink_denied","file_too_large","file_changed","file_unavailable","file_kind_unsupported","project_scope_denied","session_project_mismatch","workspace_project_mismatch"].includes(safeTyped.code))) {
      void reply.status(safeTyped.statusCode).send({error:safeTyped.code,message:redactSensitiveText(typeof safeTyped.message === "string"?safeTyped.message:"Host operation failed")});return;
    }
    if (error instanceof HostCapabilityError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof RunSessionControllerError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: "invalid_request",
        message: "Request did not match the TraceGraph contract",
        issues: error.issues,
      });
      return;
    }
    if (error instanceof RuntimeCommandError) {
      const statusCode = error.code === "run_not_found"
        ? 404
        : error.code.includes("capability")
          ? 403
          : 409;
      void reply.status(statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof TodoDomainError) {
      const statusCode = error.code === "run_not_found" || error.code === "todo_not_found"
        ? 404
        : 409;
      void reply.status(statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }
    const teamError = teamControlHttpError(error);
    if (teamError !== undefined) {
      void reply.status(teamError.statusCode).send({
        error: teamError.code,
        message: teamError.message,
      });
      return;
    }
    const sessionError = sessionControlHttpError(error);
    if (sessionError !== undefined) {
      // A contender must never bypass the lease just to record its own
      // rejection in the Session ledger.  Record the conflict at the Host
      // audit boundary instead, using only stable/safe fields and never the
      // backend error text (which can contain lock paths, PIDs, or hostnames).
      app.log.warn({
        audit: {
          operation: "session.operation_rejected",
          code: sessionError.code,
          status_code: sessionError.statusCode,
          method: request.method,
          route: request.routeOptions.url,
        },
      }, "Durable session operation rejected");
      void reply.status(sessionError.statusCode).send({
        error: sessionError.code,
        message: sessionError.message,
      });
      return;
    }
    const replayError = replayControlHttpError(error);
    if (replayError !== undefined) {
      void reply.status(replayError.statusCode).send({
        error: replayError.code,
        message: replayError.message,
      });
      return;
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const errorMessage = error instanceof Error ? error.message : "Request failed";
    void reply.status(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : "request_rejected",
      message: statusCode >= 500 ? "Outlive Agent could not complete the request" : errorMessage,
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/bootstrap", async (request, reply) => {
    if (!options.isPrivateLocalRequest?.(request)) assertLoopback(request);
    assertOrigin(request, allowedOrigins);
    renewLiveCapabilityIfExpired();
    reply.header("cache-control", "no-store");
    return { token, expiresAt, recovery };
  });

  const enteredMutations=new WeakSet<FastifyRequest>();
  const finishMutation=(request:FastifyRequest)=>{if(enteredMutations.delete(request))options.mutationLifecycle?.leave();};
  app.addHook("onResponse",async request=>{finishMutation(request);});
  app.addHook("onRequestAbort",async request=>{finishMutation(request);});
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/") || request.url.startsWith("/api/bootstrap")) {
      return;
    }
    if (!options.isPrivateLocalRequest?.(request)) assertLoopback(request);
    const principal = authenticateCapability(request);
    requestCapabilities.set(request, principal);
    if (principal.kind === "replay" && !isReplayCapabilityRoute(request)) {
      throw new HostCapabilityError(
        403,
        "replay_read_only",
        "Replay capability is read-only for this route",
      );
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      assertOrigin(request, allowedOrigins);
      options.mutationLifecycle?.enter();
      enteredMutations.add(request);
    }
  });

  const capabilityForRequest = (request: FastifyRequest): HostCapabilityPrincipal => {
    const principal = requestCapabilities.get(request);
    if (principal === undefined) {
      throw new Error("Authenticated request has no Host capability principal");
    }
    return principal;
  };

  const requireReplayCapability = (
    request: FastifyRequest,
  ): Extract<HostCapabilityPrincipal, { kind: "replay" }> => {
    const principal = capabilityForRequest(request);
    if (principal.kind !== "replay") {
      throw new HostCapabilityError(
        403,
        "replay_capability_required",
        "A replay-scoped capability is required",
      );
    }
    return principal;
  };

  app.get("/api/projects", async () => {
    return [...visibleProjects.values()].map(toProjectSummary);
  });

  app.post("/api/projects", async (request, reply) => {
    if (!options.projectFactory) {
      return reply.status(501).send({ error: "project_creation_unavailable", message: "This Host cannot create managed projects" });
    }
    const input = z.object({
      name: z.string().trim().min(1).max(80),
      template: z.literal("typescript").default("typescript"),
    }).parse(request.body);
    const project = await options.projectFactory(input);
    if (projects.has(project.workspace.project_id)) {
      throw Object.assign(new Error("A project with this id already exists"), { statusCode: 409 });
    }
    projects.set(project.workspace.project_id, project);
    visibleProjects.set(project.workspace.project_id, project);
    return reply.status(201).send(toProjectSummary(project));
  });

  app.post("/api/projects/open-local", async (request, reply) => serializeLocalProjectSelection(async () => {
    if (!options.localProjectSelector) {
      return reply.status(501).send({
        error: "local_project_selection_unavailable",
        message: "This Host cannot open a native directory picker",
      });
    }
    const input = OpenLocalProjectRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const previous = localProjectCommands.get(input.command_id);
    if (previous) {
      if (previous.access !== input.access) {
        throw Object.assign(new Error("Command id was already used with a different request"), {
          statusCode: 409,
        });
      }
      if (!previous.projectId) return reply.status(204).send();
      const registered = projects.get(previous.projectId);
      if (!registered) {
        throw Object.assign(new Error("Previously selected project is no longer registered"), {
          statusCode: 409,
        });
      }
      return toProjectSummary(registered);
    }

    const project = await options.localProjectSelector({ access: input.access });
    if (!project) {
      localProjectCommands.set(input.command_id, { access: input.access });
      return reply.status(204).send();
    }
    const existing = projects.get(project.workspace.project_id);
    if (existing && existing.workspace.real_root !== project.workspace.real_root) {
      throw Object.assign(new Error("A project with this id already exists"), { statusCode: 409 });
    }
    const registered = existing ?? project;
    projects.set(registered.workspace.project_id, registered);
    visibleProjects.set(registered.workspace.project_id, registered);
    localProjectCommands.set(input.command_id, {
      access: input.access,
      projectId: registered.workspace.project_id,
    });
    return reply.status(existing ? 200 : 201).send(toProjectSummary(registered));
  }));

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/reveal", async (request, reply) => {
    if (!options.projectRevealer) {
      return reply.status(501).send({
        error: "project_reveal_unavailable",
        message: "This Host cannot reveal project directories",
      });
    }
    const input = RevealProjectRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const project = visibleProjects.get(request.params.projectId);
    if (!project) {
      throw Object.assign(new Error("Project is not registered by this Host"), { statusCode: 404 });
    }
    if (!project.location?.can_reveal) {
      throw Object.assign(new Error("This project has no revealable local location"), { statusCode: 409 });
    }
    await options.projectRevealer(project);
    return reply.status(204).send();
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/remove", async (request, reply) => {
    const input = RemoveProjectRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const previous = removeProjectCommands.get(input.command_id);
    if (previous !== undefined) {
      if (previous !== request.params.projectId) {
        throw Object.assign(new Error("Command id was already used with a different project"), { statusCode: 409 });
      }
      return reply.status(204).send();
    }
    const project = visibleProjects.get(request.params.projectId);
    if (!project) {
      throw Object.assign(new Error("Project is not registered by this Host"), { statusCode: 404 });
    }
    const remover = project.location?.kind === "linked_directory"
      ? options.localProjectRemover
      : project.location?.kind === "managed_storage"
        ? options.projectRemover
        : undefined;
    if (!remover) {
      return reply.status(501).send({
        error: "project_removal_unavailable",
        message: "This Host cannot remove this project",
      });
    }
    if (project.location?.kind !== "linked_directory" && project.location?.kind !== "managed_storage") {
      throw Object.assign(new Error("This project cannot be removed from the Host"), { statusCode: 409 });
    }
    const active = await runSessionController.getActiveRunProjections();
    if (active.some(run=>projects.get(run.project_id)?.workspace.real_root===project.workspace.real_root)) {
      throw Object.assign(new Error("Stop the active run before removing its project registration"), { statusCode: 409 });
    }
    await remover(project);
    removeProjectCommands.set(input.command_id, request.params.projectId);
    visibleProjects.delete(request.params.projectId);
    projects.delete(request.params.projectId);
    return reply.status(204).send();
  });

  app.get("/api/image-provider", async (_request,reply)=>{reply.header("cache-control","no-store");if(!options.imageSettings)return reply.status(501).send({error:"image_configuration_unavailable",message:"This Host cannot configure images"});return ImageProviderConfigSnapshotSchema.parse(await options.imageSettings.get());});
  app.post("/api/image-provider", async (request,reply)=>{if(!options.imageSettings)return reply.status(501).send({error:"image_configuration_unavailable",message:"This Host cannot configure images"});const input=ImageProviderConfigUpdateSchema.parse(request.body);reply.header("cache-control","no-store");return ImageProviderConfigSnapshotSchema.parse(await options.imageSettings.configure(input));});
  app.delete("/api/image-provider", async (_request,reply)=>{if(!options.imageSettings)return reply.status(501).send({error:"image_configuration_unavailable",message:"This Host cannot configure images"});reply.header("cache-control","no-store");return ImageProviderConfigSnapshotSchema.parse(await options.imageSettings.clear());});
  app.post("/api/media/runs",async(request,reply)=>{const input=StartMediaRunRequestSchema.parse(request.body);assertCommandId(request,input.command_id);const projectId=input.project_id??options.chatProject?.workspace.project_id;if(!projectId)throw new RunSessionControllerError(501,"plain_chat_unavailable","This Host has no isolated media workspace");const adapter=createMediaInstructionAdapter(input.operation);const requestValue=StartRunRequestSchema.parse({command_id:input.command_id,project_id:projectId,mode:"execute",task:createMediaTaskTitle(input.operation)});const projection=await runSessionController.startRun(requestValue,{identity:adapter.name,start:runInput=>options.runtime.startRun(runInput,{model:adapter,backgroundModelDerivation:false})});reply.header("cache-control","no-store");return projection;});

  app.get("/api/model-config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const value = options.modelSettings
      ? await options.modelSettings.get()
      : {
      provider: "openai",
      protocol: "openai-chat-completions",
      configured: false,
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      has_key: false,
    };
    return parsePublicModelConfigResponse(value);
  });

  app.post("/api/model-config", async (request, reply) => {
    if (!options.modelSettings) {
      return reply.status(501).send({ error: "model_configuration_unavailable", message: "This Host cannot configure a model" });
    }
    const input = ModelConfigUpdateRequestSchema.parse(request.body);
    await options.modelSettings.configure({
      provider: input.provider,
      protocol: input.protocol,
      baseUrl: input.base_url,
      model: input.model,
      ...(input.api_key === undefined ? {} : { apiKey: input.api_key }),
    });
    await options.runtime.resumeMemoryExtraction?.();
    reply.header("cache-control", "no-store");
    return parsePublicModelConfigResponse(await options.modelSettings.get());
  });

  app.get("/api/permission-config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.permissionSettings) {
      return reply.status(501).send({
        error: "permission_configuration_unavailable",
        message: "This Host cannot configure permissions",
      });
    }
    return parsePermissionSettingsResponse(await options.permissionSettings.get());
  });

  app.get("/api/telemetry-status", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    // Runtime owns the process-local sink and error counter. Reading it
    // directly avoids a second, diverging status source in Host composition.
    return parseTelemetryStatus(options.runtime.getTelemetryStatus());
  });

  app.get("/api/usage", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.usage) {
      return reply.status(501).send({
        error: "usage_unavailable",
        message: "This Host does not expose aggregate usage",
      });
    }
    return UsageSnapshotSchema.parse(await options.usage.get());
  });

  app.get("/api/memory", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const result = await memoryExperienceController.dispatchQuery({ operation: "memory.list" });
    if (result.resource !== "memory_control") throw new Error("Memory controller returned an invalid list resource");
    return result.value;
  });

  app.post("/api/memory", async (request, reply) => {
    const input = MemoryCandidateCreateRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const result = await memoryExperienceController.dispatchCommand({ type: "memory.create", input });
    if (result.resource !== "memory_item") throw new Error("Memory controller returned an invalid candidate resource");
    return reply.status(201).send(result.value);
  });

  app.post<{ Params: { memoryId: string } }>("/api/memory/:memoryId/review", async (request) => {
    const input = MemoryReviewRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const result = await memoryExperienceController.dispatchCommand({ type: "memory.review", memory_id: request.params.memoryId, input });
    if (result.resource !== "memory_item") throw new Error("Memory controller returned an invalid review resource");
    return result.value;
  });

  app.post<{ Params: { memoryId: string } }>("/api/memory/:memoryId/correct", async (request) => {
    const input = MemoryCorrectionRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const result = await memoryExperienceController.dispatchCommand({ type: "memory.correct", memory_id: request.params.memoryId, input });
    if (result.resource !== "memory_item") throw new Error("Memory controller returned an invalid correction resource");
    return result.value;
  });

  app.post<{ Params: { memoryId: string } }>("/api/memory/:memoryId/revoke", async (request) => {
    const input = MemoryRevokeRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const result = await memoryExperienceController.dispatchCommand({ type: "memory.revoke", memory_id: request.params.memoryId, input });
    if (result.resource !== "memory_item") throw new Error("Memory controller returned an invalid revoke resource");
    return result.value;
  });

  app.delete<{ Params: { memoryId: string } }>("/api/memory/:memoryId", async (request) => {
    const input = MemoryDeleteRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const result = await memoryExperienceController.dispatchCommand({ type: "memory.delete", memory_id: request.params.memoryId, input });
    if (result.resource !== "memory_delete") throw new Error("Memory controller returned an invalid delete resource");
    return result.value;
  });

  app.get("/api/experience", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const result = await memoryExperienceController.dispatchQuery({ operation: "experience.list" });
    if (result.resource !== "experience_cases") throw new Error("Experience controller returned an invalid list resource");
    return result.value;
  });

  app.post<{ Params: { caseId: string } }>("/api/experience/:caseId/review", async (request) => {
    const input = ExperienceLifecycleReviewRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const result = await memoryExperienceController.dispatchCommand({ type: "experience.review", case_id: request.params.caseId, input });
    if (result.resource !== "experience_case") throw new Error("Experience controller returned an invalid review resource");
    return result.value;
  });

  app.post("/api/permission-config", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.permissionSettings) {
      return reply.status(501).send({
        error: "permission_configuration_unavailable",
        message: "This Host cannot configure permissions",
      });
    }
    const input = PermissionPresetUpdateRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const previous = permissionCommands.get(input.command_id);
    if (previous !== undefined && previous !== input.preset_key) {
      throw Object.assign(new Error("Command id was already used with a different permission preset"), {
        statusCode: 409,
      });
    }
    if (previous === undefined) {
      await options.permissionSettings.configure(input);
      permissionCommands.set(input.command_id, input.preset_key);
    }
    return parsePermissionSettingsResponse(await options.permissionSettings.get());
  });

  app.get("/api/extensions", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.extensions) {
      return reply.status(501).send({
        error: "extension_management_unavailable",
        message: "This Host cannot manage extensions",
      });
    }
    return parseExtensionStatuses(await options.extensions.list());
  });

  app.get("/api/skills", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const inspections: SkillProjectInspection[] = [];
    for (const project of visibleProjects.values()) {
      const inspection = await options.runtime.inspectSkills(project.workspace);
      inspections.push(SkillProjectInspectionSchema.parse({
        ...inspection,
        label: project.label,
      }));
    }
    return inspections;
  });

  app.get("/api/mcp", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.mcp) {
      return reply.status(501).send({
        error: "mcp_management_unavailable",
        message: "This Host does not have an MCP manager",
      });
    }
    return parseMcpStatusSnapshot(await options.mcp.get());
  });

  app.get("/api/lsp", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.lsp) {
      return reply.status(501).send({
        error: "lsp_management_unavailable",
        message: "This Host does not have an LSP manager",
      });
    }
    return parseLspStatusSnapshot(await options.lsp.get());
  });

  app.post<{ Params: { name: string } }>("/api/mcp/restart/:name", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.mcp) {
      return reply.status(501).send({
        error: "mcp_management_unavailable",
        message: "This Host does not have an MCP manager",
      });
    }
    const input = McpRestartRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const serverName = MCP_SERVER_NAME_SCHEMA.parse(request.params.name);
    const fingerprint = JSON.stringify([serverName]);
    const previous = mcpRestartCommands.get(input.command_id);
    if (previous !== undefined && previous.fingerprint !== fingerprint) {
      throw Object.assign(new Error("Command id was already used with a different MCP server restart"), {
        statusCode: 409,
      });
    }
    if (previous !== undefined) return parseMcpServerStatus(await previous.result);
    const result = Promise.resolve(options.mcp.restart(serverName, input));
    rememberBoundedCommand(mcpRestartCommands, input.command_id, { fingerprint, result });
    try {
      return parseMcpServerStatus(await result);
    } catch (error) {
      mcpRestartCommands.delete(input.command_id);
      throw error;
    }
  });

  app.post("/api/extensions/reload", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.extensions) {
      return reply.status(501).send({
        error: "extension_management_unavailable",
        message: "This Host cannot manage extensions",
      });
    }
    const input = ExtensionReloadCommandSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const fingerprint = JSON.stringify([
      input.extension_name,
      input.expected_config_digest ?? null,
    ]);
    const previous = extensionReloadCommands.get(input.command_id);
    if (previous !== undefined && previous.fingerprint !== fingerprint) {
      throw Object.assign(new Error("Command id was already used with a different extension reload"), {
        statusCode: 409,
      });
    }
    if (previous !== undefined) return parseExtensionStatus(await previous.result);
    const result = Promise.resolve(options.extensions.reload(input));
    rememberBoundedCommand(extensionReloadCommands, input.command_id, { fingerprint, result });
    try {
      return parseExtensionStatus(await result);
    } catch (error) {
      extensionReloadCommands.delete(input.command_id);
      throw error;
    }
  });

  app.post<{ Params: { name: string } }>("/api/extensions/commands/:name", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.extensions) {
      return reply.status(501).send({
        error: "extension_management_unavailable",
        message: "This Host cannot manage extensions",
      });
    }
    const input = ExtensionCommandInvocationSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    if (request.params.name !== input.name) {
      throw Object.assign(new Error("Extension command path and body do not match"), {
        statusCode: 409,
      });
    }
    const fingerprint = JSON.stringify([input.name, input.args]);
    const previous = extensionRunCommands.get(input.command_id);
    if (previous !== undefined && previous.fingerprint !== fingerprint) {
      throw Object.assign(new Error("Command id was already used with different extension command arguments"), {
        statusCode: 409,
      });
    }
    if (previous !== undefined) return parseExtensionCommandResult(await previous.result);
    const result = Promise.resolve(options.extensions.runCommand(input));
    rememberBoundedCommand(extensionRunCommands, input.command_id, { fingerprint, result });
    try {
      return parseExtensionCommandResult(await result);
    } catch (error) {
      extensionRunCommands.delete(input.command_id);
      throw error;
    }
  });

  app.get<{
    Querystring: {
      project_id?: string;
      q?: string;
      limit?: string | number;
      cursor?: string;
      view?: "roots" | "all";
    };
  }>("/api/sessions", async (request, reply) => {
    const result = await runSessionController.listSessions(request.query);
    // The controller receives the scope to make pagination correct. Validate
    // it again at the HTTP trust boundary so a faulty adapter cannot disclose
    // sessions belonging to an unregistered project.
    if (result.sessions.some((session) => !projects.has(session.project_id))) {
      throw new Error("Session controller returned a session outside the Host project scope");
    }
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const sessionId = IdentifierSchema.parse(request.params.sessionId);
    const result = await runSessionController.getSession(sessionId);
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.patch<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const sessions = requireSessionController(options.sessions);
    const sessionId = IdentifierSchema.parse(request.params.sessionId);
    const input = SessionRenameRequestSchema.parse(request.body);
    const existing = SessionReadResultSchema.parse(await sessions.read(sessionId));
    assertSessionIdentity(sessionId, existing);
    assertRegisteredProject(existing.header.project_id, projects);
    const result = SessionReadResultSchema.parse(await sessions.rename(sessionId, input));
    assertSessionIdentity(sessionId, result);
    if (result.header.project_id !== existing.header.project_id) {
      throw new Error("Session project changed during rename");
    }
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.delete<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const sessions = requireSessionController(options.sessions);
    const sessionId = IdentifierSchema.parse(request.params.sessionId);
    const existing = SessionReadResultSchema.parse(await sessions.read(sessionId));
    assertSessionIdentity(sessionId, existing);
    assertRegisteredProject(existing.header.project_id, projects);
    const active = await runSessionController.getActiveRunProjections();
    if (active.some(run=>existing.header.run_ids.includes(run.run_id))) {
      throw Object.assign(new Error("Stop the active run before deleting its session"), {
        statusCode: 409,
      });
    }
    const result = SessionDeleteResponseSchema.parse(await sessions.delete(sessionId));
    if (result.session_id !== sessionId) {
      throw new Error("Session controller deleted a different session");
    }
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/resume", async (request, reply) => {
    const sessionId = IdentifierSchema.parse(request.params.sessionId);
    const input = SessionResumeRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const result = await runSessionController.resumeSession(sessionId, input);
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.post("/api/replay", async (request, reply) => {
    const input = ReplaySnapshotRequestSchema.parse(request.body);
    const principal = capabilityForRequest(request);
    if (
      principal.kind === "replay"
      && (
        principal.claims.sessionId !== input.session_id
        || principal.claims.runId !== input.run_id
      )
    ) {
      throw new HostCapabilityError(
        403,
        "replay_scope_mismatch",
        "Replay capability cannot switch to another Session or Run",
      );
    }
    if (principal.kind === "replay" && input.until_sequence > principal.claims.headSequence) {
      throw new HostCapabilityError(
        403,
        "replay_sequence_out_of_scope",
        "Replay sequence exceeds this capability's observed head",
      );
    }

    const sessions = requireSessionController(options.sessions);
    const session = SessionReadResultSchema.parse(await sessions.read(input.session_id));
    assertSessionIdentity(input.session_id, session);
    assertRegisteredProject(session.header.project_id, projects);
    if (!session.header.run_ids.includes(input.run_id)) {
      throw new HostCapabilityError(
        403,
        "replay_scope_mismatch",
        "Run is outside the requested Session",
      );
    }

    const runtimeSnapshot = ReplaySnapshotSchema.parse(await options.runtime.replayAt(input));
    if (
      runtimeSnapshot.session_id !== input.session_id
      || runtimeSnapshot.run_id !== input.run_id
      || runtimeSnapshot.project_id !== session.header.project_id
      || runtimeSnapshot.until_sequence !== input.until_sequence
    ) {
      throw new Error("Runtime returned a replay snapshot outside the authorized scope");
    }
    // A replay step is bounded by the head observed when its capability was
    // issued. Core intentionally excludes head_sequence from snapshot_hash,
    // so normalizing this observation metadata preserves the canonical hash.
    const snapshot = ReplaySnapshotSchema.parse({
      ...runtimeSnapshot,
      ...(principal.kind === "replay"
        ? { head_sequence: principal.claims.headSequence }
        : {}),
    });
    const issued = mintReplayCapability(
      snapshot,
      principal.kind === "replay" ? principal : undefined,
    );
    const response = ReplaySessionResponseSchema.parse({
      replay_id: issued.replayId,
      replay_token: issued.replayToken,
      expires_at: new Date(issued.expiresAtMs).toISOString(),
      snapshot,
    });
    reply.header("cache-control", "private, no-store");
    return response;
  });

  app.get<{
    Querystring: {
      session_id?: string;
      run_id?: string;
      from?: string | number;
      to?: string | number;
    };
  }>("/api/replay/diff", async (request, reply) => {
    const principal = requireReplayCapability(request);
    const query = ReplayDiffQuerySchema.parse(request.query);
    if (
      query.session_id !== principal.claims.sessionId
      || query.run_id !== principal.claims.runId
    ) {
      throw new HostCapabilityError(
        403,
        "replay_scope_mismatch",
        "Replay diff is outside this capability's Session or Run",
      );
    }
    if (
      query.from > principal.claims.headSequence
      || query.to > principal.claims.headSequence
    ) {
      throw new HostCapabilityError(
        403,
        "replay_sequence_out_of_scope",
        "Replay diff exceeds this capability's observed head",
      );
    }
    const runtimeDiff = ReplayDiffSchema.parse(await options.runtime.replayDiff(query));
    if (
      runtimeDiff.session_id !== principal.claims.sessionId
      || runtimeDiff.project_id !== principal.claims.projectId
      || runtimeDiff.run_id !== principal.claims.runId
    ) {
      throw new Error("Runtime returned a replay diff outside the authorized scope");
    }
    // A Run may continue after replay mode is entered. Do not let a diff leak
    // the newer head merely because core observed it while rebuilding two old
    // prefixes; the capability remains frozen at its issued head.
    const diff = ReplayDiffSchema.parse({
      ...runtimeDiff,
      head_sequence: principal.claims.headSequence,
    });
    reply.header("cache-control", "private, no-store");
    return diff;
  });

  app.post("/api/runs", { bodyLimit: MAX_RUN_REQUEST_BODY_BYTES }, async (request) => {
    const wireInput = StartRunRequestSchema.parse(request.body);
    assertCommandId(request, wireInput.command_id);
    return runSessionController.startRun(wireInput);
  });

  app.post("/api/chat/runs", { bodyLimit: MAX_RUN_REQUEST_BODY_BYTES }, async (request, reply) => {
    if (!options.chatProject) {
      return reply.status(501).send({
        error: "plain_chat_unavailable",
        message: "This Host has no isolated chat workspace",
      });
    }
    const chatInput = StartChatRequestSchema.parse(request.body);
    assertCommandId(request, chatInput.command_id);
    return runSessionController.startChat(chatInput);
  });

  app.post<{
    Querystring: {
      command_id?: string;
      target?: "project" | "chat";
      project_id?: string;
      session_id?: string;
      declared_media_type?: string;
      delivery?: "offload" | "inline";
    };
  }>("/api/attachments", { bodyLimit: MAX_ATTACHMENT_TRANSPORT_BYTES }, async (request, reply) => {
    const upload = AttachmentUploadRequestSchema.parse(request.query);
    assertCommandId(request, upload.command_id);
    if (!Buffer.isBuffer(request.body)) {
      throw Object.assign(new Error("Attachment body must be raw application/octet-stream bytes"), {
        statusCode: 415,
      });
    }

    const project = resolveAttachmentProject(upload, visibleProjects, options.chatProject);
    if (upload.session_id !== undefined) {
      const sessions = requireSessionController(options.sessions);
      const existing = SessionReadResultSchema.parse(await sessions.read(upload.session_id));
      assertSessionIdentity(upload.session_id, existing);
      if (existing.header.project_id !== project.workspace.project_id) {
        throw Object.assign(new Error("Attachment Session belongs to another project"), {
          statusCode: 409,
        });
      }
    }

    const receipt = AttachmentStageReceiptSchema.parse(await options.runtime.stageAttachment({
      commandId: upload.command_id,
      projectId: project.workspace.project_id,
      ...(upload.session_id === undefined ? {} : { sessionId: upload.session_id }),
      declaredMediaType: upload.declared_media_type,
      delivery: upload.delivery,
      bytes: request.body,
      source: "user_upload",
    }));
    // Project and Session scope deliberately stay inside Core's durable
    // staging record. In particular, a chat upload receipt must never reveal
    // the hidden chat project id back to the browser.
    if (receipt.delivery !== upload.delivery || receipt.source !== "user_upload") {
      throw new Error("Runtime returned an Attachment staging receipt with mismatched policy metadata");
    }
    reply.header("cache-control", "private, no-store");
    return reply.status(201).send(receipt);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request) => {
    return runSessionController.getRun(request.params.runId);
  });

  app.get<{Params:{runId:string;artifactId:string}}>("/api/runs/:runId/artifacts/:artifactId/content",async(request,reply)=>{
    if(capabilityForRequest(request).kind!=="live")throw new HostCapabilityError(403,"replay_read_only","Binary Artifact content is unavailable through replay authority");
    const runId=IdentifierSchema.parse(request.params.runId),artifactId=IdentifierSchema.parse(request.params.artifactId);
    const projection=RunProjectionSchema.parse(await options.runtime.getProjection(runId));assertRegisteredProject(projection.project_id,projects);
    const expected=projection.artifact_refs.find(ref=>ref.artifact_id===artifactId);if(!expected)throw Object.assign(new Error("Artifact is not related to this Run"),{statusCode:404});
    const content=await options.runtime.getArtifactContent({artifactId,runId,projectId:projection.project_id});
    if(content.status!=="available")throw Object.assign(new Error("Binary Artifact content is unavailable or fails integrity verification"),{statusCode:content.status==="corrupt"?409:404});
    const mime=MediaMimeTypeSchema.parse(content.artifact.mime_type);
    if(content.artifact.artifact_id!==artifactId||content.artifact.content_hash!==expected.content_hash||content.artifact.byte_length!==expected.byte_length||content.artifact.mime_type!==expected.mime_type||content.bytes.byteLength!==expected.byte_length||content.bytes.byteLength>MAX_GENERATED_IMAGE_BYTES||sha256Bytes(content.bytes)!==expected.content_hash)throw new Error("Binary Artifact differs from its canonical Run relation");
    reply.header("cache-control","private, no-store").header("content-security-policy","sandbox; default-src 'none'").header("cross-origin-resource-policy","same-origin").header("x-content-type-options","nosniff").header("x-tracegraph-content-sha256",expected.content_hash).header("content-disposition",`inline; filename="media.${mime==="image/svg+xml"?"svg":mime.split("/")[1]}"`);
    return reply.type(mime).send(Buffer.from(content.bytes));
  });

  app.get<{ Params: { runId: string; attachmentId: string } }>(
    "/api/runs/:runId/attachments/:attachmentId/content",
    async (request, reply) => {
      const principal = capabilityForRequest(request);
      if (principal.kind !== "live") {
        throw new HostCapabilityError(
          403,
          "replay_read_only",
          "Attachment content is unavailable through a replay capability",
        );
      }
      const runId = IdentifierSchema.parse(request.params.runId);
      const attachmentId = IdentifierSchema.parse(request.params.attachmentId);
      const projection = RunProjectionSchema.parse(await options.runtime.getProjection(runId));
      assertRegisteredProject(projection.project_id, projects);
      const projected = projection.attachments.items.find((item) => (
        item.status !== "rejected" && item.attachment.attachment_id === attachmentId
      ));
      if (projected === undefined || projected.status === "rejected") {
        throw Object.assign(new Error("Attachment is not related to this Run"), { statusCode: 404 });
      }
      const content = await options.runtime.getAttachmentContent({
        attachmentId,
        runId,
        projectId: projection.project_id,
      });
      if (
        content.attachment.attachment_id !== attachmentId
        || content.attachment.media_type !== projected.attachment.media_type
        || content.attachment.bytes !== projected.attachment.bytes
        || content.attachment.sha256 !== projected.attachment.sha256
        || content.bytes.byteLength !== projected.attachment.bytes
        || sha256Bytes(content.bytes) !== projected.attachment.sha256
      ) {
        throw new Error("Runtime returned Attachment content outside the canonical Run relation");
      }
      const extension = content.attachment.media_type === "image/png"
        ? "png"
        : content.attachment.media_type === "image/jpeg"
          ? "jpg"
          : "pdf";
      reply.header("cache-control", "private, no-store");
      reply.header("content-security-policy", "sandbox; default-src 'none'");
      reply.header("cross-origin-resource-policy", "same-origin");
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-tracegraph-content-sha256", content.attachment.sha256);
      reply.header("content-disposition", `inline; filename="attachment.${extension}"`);
      reply.type(content.attachment.media_type);
      return reply.send(Buffer.from(content.bytes));
    },
  );

  app.get<{ Params: { parentRunId: string; subagentId: string } }>(
    "/api/runs/:parentRunId/subagents/:subagentId",
    async (request, reply) => {
      const parentRunId = IdentifierSchema.parse(request.params.parentRunId);
      const subagentId = IdentifierSchema.parse(request.params.subagentId);
      const parent = RunProjectionSchema.parse(
        await options.runtime.getProjection(parentRunId),
      );
      assertRegisteredProject(parent.project_id, projects);
      const delegated = parent.subagents.items.find(
        ({ link }) => link.subagent_id === subagentId,
      );
      if (delegated === undefined) {
        throw Object.assign(new Error("Subagent is not related to this parent Run"), {
          statusCode: 404,
        });
      }

      const child = RunProjectionSchema.parse(
        await options.runtime.getProjection(delegated.link.child_run_id),
      );
      const childCreated = child.timeline[0];
      if (
        delegated.link.parent_run_id !== parent.run_id
        || delegated.link.parent_session_id !== parent.session_id
        || child.run_id !== delegated.link.child_run_id
        || child.session_id !== delegated.link.child_session_id
        || child.project_id !== parent.project_id
        || childCreated?.type !== "run.created"
        || childCreated.data.parent_run_id !== parent.run_id
        || childCreated.data.parent_session_id !== delegated.link.parent_session_id
        || childCreated.data.subagent_id !== subagentId
        || childCreated.data.subagent_depth !== delegated.depth
      ) {
        throw new Error("Runtime returned a child Run outside the delegated relation");
      }
      assertRegisteredProject(child.project_id, projects);
      reply.header("cache-control", "private, no-store");
      return child;
    },
  );

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/team", async (request, reply) => {
    const scope = await resolveTeamActorScope(options.runtime, request.params.runId, projects);
    if (scope.kind !== "coordinator") {
      throw Object.assign(new Error("Team snapshots must be read through the coordinator Run"), {
        statusCode: 409,
      });
    }
    const response = TeamReadResponseSchema.parse(
      await options.runtime.readTeam(scope.coordinatorRunId, scope.projectId),
    );
    if (response.team !== undefined) {
      assertTeamProjectionRelation(response.team, scope.coordinator);
    }
    reply.header("cache-control", "private, no-store");
    return response;
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/team", async (request, reply) => {
    const input = CreateTeamRequestSchema.parse(request.body);
    assertCommandId(request, input.command_id);
    const scope = await resolveTeamActorScope(options.runtime, request.params.runId, projects);
    if (scope.kind !== "coordinator") {
      throw Object.assign(new Error("Only a coordinator Run can create its Team"), {
        statusCode: 409,
      });
    }
    const value = await options.runtime.createTeam(
      scope.coordinatorRunId,
      scope.projectId,
      input,
    );
    const result = await validateTeamMutationResult(
      options.runtime,
      projects,
      scope,
      input.command_id,
      value,
    );
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/team/mailbox/send",
    async (request, reply) => {
      const input = TeamMailboxSendRequestSchema.parse(request.body);
      assertCommandId(request, input.command_id);
      const scope = await resolveTeamActorScope(options.runtime, request.params.runId, projects);
      const value = scope.kind === "member"
        ? await options.runtime.sendTeamMailboxAsMember(
          scope.coordinatorRunId,
          scope.projectId,
          scope.subagentId,
          input,
        )
        : await options.runtime.sendTeamMailbox(
          scope.coordinatorRunId,
          scope.projectId,
          input,
        );
      const result = await validateTeamMutationResult(
        options.runtime,
        projects,
        scope,
        input.command_id,
        value,
      );
      reply.header("cache-control", "private, no-store");
      return result;
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/team/mailbox/claim",
    async (request, reply) => {
      const input = TeamMailboxClaimRequestSchema.parse(request.body);
      assertCommandId(request, input.command_id);
      const scope = await resolveTeamActorScope(options.runtime, request.params.runId, projects);
      const value = scope.kind === "member"
        ? await options.runtime.claimTeamMailboxAsMember(
          scope.coordinatorRunId,
          scope.projectId,
          scope.subagentId,
          input,
        )
        : await options.runtime.claimTeamMailbox(
          scope.coordinatorRunId,
          scope.projectId,
          input,
        );
      const result = await validateTeamMutationResult(
        options.runtime,
        projects,
        scope,
        input.command_id,
        value,
      );
      reply.header("cache-control", "private, no-store");
      return result;
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/team/tasks/write",
    async (request, reply) => {
      const input = TeamTaskWriteRequestSchema.parse(request.body);
      assertCommandId(request, input.command_id);
      const scope = await resolveTeamActorScope(options.runtime, request.params.runId, projects);
      const value = scope.kind === "member"
        ? await options.runtime.writeTeamTaskAsMember(
          scope.coordinatorRunId,
          scope.projectId,
          scope.subagentId,
          input,
        )
        : await options.runtime.writeTeamTask(
          scope.coordinatorRunId,
          scope.projectId,
          input,
        );
      const result = await validateTeamMutationResult(
        options.runtime,
        projects,
        scope,
        input.command_id,
        value,
      );
      reply.header("cache-control", "private, no-store");
      return result;
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/team/heartbeat",
    async (request, reply) => {
      const input = TeamHeartbeatRequestSchema.parse(request.body);
      assertCommandId(request, input.command_id);
      const scope = await resolveTeamActorScope(options.runtime, request.params.runId, projects);
      if (scope.kind !== "member") {
        throw Object.assign(new Error("Only a Team member Run can record a heartbeat"), {
          statusCode: 409,
        });
      }
      const value = await options.runtime.heartbeatTeamMember(
        scope.coordinatorRunId,
        scope.projectId,
        scope.subagentId,
        input,
      );
      const result = await validateTeamMutationResult(
        options.runtime,
        projects,
        scope,
        input.command_id,
        value,
      );
      reply.header("cache-control", "private, no-store");
      return result;
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/team/sweep",
    async (request, reply) => {
      const input = TeamSweepLostMembersRequestSchema.parse(request.body);
      assertCommandId(request, input.command_id);
      const scope = await resolveTeamActorScope(options.runtime, request.params.runId, projects);
      if (scope.kind !== "coordinator") {
        throw Object.assign(new Error("Only a coordinator Run can sweep lost Team members"), {
          statusCode: 409,
        });
      }
      const value = await options.runtime.expireTeamMembers(
        scope.coordinatorRunId,
        scope.projectId,
        input,
      );
      const result = await validateTeamMutationResult(
        options.runtime,
        projects,
        scope,
        input.command_id,
        value,
      );
      reply.header("cache-control", "private, no-store");
      return result;
    },
  );

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/todos", async (request, reply) => {
    const runId = IdentifierSchema.parse(request.params.runId);
    const projection = RunProjectionSchema.parse(await options.runtime.getProjection(runId));
    assertRegisteredProject(projection.project_id, projects);
    const todos = TodoListSchema.parse(await options.runtime.readTodos(runId, projection.project_id));
    reply.header("cache-control", "private, no-store");
    return todos;
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/todos", async (request, reply) => {
    const runId = IdentifierSchema.parse(request.params.runId);
    const wireInput = TodoWriteRequestSchema.parse(request.body);
    assertCommandId(request, wireInput.command_id);
    const projection = RunProjectionSchema.parse(await options.runtime.getProjection(runId));
    assertRegisteredProject(projection.project_id, projects);
    const result = TodoMutationResultSchema.parse(await options.runtime.writeTodo({
      command_id: wireInput.command_id,
      project_id: projection.project_id,
      run_id: runId,
      updated_by: "user",
      input: wireInput.input,
    }));
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/input", async (request, reply) => {
    const runId = IdentifierSchema.parse(request.params.runId);
    const wireInput = SubmitUserInputRequestSchema.parse(request.body);
    assertCommandId(request, wireInput.command_id);
    const current = RunProjectionSchema.parse(await options.runtime.getProjection(runId));
    assertRegisteredProject(current.project_id, projects);
    const command = SubmitUserInputCommandSchema.parse({
      type: "submit_user_input",
      command_id: wireInput.command_id,
      input_id: wireInput.input_id,
      project_id: current.project_id,
      run_id: runId,
      kind: wireInput.kind,
      body: wireInput.body,
      actor: "user",
    });
    const result = SubmitUserInputResultSchema.parse(
      await options.runtime.submitUserInput(command),
    );
    if (
      result.input.run_id !== runId
      || result.input.input_id !== wireInput.input_id
      || result.input.kind !== wireInput.kind
      || result.input.actor !== "user"
    ) {
      throw new Error("Runtime returned a steering input result with mismatched identity");
    }
    reply.header("cache-control", "private, no-store");
    return result;
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/plan/approve", async (request) => {
    const runId = IdentifierSchema.parse(request.params.runId);
    const wireInput = ApprovePlanRequestSchema.parse(request.body);
    assertCommandId(request, wireInput.command_id);
    const current = RunProjectionSchema.parse(await options.runtime.getProjection(runId));
    assertRegisteredProject(current.project_id, projects);
    await runSessionController.assertRunAdmission(current.project_id,current.session_id,current.run_id);
    await options.beforeRunApproval?.(current);
    const command = ApprovePlanCommandSchema.parse({
      type: "approve_plan",
      command_id: wireInput.command_id,
      project_id: current.project_id,
      run_id: runId,
      plan_event_id: wireInput.plan_event_id,
    });
    const projection = RunProjectionSchema.parse(await options.runtime.approvePlan(command));
    if (projection.run_id !== runId || projection.project_id !== current.project_id) {
      throw new Error("Runtime returned a plan approval projection with mismatched identity");
    }
    runSessionController.activateRunProjection(projection);
    return projection;
  });

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/approve",
    async (request) => {
      const command = ApprovalCommandSchema.parse(request.body);
      assertRunId(request.params.runId, command.run_id);
      assertCommandId(request, command.command_id);
      assertRegisteredProject(command.project_id, projects);
      const current=RunProjectionSchema.parse(await options.runtime.getProjection(command.run_id));
      if(current.project_id!==command.project_id)throw new RunSessionControllerError(409,"run_project_mismatch","Approval must belong to the registered Run project");
      await options.beforeRunApproval?.(current);
      const projection = RunProjectionSchema.parse(await options.runtime.approve(command));
      runSessionController.observeRunProjection(projection);
      return projection;
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/reject",
    async (request) => {
      const command = ApprovalCommandSchema.parse(request.body);
      assertRunId(request.params.runId, command.run_id);
      assertCommandId(request, command.command_id);
      assertRegisteredProject(command.project_id, projects);
      const projection = RunProjectionSchema.parse(await options.runtime.reject(command));
      runSessionController.observeRunProjection(projection);
      return projection;
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/stop",
    async (request) => {
      const command = StopRunCommandSchema.parse(request.body);
      assertRunId(request.params.runId, command.run_id);
      assertCommandId(request, command.command_id);
      assertRegisteredProject(command.project_id, projects);
      const projection = RunProjectionSchema.parse(await options.runtime.stop(command));
      runSessionController.observeRunProjection(projection);
      return projection;
    },
  );

  app.post<{ Params: { runId: string; actionId: string } }>(
    "/api/runs/:runId/actions/:actionId/rollback",
    async (request) => runSessionController.withSerializedRunOperation(async () => {
      const runId = IdentifierSchema.parse(request.params.runId);
      const actionId = IdentifierSchema.parse(request.params.actionId);
      const input = RollbackActionRequestSchema.parse(request.body);
      assertCommandId(request, input.command_id);

      // Resolve project authority from the canonical Run. The wire request
      // deliberately cannot select a project or workspace capability.
      const current = RunProjectionSchema.parse(await options.runtime.getProjection(runId));
      assertRegisteredProject(current.project_id, projects);
      const active = await runSessionController.getActiveRunProjections();
      if (active.some(run=>projects.get(run.project_id)?.workspace.real_root===projects.get(current.project_id)?.workspace.real_root)) {
        throw Object.assign(new Error("Stop the active run before rolling back an action in its workspace"), {
          statusCode: 409,
        });
      }
      const project = projects.get(current.project_id);
      if (project === undefined) {
        throw new Error("Registered rollback project disappeared during request handling");
      }
      const inputWithWorkspace = RollbackActionInputSchema.parse({
        type: "rollback_action",
        command_id: input.command_id,
        project_id: current.project_id,
        run_id: runId,
        action_id: actionId,
        force: input.force,
        workspace: project.workspace,
      });
      const projection = RunProjectionSchema.parse(options.withWorkspaceWrite ? await options.withWorkspaceWrite(project.workspace,input.command_id,()=>options.runtime.rollback(inputWithWorkspace)) : await options.runtime.rollback(inputWithWorkspace));
      if (projection.run_id !== runId || projection.project_id !== current.project_id) {
        throw new Error("Runtime returned a rollback projection with mismatched identity");
      }
      return projection;
    }),
  );

  app.get<{
    Params: { artifactId: string };
    Querystring: { run_id?: string };
  }>("/api/artifacts/:artifactId", async (request, reply) => {
    const runId = request.query.run_id;
    if (!runId) return reply.status(400).send({ error: "run_id_required" });
    const principal = capabilityForRequest(request);
    let projectId: string;
    if (principal.kind === "replay") {
      if (runId !== principal.claims.runId) {
        throw new HostCapabilityError(
          403,
          "replay_scope_mismatch",
          "Artifact Run is outside this replay capability",
        );
      }
      if (!principal.claims.artifactIds.has(request.params.artifactId)) {
        throw new HostCapabilityError(
          403,
          "replay_artifact_out_of_scope",
          "Artifact is not present in the selected replay prefix",
        );
      }
      projectId = principal.claims.projectId;
    } else {
      const projection = await options.runtime.getProjection(runId);
      assertRegisteredProject(projection.project_id, projects);
      projectId = projection.project_id;
    }
    const result = await options.runtime.getArtifact({
      artifactId: request.params.artifactId,
      runId,
      projectId,
    });
    reply.header("cache-control", "private, no-store");
    const wireResult = ArtifactWireResponseSchema.parse(result);
    if (principal.kind === "replay") {
      const returnedArtifactId = wireResult.status === "available"
        ? wireResult.artifact.artifact_id
        : wireResult.artifact_id;
      if (returnedArtifactId !== request.params.artifactId) {
        throw new Error("Runtime returned a different replay Artifact");
      }
      if (
        wireResult.status === "available"
        && (
          wireResult.artifact.project_id !== principal.claims.projectId
          || wireResult.artifact.run_id !== principal.claims.runId
        )
      ) {
        throw new Error("Runtime returned a replay Artifact outside the authorized scope");
      }
    }
    return wireResult;
  });

  app.get<{
    Params: { runId: string };
    Querystring: { after_sequence?: string };
  }>("/api/runs/:runId/live/stream", async (request, reply) => {
    const afterSequence = parseAfterSequence(request.query.after_sequence);
    const buffered: LivePublicActivity[] = [];
    let live = false;
    let write: ((activity: LivePublicActivity) => void) | undefined;
    const livePlanBoundaryIds = new Set<string>();
    // Subscribe before the projection/access check. The small runtime buffer
    // below then closes the start-run -> attach-stream race without making a
    // second durable event ledger or replaying provider output.
    const unsubscribe = options.runtime.subscribeLive(request.params.runId, (activity) => {
      if (activity.source_event_type === "plan.ready") {
        livePlanBoundaryIds.add(activity.source_event_id);
      }
      if (!live || write === undefined) buffered.push(activity);
      else write(activity);
    });
    let projection;
    let initial: readonly LivePublicActivity[];
    try {
      projection = RunProjectionSchema.parse(
        await options.runtime.getProjection(request.params.runId),
      );
      assertRegisteredProject(projection.project_id, projects);
      initial = options.runtime.listLiveActivities(request.params.runId, afterSequence);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    reply.hijack();
    const response = reply.raw;
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();

    let lastSequence = afterSequence;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      unsubscribe();
      if (!response.destroyed) response.end();
    };
    write = (activity: LivePublicActivity): void => {
      if (closed || activity.sequence <= lastSequence || response.destroyed) return;
      const safeActivity = LivePublicActivitySchema.parse(activity);
      lastSequence = safeActivity.sequence;
      response.write(`id: ${safeActivity.activity_id}\n`);
      response.write(`data: ${JSON.stringify(safeActivity)}\n\n`);
      // A plan-ready boundary pauses execution until an explicit command;
      // terminal activities end it. In both cases this wait is complete, while
      // the durable Run remains active during plan approval.
      const isCurrentPlanBoundary = safeActivity.source_event_type === "plan.ready"
        && (
          projection.pending_plan?.plan_event_id === safeActivity.source_event_id
          || livePlanBoundaryIds.has(safeActivity.source_event_id)
        );
      if (isCurrentPlanBoundary || isTerminalLiveWaitBoundary(safeActivity)) close();
    };

    request.raw.once("close", close);
    for (const activity of initial) {
      write(activity);
      if (closed) break;
    }
    live = !closed;
    for (const activity of buffered) {
      write(activity);
      if (closed) break;
    }
    buffered.length = 0;
    if (!closed) {
      heartbeat = setInterval(() => {
        if (!response.destroyed) response.write(": heartbeat\n\n");
      }, 15_000);
    }
  });

  /**
   * A separate, volatile model surface. It uses a cursor unrelated to the
   * JSONL ledger sequence so a high-frequency public text stream can neither
   * reorder nor suppress durable runtime events.
   */
  app.get<{
    Params: { runId: string };
    Querystring: { after_cursor?: string };
  }>("/api/runs/:runId/model-surface/stream", async (request, reply) => {
    const afterCursor = parseAfterSequence(request.query.after_cursor);
    const buffered: ModelSurfaceEvent[] = [];
    let live = false;
    let closed = false;
    let terminalReached = false;
    let write: ((event: ModelSurfaceEvent) => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let close = (): void => {};

    const unsubscribeSurface = options.runtime.subscribeModelSurface(request.params.runId, (event) => {
      if (!live || write === undefined) buffered.push(event);
      else write(event);
    });
    const unsubscribeRun = options.runtime.subscribe(request.params.runId, (event) => {
      if (
        event.type === "plan.ready"
        || event.type === "run.completed"
        || event.type === "run.failed"
        || event.type === "run.cancelled"
        || event.type === "run.interrupted"
        || event.type === "action.diverged"
      ) {
        terminalReached = true;
        if (live) close();
      }
    });

    let projection;
    let initial: readonly ModelSurfaceEvent[];
    try {
      projection = RunProjectionSchema.parse(await options.runtime.getProjection(request.params.runId));
      assertRegisteredProject(projection.project_id, projects);
      initial = options.runtime.listModelSurface(request.params.runId, afterCursor);
      terminalReached ||= projection.status === "awaiting_plan_approval" || isTerminalStatus(projection.status);
    } catch (error) {
      unsubscribeSurface();
      unsubscribeRun();
      throw error;
    }

    reply.hijack();
    const response = reply.raw;
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();

    let lastCursor = afterCursor;
    close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      unsubscribeSurface();
      unsubscribeRun();
      if (!response.destroyed) response.end();
    };
    write = (event: ModelSurfaceEvent): void => {
      if (closed || event.cursor <= lastCursor || response.destroyed) return;
      const safeEvent = ModelSurfaceEventSchema.parse(event);
      lastCursor = safeEvent.cursor;
      response.write(`id: ${safeEvent.surface_event_id}\n`);
      response.write(`data: ${JSON.stringify(safeEvent)}\n\n`);
    };

    request.raw.once("close", close);
    for (const event of initial) write(event);
    live = !closed;
    for (const event of buffered) {
      write(event);
      if (closed) break;
    }
    buffered.length = 0;
    if (terminalReached) {
      close();
      return;
    }
    if (!closed) {
      heartbeat = setInterval(() => {
        if (!response.destroyed) response.write(": heartbeat\n\n");
      }, 15_000);
    }
  });

  app.get<{
    Params: { runId: string };
    Querystring: { after_sequence?: string };
  }>("/api/runs/:runId/events/stream", async (request, reply) => {
    const afterSequence = parseAfterSequence(request.query.after_sequence);
    const buffered: SessionEvent[] = [];
    let live = false;
    let write: ((event: SessionEvent | WireSessionEvent) => void) | undefined;
    const unsubscribe = options.runtime.subscribe(request.params.runId, (event) => {
      if (!live || write === undefined) buffered.push(event);
      else write(event);
    });
    let projection;
    try {
      projection = RunProjectionSchema.parse(
        await options.runtime.getProjection(request.params.runId),
      );
      assertRegisteredProject(projection.project_id, projects);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    reply.hijack();
    const response = reply.raw;
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();

    let lastSequence = afterSequence;
    write = (event: SessionEvent | WireSessionEvent): void => {
      if (event.sequence <= lastSequence || response.destroyed) return;
      const wire = "event_hash" in event
        ? toWireEvent(event)
        : WireSessionEventSchema.parse(event);
      lastSequence = wire.sequence;
      response.write(`id: ${wire.event_id}\n`);
      response.write(`data: ${JSON.stringify(wire)}\n\n`);
    };

    for (const event of projection.timeline) write(event);
    live = true;
    for (const event of buffered) write(event);
    buffered.length = 0;
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!response.destroyed) response.end();
    });
  });

  return {
    app,
    runSessions: runSessionController,
    registerProject(project) {
      const previous = projects.get(project.workspace.project_id);
      if (previous && previous.workspace.real_root !== project.workspace.real_root) throw Object.assign(new Error("Project identity conflict"),{statusCode:409});
      projects.set(project.workspace.project_id,project);
      visibleProjects.set(project.workspace.project_id,project);
    },
    unregisterProject(projectId){visibleProjects.delete(projectId);projects.delete(projectId);},
    getRegisteredProject: (projectId) => projects.get(projectId),
    listRegisteredProjects: () => [...visibleProjects.values()],
    get token() {
      return token;
    },
    get expiresAt() {
      return expiresAt;
    },
    async listen(listenOptions = {}) {
      const address = await app.listen({
        port: listenOptions.port ?? 4311,
        host: listenOptions.host ?? "127.0.0.1",
      });
      // Installed Web uses the owner's dynamic loopback gateway as its origin.
      if (new URL(address).hostname === "127.0.0.1") allowedOrigins.add(address);
      return address;
    },
    async close() {
      app.server.closeAllConnections();
      await app.close();
      await options.runtime.shutdownBackgroundWork?.();
    },
  };
}

function redactHostLogLine(line: string): string {
  const hasTrailingNewline = line.endsWith("\n");
  try {
    const parsed = JSON.parse(line) as unknown;
    const safe = redactStructuredArtifactValue(parsed);
    return `${JSON.stringify(safe)}${hasTrailingNewline ? "\n" : ""}`;
  } catch {
    // Retain a valid fallback for non-JSON/custom logger lines.
    return redactSecrets(line);
  }
}

function parsePublicModelConfigResponse(value: unknown): PublicModelConfigResponse {
  const parsed = PublicModelConfigResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Model settings returned an invalid public response");
  }
  return parsed.data;
}

function parsePermissionSettingsResponse(value: unknown): PermissionSettingsResponse {
  const parsed = PermissionSettingsResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Permission settings returned an invalid public response");
  }
  return parsed.data;
}

function parseTelemetryStatus(value: unknown): TelemetryStatus {
  const parsed = TelemetryStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Telemetry status returned an invalid public response");
  }
  return parsed.data;
}

function parseExtensionStatuses(value: unknown): readonly ExtensionStatus[] {
  const parsed = ExtensionStatusSchema.array().max(64).safeParse(value);
  if (!parsed.success) {
    throw new Error("Extension manager returned an invalid status list");
  }
  return parsed.data;
}

function parseExtensionStatus(value: unknown): ExtensionStatus {
  const parsed = ExtensionStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Extension manager returned an invalid status");
  }
  return parsed.data;
}

function parseExtensionCommandResult(value: unknown): ExtensionCommandResult {
  const parsed = ExtensionCommandResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Extension manager returned an invalid command result");
  }
  return parsed.data;
}

function parseMcpStatusSnapshot(value: unknown): McpStatusSnapshot {
  const parsed = McpStatusSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("MCP manager returned an invalid status snapshot");
  }
  return parsed.data;
}

function parseMcpServerStatus(value: unknown): McpServerStatus {
  const parsed = McpServerStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("MCP manager returned an invalid server status");
  }
  return parsed.data;
}

function parseLspStatusSnapshot(value: unknown): LspStatusSnapshot {
  const parsed = LspStatusSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("LSP manager returned an invalid status snapshot");
  }
  return parsed.data;
}

function rememberBoundedCommand<T>(
  commands: Map<string, T>,
  commandId: string,
  value: T,
): void {
  commands.set(commandId, value);
  while (commands.size > 1_024) {
    const oldest = commands.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    commands.delete(oldest);
  }
}

function assertLoopback(request: FastifyRequest): void {
  const address = request.ip.replace(/^::ffff:/, "");
  if (address !== "127.0.0.1" && address !== "::1") {
    throw Object.assign(new Error("Outlive Agent only accepts loopback clients"), {
      statusCode: 403,
    });
  }
}

function assertOrigin(request: FastifyRequest, allowedOrigins: Set<string>): void {
  // Browsers omit Origin on same-origin GETs. Accept only browser fetch
  // provenance plus the exact known loopback Host; missing provenance grants
  // nothing, and an explicit foreign Origin never falls through this branch.
  const browserSameOrigin = !request.headers.origin && request.headers["sec-fetch-site"] === "same-origin" && ["cors","same-origin"].includes(String(request.headers["sec-fetch-mode"]));
  const origin = request.headers.origin ?? (browserSameOrigin ? `http://${request.headers.host}` : undefined);
  if (!origin || !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("Origin is required and must be allowed"), {
      statusCode: 403,
    });
  }
}

function readBearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) {
    throw new HostCapabilityError(401, "capability_required", "Capability token required");
  }
  const token = value.slice(7);
  if (token.length === 0) {
    throw new HostCapabilityError(401, "capability_required", "Capability token required");
  }
  return token;
}

function tokensEqual(receivedToken: string, expectedToken: string): boolean {
  const received = Buffer.from(receivedToken);
  const expected = Buffer.from(expectedToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function digestCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isReplayCapabilityRoute(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  return (request.method === "POST" && route === "/api/replay")
    || (request.method === "GET" && route === "/api/replay/diff")
    || (request.method === "GET" && route === "/api/artifacts/:artifactId");
}

class HostCapabilityError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HostCapabilityError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function assertCommandId(request: FastifyRequest, commandId: string): void {
  const header = request.headers["x-tracegraph-command-id"];
  if (typeof header !== "string" || header !== commandId) {
    throw Object.assign(new Error("Command id header must match the command body"), {
      statusCode: 409,
    });
  }
}

function assertRunId(pathRunId: string, commandRunId: string): void {
  if (pathRunId !== commandRunId) {
    throw Object.assign(new Error("Run id path and command body do not match"), {
      statusCode: 409,
    });
  }
}

function parseAfterSequence(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error("after_sequence must be a non-negative integer"), {
      statusCode: 400,
    });
  }
  return parsed;
}

function isTerminalStatus(status: string): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted"
    || status === "needs_manual_review";
}

function isTerminalLiveWaitBoundary(activity: LivePublicActivity): boolean {
  return activity.source_event_type === "run.completed"
    || activity.source_event_type === "run.failed"
    || activity.source_event_type === "run.cancelled"
    || activity.source_event_type === "run.interrupted"
    || activity.source_event_type === "action.diverged";
}

function toProjectSummary(project: RegisteredProject): ProjectSummary {
  return ProjectSummarySchema.parse({
    project_id: project.workspace.project_id,
    label: project.label,
    workspace_kind: project.workspace.workspace_kind,
    capabilities: project.workspace.capabilities,
    ...(project.location === undefined ? {} : { location: project.location }),
  });
}

function assertRegisteredProject(
  projectId: string,
  projects: ReadonlyMap<string, unknown>,
): void {
  if (!projects.has(projectId)) {
    throw Object.assign(new Error("Run is unavailable outside a registered project"), {
      statusCode: 404,
    });
  }
}

type TeamActorScope =
  | {
      readonly kind: "coordinator";
      readonly actor: RunProjection;
      readonly coordinator: RunProjection;
      readonly actorRunId: string;
      readonly coordinatorRunId: string;
      readonly projectId: string;
    }
  | {
      readonly kind: "member";
      readonly actor: RunProjection;
      readonly coordinator: RunProjection;
      readonly actorRunId: string;
      readonly coordinatorRunId: string;
      readonly projectId: string;
      readonly subagentId: string;
    };

/**
 * Resolve team authority only from canonical Run provenance. The route path
 * chooses a Run, never an actor, project, team, or mailbox identity.
 */
async function resolveTeamActorScope(
  runtime: AgentRuntime,
  actorRunIdValue: string,
  projects: ReadonlyMap<string, unknown>,
): Promise<TeamActorScope> {
  const actorRunId = IdentifierSchema.parse(actorRunIdValue);
  const actor = RunProjectionSchema.parse(await runtime.getProjection(actorRunId));
  if (actor.run_id !== actorRunId) {
    throw new Error("Runtime returned a different team actor Run");
  }
  assertRegisteredProject(actor.project_id, projects);
  const created = actor.timeline[0];
  if (
    created?.type !== "run.created"
    || created.run_id !== actor.run_id
    || created.project_id !== actor.project_id
    || created.session_id !== actor.session_id
  ) {
    throw new Error("Runtime returned a team actor Run without canonical creation provenance");
  }

  const rawParentRunId = created.data.parent_run_id;
  const rawParentSessionId = created.data.parent_session_id;
  const rawSubagentId = created.data.subagent_id;
  if (
    rawParentRunId === undefined
    && rawParentSessionId === undefined
    && rawSubagentId === undefined
  ) {
    return {
      kind: "coordinator",
      actor,
      coordinator: actor,
      actorRunId,
      coordinatorRunId: actorRunId,
      projectId: actor.project_id,
    };
  }
  if (
    typeof rawParentRunId !== "string"
    || typeof rawParentSessionId !== "string"
    || typeof rawSubagentId !== "string"
  ) {
    throw new Error("Runtime returned incomplete child Run provenance for team authority");
  }
  const coordinatorRunId = IdentifierSchema.parse(rawParentRunId);
  const parentSessionId = IdentifierSchema.parse(rawParentSessionId);
  const subagentId = IdentifierSchema.parse(rawSubagentId);
  const coordinator = RunProjectionSchema.parse(
    await runtime.getProjection(coordinatorRunId),
  );
  if (
    coordinator.run_id !== coordinatorRunId
    || coordinator.project_id !== actor.project_id
    || coordinator.session_id !== parentSessionId
  ) {
    throw new Error("Runtime returned a coordinator outside the child Run relation");
  }
  assertRegisteredProject(coordinator.project_id, projects);
  const delegated = coordinator.subagents.items.find(
    ({ link }) => link.subagent_id === subagentId,
  );
  if (
    delegated === undefined
    || delegated.link.parent_run_id !== coordinatorRunId
    || delegated.link.parent_session_id !== parentSessionId
    || delegated.link.child_run_id !== actor.run_id
    || delegated.link.child_session_id !== actor.session_id
  ) {
    throw new Error("Runtime returned a child Run outside the delegated team relation");
  }
  return {
    kind: "member",
    actor,
    coordinator,
    actorRunId,
    coordinatorRunId,
    projectId: actor.project_id,
    subagentId,
  };
}

function assertTeamProjectionRelation(
  teamValue: TeamProjection,
  coordinator: RunProjection,
): void {
  const team = TeamProjectionSchema.parse(teamValue);
  if (team.coordinator_run_id !== coordinator.run_id) {
    throw new Error("Runtime returned a Team outside the coordinator Run");
  }
  for (const member of team.roster.members) {
    const delegated = coordinator.subagents.items.find(
      ({ link }) => link.subagent_id === member.link.subagent_id,
    );
    if (
      delegated === undefined
      || member.link.parent_run_id !== coordinator.run_id
      || member.link.parent_session_id !== coordinator.session_id
      || member.link.child_run_id !== delegated.link.child_run_id
      || member.link.child_session_id !== delegated.link.child_session_id
    ) {
      throw new Error("Runtime returned a Team member outside the delegated Run relation");
    }
  }
}

async function validateTeamMutationResult(
  runtime: AgentRuntime,
  projects: ReadonlyMap<string, unknown>,
  scope: TeamActorScope,
  commandId: string,
  value: unknown,
): Promise<TeamMutationResult> {
  const result = TeamMutationResultSchema.parse(value);
  if (result.command_id !== commandId) {
    throw new Error("Runtime returned a Team result for a different command");
  }
  const coordinator = RunProjectionSchema.parse(
    await runtime.getProjection(scope.coordinatorRunId),
  );
  if (
    coordinator.run_id !== scope.coordinatorRunId
    || coordinator.project_id !== scope.projectId
  ) {
    throw new Error("Runtime changed Team coordinator identity during mutation");
  }
  assertRegisteredProject(coordinator.project_id, projects);
  assertTeamProjectionRelation(result.team, coordinator);
  return result;
}

function resolveAttachmentProject(
  upload: AttachmentUploadRequest,
  visibleProjects: ReadonlyMap<string, RegisteredProject>,
  chatProject: RegisteredProject | undefined,
): RegisteredProject {
  if (upload.target === "chat") {
    if (chatProject === undefined) {
      throw Object.assign(new Error("This Host has no isolated chat workspace"), {
        statusCode: 501,
      });
    }
    return chatProject;
  }
  const project = visibleProjects.get(upload.project_id);
  if (project === undefined) {
    // Deliberately use the visible registry: a client cannot address the
    // hidden plain-chat project by guessing its project id.
    throw Object.assign(new Error("Project is not registered by this Host"), {
      statusCode: 404,
    });
  }
  return project;
}

function sha256Bytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireSessionController(
  sessions: HostSessionController | undefined,
): HostSessionController {
  if (sessions === undefined) {
    throw Object.assign(new Error("This Host has no durable session store"), {
      statusCode: 501,
    });
  }
  return sessions;
}

function assertSessionIdentity(sessionId: string, result: SessionReadResult): void {
  if (result.header.session_id !== sessionId) {
    throw new Error("Session controller returned a different session");
  }
}

function sessionControlHttpError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  if (code === "session_not_found") {
    return { statusCode: 404, code, message: "Session was not found" };
  }
  if (code === "session_lease_conflict") {
    return { statusCode: 409, code, message: "Session is being modified by another Host" };
  }
  if (code === "session_version_unsupported") {
    return { statusCode: 409, code, message: "Session format is not supported by this Host" };
  }
  if (code === "session_already_exists") {
    return { statusCode: 409, code, message: "Session already exists" };
  }
  if (code === "session_corrupt") {
    return { statusCode: 409, code, message: "Session data failed integrity validation" };
  }
  if (code === "session_path_unsafe") {
    return { statusCode: 400, code, message: "Session identifier is unsafe" };
  }
  if (code === "session_cursor_invalid") {
    return { statusCode: 400, code, message: "Session cursor is invalid" };
  }
  return undefined;
}

function teamControlHttpError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  if (typeof code !== "string") return undefined;
  if ([
    "run_not_found",
    "team_not_found",
    "member_not_found",
    "mailbox_message_not_found",
    "task_not_found",
  ].includes(code)) {
    return { statusCode: 404, code, message: "The requested Team resource was not found" };
  }
  if (code === "authority_denied") {
    return { statusCode: 403, code, message: "This Team actor is not authorized for the operation" };
  }
  if ([
    "run_scope_mismatch",
    "run_terminal",
    "team_already_exists",
    "team_required_root_run",
    "team_capacity_exceeded",
    "member_already_joined",
    "member_not_active",
    "member_join_proof_missing",
    "member_join_proof_invalid",
    "heartbeat_not_advanced",
    "heartbeat_not_expired",
    "mailbox_capacity_exceeded",
    "mailbox_message_already_exists",
    "mailbox_message_already_claimed",
    "mailbox_recipient_invalid",
    "task_capacity_exceeded",
    "task_already_exists",
    "task_version_conflict",
    "task_state_conflict",
    "task_owner_conflict",
    "task_evidence_invalid",
    "idempotency_conflict",
    "invalid_team_event",
  ].includes(code)) {
    return { statusCode: 409, code, message: "The Team operation conflicts with canonical state" };
  }
  return undefined;
}

function replayControlHttpError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} | undefined {
  if (!(error instanceof ReplayError)) return undefined;
  const code = error.code;
  if (code === "run_not_found") {
    return { statusCode: 404, code, message: "Replay Run was not found" };
  }
  if (code === "replay_scope_mismatch") {
    return { statusCode: 409, code, message: "Replay scope does not match the canonical Run" };
  }
  if (code === "replay_sequence_out_of_range") {
    return { statusCode: 409, code, message: "Replay sequence is outside the canonical Run" };
  }
  return undefined;
}

export function sendSseError(reply: FastifyReply, message: string): void {
  if (!reply.raw.destroyed) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
  }
}
