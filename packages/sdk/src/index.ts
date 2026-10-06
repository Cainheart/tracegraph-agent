import { projectSessionPublicChat, type PublicChatBlock } from "@tracegraph/contracts";
import {VisualRetentionSettingsSchema,VisualRetentionUpdateSchema,VisualEvidenceQuerySchema,VisualEvidenceInventorySchema,VisualEvidencePinSchema,VisualEvidenceEntrySchema,VisualEvidenceCleanupRequestSchema,VisualEvidenceCleanupResultSchema,VisualEvidenceCommandReceiptSchema,type VisualRetentionUpdate,type VisualEvidenceQuery,type VisualEvidencePin,type VisualEvidenceCleanupRequest} from "@tracegraph/contracts";
import {GoalCreationReceiptSchema} from "@tracegraph/contracts";
import {IdentifierSchema,PersonalProfileSnapshotSchema,PersonalProfileUpdateRequestSchema,PersonalProfileCommandReceiptSchema,PersonalUsageQuerySchema,PersonalUsageSnapshotSchema,PublicSessionSearchQuerySchema,PublicSessionSearchResultSchema,type PersonalProfileUpdateRequest,type PersonalUsageQuery,type PublicSessionSearchQuery} from "@tracegraph/contracts";
import {ComputerActionRequestSchema,ComputerActionResultSchema,ComputerCaptureContentRequestSchema,ComputerCommandReceiptSchema,ComputerGrantRequestSchema,ComputerGrantSchema,ComputerLeaseReleaseRequestSchema,ComputerLeaseRequestSchema,ComputerLeaseResumeRequestSchema,ComputerLeaseSchema,ComputerObservationSchema,ComputerObserveRequestSchema,ComputerRevokeGrantRequestSchema,ComputerStatusSchema,ComputerTargetSchema,type ComputerActionRequest,type ComputerCaptureContentRequest,type ComputerGrantRequest,type ComputerLeaseReleaseRequest,type ComputerLeaseRequest,type ComputerLeaseResumeRequest,type ComputerObserveRequest,type ComputerRevokeGrantRequest} from "@tracegraph/contracts";
import {WorkbenchSettingsHistorySchema,RestoreWorkbenchSettingsRequestSchema,RestoreWorkbenchSettingsResultSchema,ProjectRunDefaultsSnapshotSchema,ProjectRunDefaultsUpdateRequestSchema,SessionRunOptionsResetRequestSchema,type RestoreWorkbenchSettingsRequest,type ProjectRunDefaultsUpdateRequest,type SessionRunOptionsResetRequest} from "@tracegraph/contracts";
import {ModelConnectionsSnapshotSchema,ModelConnectionSaveRequestSchema,ModelConnectionRemoveRequestSchema,ModelCatalogDiscoveryRequestSchema,ModelCatalogDiscoveryResultSchema,SessionRunOptionsSnapshotSchema,SessionRunOptionsUpdateRequestSchema,PermissionGrantSchema,PermissionGrantUpdateRequestSchema,type ModelConnectionSaveRequest,type ModelConnectionRemoveRequest,type ModelCatalogDiscoveryRequest,type SessionRunOptionsUpdateRequest,type PermissionGrantUpdateRequest} from "@tracegraph/contracts";
import {ImageProviderConfigUpdateSchema,ImageProviderConfigSnapshotSchema,StartMediaRunRequestSchema,MediaMimeTypeSchema,MAX_GENERATED_IMAGE_BYTES,type ImageProviderConfigUpdate,type ImageProviderConfigSnapshot,type StartMediaRunRequest,type MediaMimeType} from "@tracegraph/contracts";
import {ProjectFileListRequestSchema,ProjectFileReadRequestSchema,ProjectFileSaveRequestSchema,ProjectFileReconcileRequestSchema,ProjectFileListSchema,ProjectFileSnapshotSchema,ProjectFileSaveResultSchema,AnswerFeedbackRequestSchema,AnswerFeedbackSnapshotSchema,type ProjectFileListRequest,type ProjectFileReadRequest,type ProjectFileSaveRequest,type ProjectFileReconcileRequest,type ProjectFileList,type ProjectFileSnapshot,type ProjectFileSaveResult,type AnswerFeedbackRequest,type AnswerFeedbackSnapshot} from "@tracegraph/contracts";
import {verifyProjectFileSnapshot,verifyProjectFileSaveResult} from "./project-file-integrity.js";
import {
  ApprovalCommandSchema,
  ApprovePlanRequestSchema,
  AttachmentMediaTypeSchema,
  AttachmentStageReceiptSchema,
  AttachmentUploadRequestSchema,
  ArtifactWireResponseSchema,
  ExtensionCommandInvocationSchema,
  ExtensionCommandResultSchema,
  ExtensionReloadCommandSchema,
  ExtensionStatusSchema,
  ExperienceControlListResponseSchema,
  ExperienceLifecycleReviewRequestSchema,
  ExperienceLifecycleReviewResponseSchema,
  LivePublicActivitySchema,
  MCP_SERVER_NAME_SCHEMA,
  McpRestartRequestSchema,
  McpServerStatusSchema,
  McpStatusSnapshotSchema,
  LspStatusSnapshotSchema,
  ModelConfigUpdateRequestSchema,
  ModelSurfaceEventSchema,
  OpenLocalProjectRequestSchema,
  PermissionPresetUpdateRequestSchema,
  PermissionSettingsResponseSchema,
  ProjectSummarySchema,
  PublicModelConfigResponseSchema,
  RemoveProjectRequestSchema,
  ReplayDiffQuerySchema,
  ReplayDiffSchema,
  ReplaySessionResponseSchema,
  ReplaySnapshotRequestSchema,
  RollbackActionRequestSchema,
  RunProjectionSchema,
  SessionDeleteResponseSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionReadResultSchema,
  SessionRecoveryReportSchema,
  SessionRenameRequestSchema,
  SessionResumeRequestSchema,
  SessionResumeResponseSchema,
  SkillProjectInspectionSchema,
  StartRunRequestSchema,
  StartChatRequestSchema,
  StopRunCommandSchema,
  SubmitUserInputRequestSchema,
  SubmitUserInputResultSchema,
  CreateTeamRequestSchema,
  TeamHeartbeatRequestSchema,
  TeamMailboxClaimRequestSchema,
  TeamMailboxSendRequestSchema,
  TeamMutationResultSchema,
  TeamReadResponseSchema,
  TeamSweepLostMembersRequestSchema,
  TeamTaskWriteRequestSchema,
  TelemetryStatusSchema,
  UsageSnapshotSchema,
  MemoryCandidateCreateRequestSchema,
  MemoryControlItemSchema,
  MemoryControlListResponseSchema,
  MemoryCorrectionRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryDeleteResponseSchema,
  MemoryReviewRequestSchema,
  MemoryRevokeRequestSchema,
  TodoListSchema,
  TodoMutationResultSchema,
  TodoWriteRequestSchema,
  WireSessionEventSchema,
  type ApprovalCommand,
  type ApprovePlanRequest,
  type AttachmentMediaType,
  type AttachmentStageReceipt,
  type AttachmentUploadRequest,
  type ArtifactWireResponse,
  type ExperienceControlListResponse,
  type ExperienceLifecycleReviewRequest,
  type ExperienceLifecycleReviewResponse,
  type ExtensionCommandResult,
  type ExtensionStatus,
  type LivePublicActivity,
  type McpRestartRequest,
  type McpServerStatus,
  type McpStatusSnapshot,
  type LspStatusSnapshot,
  type ModelConfigUpdateRequest,
  type ModelSurfaceEvent,
  type OpenLocalProjectRequest,
  type PermissionPresetUpdateRequest,
  type PermissionSettingsResponse,
  type ProjectSummary,
  type PublicModelConfigResponse,
  type ReplayDiff,
  type ReplaySessionResponse,
  type ReplaySnapshotRequest,
  type RollbackActionRequest,
  type RunProjection,
  type SessionDeleteResponse,
  type SessionListQuery,
  type SessionListResponse,
  type SessionReadResult,
  type SessionRecoveryReport,
  type SessionRenameRequest,
  type SessionResumeRequest,
  type SessionResumeResponse,
  type StartRunRequest,
  type StartChatRequest,
  type StopRunCommand,
  type SubmitUserInputRequest,
  type SubmitUserInputResult,
  type CreateTeamRequest,
  type TeamHeartbeatRequest,
  type TeamMailboxClaimRequest,
  type TeamMailboxSendRequest,
  type TeamMutationResult,
  type TeamReadResponse,
  type TeamSweepLostMembersRequest,
  type TeamTaskWriteRequest,
  type TelemetryStatus,
  type UsageSnapshot,
  type MemoryCandidateCreateRequest,
  type MemoryControlItem,
  type MemoryControlListResponse,
  type MemoryCorrectionRequest,
  type MemoryReviewRequest,
  type MemoryRevokeRequest,
  type TodoList,
  type TodoMutationResult,
  type TodoWriteInput,
  type TodoWriteRequest,
  type WireSessionEvent,
  type SkillProjectInspection,
} from "@tracegraph/contracts";
import { ClientCommandSchema, ClientQuerySchema } from "./protocol/index.js";
import {
  HostCapabilitiesSchema, ModelConnectionTestRequestSchema, ModelConnectionTestResultSchema,
  UpdateWorkbenchSettingsRequestSchema, WorkbenchCommandRequestSchema,
  WorkbenchCommandResultSchema, WorkbenchResourcesSchema, WorkbenchSettingsSnapshotSchema,
  type HostCapabilities, type ModelConnectionTestResult, type UpdateWorkbenchSettingsRequest,
  type WorkbenchCommandRequest, type WorkbenchCommandResult, type WorkbenchResources,
  type WorkbenchSettingsSnapshot,
} from "@tracegraph/contracts";

export type {
  LivePublicActivity,
  ModelProvider,
  ModelProtocol,
  ModelSurfaceEvent,
  ReasoningEffort,
  ReplayDiff,
  ReplaySessionResponse,
  ReplaySnapshotRequest,
  SafeCredentialMetadata,
  SessionDeleteResponse,
  SessionListQuery,
  SessionListResponse,
  SessionReadResult,
  SessionRecoveryReport,
  SessionRenameRequest,
  SessionResumeRequest,
  SessionResumeResponse,
  TodoList,
  TodoMutationResult,
  TodoWriteInput,
  TodoWriteRequest,
  SubmitUserInputRequest,
  SubmitUserInputResult,
  CreateTeamRequest,
  TeamHeartbeatRequest,
  TeamMailboxClaimRequest,
  TeamMailboxSendRequest,
  TeamMutationResult,
  TeamReadResponse,
  TeamSweepLostMembersRequest,
  TeamTaskWriteRequest,
  TelemetryStatus,
  ExtensionCommandResult,
  ExtensionStatus,
  McpRestartRequest,
  McpServerStatus,
  McpStatusSnapshot,
  LspStatusSnapshot,
} from "@tracegraph/contracts";

export interface TraceGraphClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Origin sent by the Node client to the loopback Host. Browsers manage their
   * own Origin header and ignore this option. Set false for a non-Host fetch
   * adapter; custom Host origins must also be present in Host allowedOrigins.
   */
  nodeOrigin?: string | false;
}

export interface StreamOptions {
  afterSequence?: number;
  signal?: AbortSignal;
  reconnect?: boolean;
  minRetryMs?: number;
  maxRetryMs?: number;
}

/** Cursor options for the volatile, model-authored public text stream. */
export interface ModelSurfaceStreamOptions {
  afterCursor?: number;
  signal?: AbortSignal;
  reconnect?: boolean;
  minRetryMs?: number;
  maxRetryMs?: number;
}

export type ModelConfigSnapshot = PublicModelConfigResponse;
export type ConfigureModelInput = ModelConfigUpdateRequest;
export type PermissionConfigSnapshot = PermissionSettingsResponse;
export type ConfigurePermissionPresetInput = PermissionPresetUpdateRequest;
export type TelemetryStatusSnapshot = TelemetryStatus;
export type ExtensionStatusSnapshot = ExtensionStatus;
export type ExtensionCommandResultSnapshot = ExtensionCommandResult;
export type SkillProjectInspectionSnapshot = SkillProjectInspection;
export type McpStatusSnapshotResponse = McpStatusSnapshot;
export type McpServerStatusSnapshot = McpServerStatus;
export type LspStatusSnapshotResponse = LspStatusSnapshot;

type ProjectAttachmentUpload = Extract<AttachmentUploadRequest, { target: "project" }>;
type ChatAttachmentUpload = Extract<AttachmentUploadRequest, { target: "chat" }>;

export type UploadAttachmentInput = (
  | Omit<ProjectAttachmentUpload, "command_id">
  | Omit<ChatAttachmentUpload, "command_id">
) & {
  command_id?: string;
  /** Reusable bytes only; streaming bodies cannot be safely retried after a 401. */
  bytes: Blob | ArrayBuffer | Uint8Array;
};

export interface AttachmentContentResponse {
  attachmentId: string;
  mediaType: AttachmentMediaType;
  sha256: `sha256:${string}`;
  bytes: Uint8Array;
}

export interface ReplayDiffInput {
  from: number;
  to: number;
}

export interface BootstrapSnapshot {
  token: string;
  expiresAt: string;
  recovery?: SessionRecoveryReport;
}

export class TraceGraphHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** The Host's closed auth errors prove rejection before domain admission. */
  readonly admission: "rejected" | undefined;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "TraceGraphHttpError";
    this.status = status;
    this.body = body;
    const code=typeof body==="object"&&body!==null&&"error" in body?body.error:undefined;
    this.admission=status===401&&["capability_required","capability_invalid","capability_expired"].includes(String(code))?"rejected":undefined;
  }
}

/** A failed read-only authority check proves that no domain command was sent. */
export class TraceGraphMutationPreflightError extends Error {
  readonly code="mutation_preflight_failed";
  readonly admission="rejected";
  readonly commandDispatched=false;
  constructor(){super("The connection could not be verified. No command was sent. Repair the connection before retrying.");this.name="TraceGraphMutationPreflightError";}
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/$/, "");
const DEFAULT_NODE_ORIGIN = "http://127.0.0.1:4310";

const createCommandId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const createInputId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `input_${globalThis.crypto.randomUUID()}`;
  }
  return `input_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

export interface ArtifactContentResponse {artifactId:string;mediaType:MediaMimeType;sha256:`sha256:${string}`;bytes:Uint8Array}
export class TraceGraphClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #nodeOrigin: string | undefined;
  #token: string | undefined;
  #tokenRefresh: Promise<BootstrapSnapshot> | null = null;
  #managedLiveAuthority=false;
  #liveTokenBeforeReplay: string | undefined;
  #replayScope: { sessionId: string; runId: string } | undefined;
  #replayGeneration = 0;

  constructor(options: TraceGraphClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:4311");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#nodeOrigin = isBrowserRuntime() || options.nodeOrigin === false
      ? undefined
      : normalizeOrigin(options.nodeOrigin ?? DEFAULT_NODE_ORIGIN);
    this.#token = options.token;
  }

  get token(): string | undefined {
    return this.#token;
  }

  get replayActive(): boolean {
    return this.#replayScope !== undefined;
  }

  async bootstrap(): Promise<BootstrapSnapshot> {
    if (this.#replayScope !== undefined) {
      throw new Error("Exit replay before refreshing the live Host capability");
    }
    if(!this.#tokenRefresh)this.#tokenRefresh=this.#bootstrapLiveAuthority().finally(()=>{this.#tokenRefresh=null;});
    return this.#tokenRefresh;
  }

  async #bootstrapLiveAuthority():Promise<BootstrapSnapshot>{
    const generation=this.#replayGeneration;
    const value = await this.#requestUnknown("/api/bootstrap", { method: "GET",signal:AbortSignal.timeout(10_000) }, false);
    if (
      typeof value !== "object" ||
      value === null ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "string"
    ) {
      throw new TypeError("Invalid bootstrap response");
    }
    const recovery = "recovery" in value && value.recovery !== undefined
      ? SessionRecoveryReportSchema.parse(value.recovery)
      : undefined;
    if(generation!==this.#replayGeneration||this.#replayScope!==undefined)throw new Error("Live capability refresh was superseded by an authority transition");
    this.#token = value.token;
    this.#managedLiveAuthority=true;
    return {
      token: value.token,
      expiresAt: value.expiresAt,
      ...(recovery === undefined ? {} : { recovery }),
    };
  }

  async listProjects(): Promise<readonly ProjectSummary[]> {
    return ProjectSummarySchema.array().parse(
      await this.#requestUnknown("/api/projects"),
    );
  }

  async createProject(input: { name: string; template?: "typescript" }): Promise<ProjectSummary> {
    return ProjectSummarySchema.parse(await this.#command("/api/projects", {
      name: input.name,
      template: input.template ?? "typescript",
    }));
  }

  async openLocalProject(input: {
    access?: OpenLocalProjectRequest["access"];
    command_id?: string;
  } = {}): Promise<ProjectSummary | undefined> {
    const body = OpenLocalProjectRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      access: input.access ?? "read_write",
    });
    const response = await this.#command("/api/projects/open-local", body);
    return response === undefined ? undefined : ProjectSummarySchema.parse(response);
  }

  async revealProject(projectId: string, commandId = createCommandId()): Promise<void> {
    await this.#command(`/api/projects/${encodeURIComponent(projectId)}/reveal`, {
      command_id: commandId,
    });
  }

  async removeProject(projectId: string, commandId = createCommandId()): Promise<void> {
    const body = RemoveProjectRequestSchema.parse({ command_id: commandId });
    await this.#command(`/api/projects/${encodeURIComponent(projectId)}/remove`, body);
  }

  async getImageConfig():Promise<ImageProviderConfigSnapshot>{return ImageProviderConfigSnapshotSchema.parse(await this.#requestUnknown("/api/image-provider"));}
  async listProjectFiles(projectId:string,input:ProjectFileListRequest={}):Promise<ProjectFileList>{const result=ProjectFileListSchema.parse(await this.#command(`/api/workbench/projects/${encodeURIComponent(projectId)}/files/list`,ProjectFileListRequestSchema.parse(input)));if(result.project_id!==projectId||result.path!==(input.path??""))throw new TypeError("Project file listing has a different scope");return result;}
  async readProjectFile(projectId:string,input:ProjectFileReadRequest):Promise<ProjectFileSnapshot>{const parsed=ProjectFileReadRequestSchema.parse(input);return verifyProjectFileSnapshot(ProjectFileSnapshotSchema.parse(await this.#command(`/api/workbench/projects/${encodeURIComponent(projectId)}/files/read`,parsed)),projectId,parsed.path);}
  async saveProjectFile(projectId:string,input:ProjectFileSaveRequest):Promise<ProjectFileSaveResult>{const parsed=ProjectFileSaveRequestSchema.parse(input);return verifyProjectFileSaveResult(ProjectFileSaveResultSchema.parse(await this.#command(`/api/workbench/projects/${encodeURIComponent(projectId)}/files/save`,parsed)),projectId,parsed);}
  async reconcileProjectFileSave(projectId:string,input:ProjectFileReconcileRequest):Promise<ProjectFileSaveResult>{return ProjectFileSaveResultSchema.parse(await this.#command(`/api/workbench/projects/${encodeURIComponent(projectId)}/files/reconcile`,ProjectFileReconcileRequestSchema.parse(input)));}
  async getAnswerFeedback(runId:string):Promise<AnswerFeedbackSnapshot>{const result=AnswerFeedbackSnapshotSchema.parse(await this.#requestUnknown(`/api/workbench/runs/${encodeURIComponent(runId)}/feedback`));if(result.run_id!==runId)throw new TypeError("Feedback response has a different Run scope");return result;}
  async setAnswerFeedback(runId:string,input:AnswerFeedbackRequest):Promise<AnswerFeedbackSnapshot>{const parsed=AnswerFeedbackRequestSchema.parse(input),result=AnswerFeedbackSnapshotSchema.parse(await this.#command(`/api/workbench/runs/${encodeURIComponent(runId)}/feedback`,parsed));if(result.run_id!==runId||result.answer_event_id!==parsed.answer_event_id||result.value!==parsed.value||!result.receipt_event_id)throw new TypeError("Feedback response differs from its bound intent");return result;}
  async configureImageProvider(input:ImageProviderConfigUpdate):Promise<ImageProviderConfigSnapshot>{return ImageProviderConfigSnapshotSchema.parse(await this.#command("/api/image-provider",ImageProviderConfigUpdateSchema.parse(input)));}
  async clearImageProvider():Promise<ImageProviderConfigSnapshot>{return ImageProviderConfigSnapshotSchema.parse(await this.#mutation("/api/image-provider","DELETE"));}
  async startMediaRun(input:StartMediaRunRequest):Promise<RunProjection>{return RunProjectionSchema.parse(await this.#command("/api/media/runs",StartMediaRunRequestSchema.parse(input)));}
  async getArtifactContent(runId:string,artifactId:string):Promise<ArtifactContentResponse>{
    const response=await this.#requestResponse(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/content`,{headers:{accept:"image/png,image/svg+xml,image/jpeg,image/webp"}});
    const mediaType=MediaMimeTypeSchema.parse(response.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase());
    const hash=response.headers.get("x-tracegraph-content-sha256");if(hash===null||!/^sha256:[a-f0-9]{64}$/u.test(hash))throw new TypeError("Binary Artifact has no valid integrity header");
    const reader=response.body?.getReader();if(!reader)throw new TypeError("Binary Artifact has no body");let total=0;const chunks:Uint8Array[]=[];
    try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>MAX_GENERATED_IMAGE_BYTES){await reader.cancel();throw new TypeError("Binary Artifact exceeds the byte limit");}chunks.push(part.value);}}finally{reader.releaseLock();}
    if(!total)throw new TypeError("Binary Artifact was empty");const bytes=new Uint8Array(total);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
    const digest=new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",bytes));const actual="sha256:"+Array.from(digest,byte=>byte.toString(16).padStart(2,"0")).join("");if(actual!==hash)throw new TypeError("Binary Artifact failed SHA-256 verification");
    return {artifactId,mediaType,sha256:hash as `sha256:${string}`,bytes};
  }

  async getModelConfig(): Promise<ModelConfigSnapshot> {
    return PublicModelConfigResponseSchema.parse(
      await this.#requestUnknown("/api/model-config"),
    );
  }

  async getWorkbenchSettings(): Promise<WorkbenchSettingsSnapshot> {
    return WorkbenchSettingsSnapshotSchema.parse(await this.#requestUnknown("/api/workbench/settings"));
  }

  async updateWorkbenchSettings(input: UpdateWorkbenchSettingsRequest): Promise<WorkbenchSettingsSnapshot> {
    return WorkbenchSettingsSnapshotSchema.parse(await this.#command("/api/workbench/settings", UpdateWorkbenchSettingsRequestSchema.parse(input)));
  }

  async getWorkbenchSettingsHistory(){return WorkbenchSettingsHistorySchema.parse(await this.#requestUnknown("/api/workbench/settings/history"));}
  async getBrowserCommandReceipt(id:string){return BrowserCommandReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/browser/commands/${encodeURIComponent(id)}`));}
  async getComputerStatus(){return ComputerStatusSchema.parse(await this.#requestUnknown("/api/workbench/computer"));}
  async listComputerTargets(){return ComputerTargetSchema.array().max(128).parse(await this.#requestUnknown("/api/workbench/computer/targets"));}
  async requestComputerGrant(input:ComputerGrantRequest){return ComputerGrantSchema.parse(await this.#command("/api/workbench/computer/grants",ComputerGrantRequestSchema.parse(input)));}
  async revokeComputerGrant(input:ComputerRevokeGrantRequest){return ComputerGrantSchema.parse(await this.#command("/api/workbench/computer/revoke",ComputerRevokeGrantRequestSchema.parse(input)));}
  async acquireComputerLease(input:ComputerLeaseRequest){return ComputerLeaseSchema.parse(await this.#command("/api/workbench/computer/leases",ComputerLeaseRequestSchema.parse(input)));}
  async resumeComputerLease(input:ComputerLeaseResumeRequest){return ComputerLeaseSchema.parse(await this.#command("/api/workbench/computer/resume",ComputerLeaseResumeRequestSchema.parse(input)));}
  async releaseComputerLease(input:ComputerLeaseReleaseRequest){return ComputerLeaseSchema.parse(await this.#command("/api/workbench/computer/release",ComputerLeaseReleaseRequestSchema.parse(input)));}
  async observeComputer(input:ComputerObserveRequest){return ComputerObservationSchema.parse(await this.#command("/api/workbench/computer/observe",ComputerObserveRequestSchema.parse(input)));}
  async computerAction(input:ComputerActionRequest){return ComputerActionResultSchema.parse(await this.#command("/api/workbench/computer/actions",ComputerActionRequestSchema.parse(input)));}
  async getComputerCommandReceipt(id:string){return ComputerCommandReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/computer/commands/${encodeURIComponent(id)}`));}
  async getComputerCapture(input:ComputerCaptureContentRequest):Promise<{sha256:string;bytes:Uint8Array}>{
    const response=await this.#requestResponse("/api/workbench/computer/capture",{method:"POST",headers:{"content-type":"application/json",accept:"image/png"},body:JSON.stringify(ComputerCaptureContentRequestSchema.parse(input))});
    if(response.headers.get("content-type")?.split(";")[0]!=="image/png")throw new TypeError("Computer capture is not PNG");
    const hash=response.headers.get("x-outlive-content-sha256");if(!hash||!/^sha256:[a-f0-9]{64}$/u.test(hash))throw new TypeError("Computer capture has no integrity header");
    const reader=response.body?.getReader();if(!reader)throw new TypeError("Computer capture has no body");let length=0;const chunks:Uint8Array[]=[];
    try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>16*1024*1024)throw new TypeError("Computer capture exceeds the limit");chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    if(!length)throw new TypeError("Computer capture is empty");const actual="sha256:"+Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");if(actual!==hash)throw new TypeError("Computer capture integrity mismatch");return {sha256:hash,bytes};
  }
  async getBrowserStatus(){return BrowserStatusSchema.parse(await this.#requestUnknown("/api/workbench/browser"));}
  async requestBrowserGrant(input:BrowserGrantRequest){return BrowserGrantSchema.parse(await this.#command("/api/workbench/browser/grants",BrowserGrantRequestSchema.parse(input)));}
  async browserCommand(input:BrowserCommand){return BrowserCommandResultSchema.parse(await this.#command("/api/workbench/browser/commands",BrowserCommandSchema.parse(input)));}
  async observeBrowser(id:string){return BrowserObservationSchema.parse(await this.#command(`/api/workbench/browser/tabs/${encodeURIComponent(id)}/observe`,{}));}
  async getBrowserEvidence(id:string):Promise<{evidenceId:string;sha256:string;bytes:Uint8Array}>{
    const response=await this.#requestResponse(`/api/workbench/browser/evidence/${encodeURIComponent(id)}`,{headers:{accept:"image/png"}});
    if(response.headers.get("content-type")?.split(";")[0]!=="image/png")throw new TypeError("Browser evidence is not PNG");
    const hash=response.headers.get("x-outlive-content-sha256");if(!hash||!/^sha256:[a-f0-9]{64}$/u.test(hash))throw new TypeError("Browser evidence has no integrity header");
    const reader=response.body?.getReader();if(!reader)throw new TypeError("Browser evidence has no body");let length=0;const chunks:Uint8Array[]=[];
    try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>8*1024*1024)throw new TypeError("Browser evidence exceeds the limit");chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    if(!length)throw new TypeError("Browser evidence is empty");const actual="sha256:"+Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");if(actual!==hash)throw new TypeError("Browser evidence integrity mismatch");
    return {evidenceId:id,sha256:hash,bytes};
  }
  async listGoals(){return GoalListResponseSchema.parse(await this.#requestUnknown("/api/workbench/goals"));}
  async createGoal(input:GoalCreateRequest){return GoalSnapshotSchema.parse(await this.#command("/api/workbench/goals",GoalCreateRequestSchema.parse(input)));}
  async getGoal(id:string){return GoalSnapshotSchema.parse(await this.#requestUnknown(`/api/workbench/goals/${encodeURIComponent(id)}`));}
  async goalCommand(id:string,input:GoalCommandRequest){return GoalSnapshotSchema.parse(await this.#command(`/api/workbench/goals/${encodeURIComponent(id)}/commands`,GoalCommandRequestSchema.parse(input)));}
  async getGoalCreationReceipt(id:string){return GoalCreationReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/goals/creation-commands/${encodeURIComponent(id)}`));}
  async getGoalCommandReceipt(id:string,commandId:string){return GoalCommandReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/goals/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}`));}
  async getVisualRetentionSettings(){return VisualRetentionSettingsSchema.parse(await this.#requestUnknown("/api/workbench/visual-evidence/settings"));}
  async updateVisualRetentionSettings(input:VisualRetentionUpdate){const value=VisualRetentionUpdateSchema.parse(input);const result=VisualRetentionSettingsSchema.parse(await this.#command("/api/workbench/visual-evidence/settings",value));if(result.last_command_id!==value.command_id)throw new Error("Retention receipt belongs to another command");return result;}
  async listVisualEvidence(input:VisualEvidenceQuery){const value=VisualEvidenceQuerySchema.parse(input),query=new URLSearchParams();for(const [key,item]of Object.entries(value))if(item!==undefined)query.set(key,String(item));const result=VisualEvidenceInventorySchema.parse(await this.#requestUnknown(`/api/workbench/visual-evidence?${query}`));if(value.run_id&&result.entries.some(entry=>!entry.run_artifacts.length||entry.run_artifacts.some(ref=>ref.project_id!==value.project_id||ref.run_id!==value.run_id)))throw new Error("Screenshot inventory is outside the requested Run scope");return result;}
  async pinVisualEvidence(evidenceId:string,input:VisualEvidencePin){const id=IdentifierSchema.parse(evidenceId),value=VisualEvidencePinSchema.parse(input),result=VisualEvidenceEntrySchema.parse(await this.#command(`/api/workbench/visual-evidence/${encodeURIComponent(id)}/pin`,value));if(result.evidence_id!==id)throw new Error("Screenshot pin receipt is outside its scope");return result;}
  async cleanupVisualEvidence(input:VisualEvidenceCleanupRequest){const value=VisualEvidenceCleanupRequestSchema.parse(input),result=VisualEvidenceCleanupResultSchema.parse(await this.#command("/api/workbench/visual-evidence/cleanup",value));if(result.command_id!==value.command_id)throw new Error("Screenshot cleanup receipt belongs to another command");return result;}
  async getVisualEvidenceCommandReceipt(commandId:string){const id=IdentifierSchema.parse(commandId),result=VisualEvidenceCommandReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/visual-evidence/commands/${encodeURIComponent(id)}`));if(result.command_id!==id)throw new Error("Screenshot command receipt belongs to another command");return result;}
  async getPersonalProfile(){return PersonalProfileSnapshotSchema.parse(await this.#requestUnknown("/api/workbench/personal/profile"));}
  async updatePersonalProfile(input:PersonalProfileUpdateRequest){const parsed=PersonalProfileUpdateRequestSchema.parse(input),result=PersonalProfileSnapshotSchema.parse(await this.#command("/api/workbench/personal/profile",parsed));if(result.last_command_id!==parsed.command_id||result.revision!==parsed.expected_revision+1)throw new Error("Personal profile reply does not match its bound command");return result;}
  async getPersonalProfileCommandReceipt(commandId:string){IdentifierSchema.parse(commandId);const result=PersonalProfileCommandReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/personal/profile/commands/${encodeURIComponent(commandId)}`));if(result.command_id!==commandId||result.result&&result.result.last_command_id!==commandId||result.observed_profile&&result.observed_profile.last_command_id!==commandId)throw new Error("Personal profile receipt is outside its command scope");return result;}
  async queryPersonalUsage(input:PersonalUsageQuery){const parsed=PersonalUsageQuerySchema.parse(input),query=new URLSearchParams();for(const [key,value]of Object.entries(parsed))if(value!==undefined)query.set(key,String(value));const result=PersonalUsageSnapshotSchema.parse(await this.#requestUnknown(`/api/workbench/personal/usage?${query.toString()}`));if(result.from_day!==parsed.from_day||result.to_day!==parsed.to_day||result.days.some(day=>day.day<parsed.from_day||day.day>parsed.to_day)||new Set(result.days.map(day=>day.day)).size!==result.days.length)throw new Error("Usage snapshot is outside its requested UTC range");return result;}
  async searchPublicSessions(input:PublicSessionSearchQuery){const parsed=PublicSessionSearchQuerySchema.parse(input),query=new URLSearchParams();for(const [key,value]of Object.entries(parsed))if(value!==undefined)query.set(key,String(value));const result=PublicSessionSearchResultSchema.parse(await this.#requestUnknown(`/api/workbench/personal/search?${query.toString()}`));if(result.query!==parsed.q||result.hits.length>parsed.limit||result.hits.some(hit=>parsed.project_id&&hit.project_id!==parsed.project_id||parsed.session_id&&hit.session_id!==parsed.session_id||parsed.status&&hit.status!==parsed.status||parsed.archive!=="all"&&(parsed.archive==="archived")!==hit.archived||parsed.from&&Date.parse(hit.occurred_at)<Date.parse(parsed.from)||parsed.to&&Date.parse(hit.occurred_at)>Date.parse(parsed.to)))throw new Error("Public search hit is outside its requested scope");return result;}
  async getGoalBudget(id:string){return GoalBudgetSnapshotSchema.parse(await this.#requestUnknown(`/api/workbench/goals/${encodeURIComponent(id)}/budget`));}
  async restoreWorkbenchSettings(input:RestoreWorkbenchSettingsRequest){return RestoreWorkbenchSettingsResultSchema.parse(await this.#command("/api/workbench/settings/restore",RestoreWorkbenchSettingsRequestSchema.parse(input)));}
  async getProjectRunDefaults(id:string){return ProjectRunDefaultsSnapshotSchema.parse(await this.#requestUnknown(`/api/workbench/projects/${encodeURIComponent(id)}/defaults`));}
  async updateProjectRunDefaults(id:string,input:ProjectRunDefaultsUpdateRequest){return ProjectRunDefaultsSnapshotSchema.parse(await this.#command(`/api/workbench/projects/${encodeURIComponent(id)}/defaults`,ProjectRunDefaultsUpdateRequestSchema.parse(input)));}
  async resetSessionRunOptions(id:string,input:SessionRunOptionsResetRequest){return SessionRunOptionsSnapshotSchema.parse(await this.#command(`/api/workbench/sessions/${encodeURIComponent(id)}/options/reset`,SessionRunOptionsResetRequestSchema.parse(input)));}

  async getCapabilities(): Promise<HostCapabilities> {
    return HostCapabilitiesSchema.parse(await this.#requestUnknown("/api/workbench/capabilities"));
  }

  async testModel(input: { command_id: string } = { command_id: createCommandId() }): Promise<ModelConnectionTestResult> {
    return ModelConnectionTestResultSchema.parse(await this.#command("/api/workbench/model-test", ModelConnectionTestRequestSchema.parse(input)));
  }

  async getWorkbenchResources(): Promise<WorkbenchResources> {
    return WorkbenchResourcesSchema.parse(await this.#requestUnknown("/api/workbench/resources"));
  }

  async workbenchCommand(input: WorkbenchCommandRequest): Promise<WorkbenchCommandResult> {
    return WorkbenchCommandResultSchema.parse(await this.#command("/api/workbench/commands", WorkbenchCommandRequestSchema.parse(input)));
  }

  async configureModel(input: ConfigureModelInput): Promise<ModelConfigSnapshot> {
    const body = ModelConfigUpdateRequestSchema.parse(input);
    return PublicModelConfigResponseSchema.parse(
      await this.#command("/api/model-config", body),
    );
  }

  async getPermissionConfig(): Promise<PermissionConfigSnapshot> {
    return PermissionSettingsResponseSchema.parse(
      await this.#requestUnknown("/api/permission-config"),
    );
  }

  async getTelemetryStatus(): Promise<TelemetryStatusSnapshot> {
    return TelemetryStatusSchema.parse(
      await this.#requestUnknown("/api/telemetry-status"),
    );
  }

  async getUsage(): Promise<UsageSnapshot> {
    return UsageSnapshotSchema.parse(
      await this.#requestUnknown("/api/usage"),
    );
  }

  async listExtensions(): Promise<readonly ExtensionStatusSnapshot[]> {
    return ExtensionStatusSchema.array().max(64).parse(
      await this.#requestUnknown("/api/extensions"),
    );
  }

  async listManagedSkills(scope:import("@tracegraph/contracts").ManagedSkillScope){
    const {ManagedSkillScopeSchema,ManagedSkillsSnapshotSchema}=await import("@tracegraph/contracts");
    const requested=ManagedSkillScopeSchema.parse(scope),result=ManagedSkillsSnapshotSchema.parse(await this.#command("/api/workbench/skills/list",requested));
    if(JSON.stringify(result.scope)!==JSON.stringify(requested))throw new TypeError("Skill response has a different scope");return result;
  }
  async readManagedSkill(input:import("@tracegraph/contracts").ManagedSkillSelector){
    const {ManagedSkillSelectorSchema,ManagedSkillDocumentSchema}=await import("@tracegraph/contracts");const requested=ManagedSkillSelectorSchema.parse(input),result=ManagedSkillDocumentSchema.parse(await this.#command("/api/workbench/skills/read",requested));
    if(result.name!==requested.name||JSON.stringify(result.scope)!==JSON.stringify(requested.scope))throw new TypeError("Skill document has a different scope");
    const bytes=new TextEncoder().encode(result.content);const digest=await globalThis.crypto.subtle.digest("SHA-256",bytes);const sha256=`sha256:${Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("")}`;
    if(bytes.byteLength!==result.byte_length||sha256!==result.sha256)throw new TypeError("Skill document integrity could not be verified");return result;
  }
  async validateManagedSkill(input:import("@tracegraph/contracts").ValidateManagedSkillRequest){const {ValidateManagedSkillRequestSchema,ManagedSkillValidationSchema}=await import("@tracegraph/contracts");return ManagedSkillValidationSchema.parse(await this.#command("/api/workbench/skills/validate",ValidateManagedSkillRequestSchema.parse(input)));}
  async managedSkillCommand(input:import("@tracegraph/contracts").ManagedSkillCommand){const {ManagedSkillCommandSchema,ManagedSkillCommandResultSchema}=await import("@tracegraph/contracts");const requested=ManagedSkillCommandSchema.parse(input),result=ManagedSkillCommandResultSchema.parse(await this.#command("/api/workbench/skills/commands",requested));if(result.command_id!==requested.command_id||result.name!==requested.name||JSON.stringify(result.scope)!==JSON.stringify(requested.scope))throw new TypeError("Skill command receipt has a different intent");return result;}
  async getManagedSkillCommandReceipt(commandId:string){const {IdentifierSchema,ManagedSkillCommandReceiptSchema}=await import("@tracegraph/contracts");const id=IdentifierSchema.parse(commandId),result=ManagedSkillCommandReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/skills/commands/${encodeURIComponent(id)}`));if(result.command_id!==id)throw new TypeError("Skill reconciliation has a different command");return result;}

  async listSkills(): Promise<readonly SkillProjectInspectionSnapshot[]> {
    return SkillProjectInspectionSchema.array().max(256).parse(
      await this.#requestUnknown("/api/skills"),
    );
  }

  async getMcpStatus(): Promise<McpStatusSnapshotResponse> {
    return McpStatusSnapshotSchema.parse(
      await this.#requestUnknown("/api/mcp"),
    );
  }

  async getLspStatus(): Promise<LspStatusSnapshotResponse> {
    return LspStatusSnapshotSchema.parse(
      await this.#requestUnknown("/api/lsp"),
    );
  }

  async listMemoryControl(): Promise<MemoryControlListResponse> {
    ClientQuerySchema.parse({ operation: "memory.list" });
    return MemoryControlListResponseSchema.parse(await this.#requestUnknown("/api/memory"));
  }

  async createMemoryCandidate(
    input: Omit<MemoryCandidateCreateRequest, "command_id"> & { command_id?: string },
  ): Promise<MemoryControlItem> {
    const body = MemoryCandidateCreateRequestSchema.parse({ ...input, command_id: input.command_id ?? createCommandId() });
    ClientCommandSchema.parse({ type: "memory.create", input: body });
    return MemoryControlItemSchema.parse(await this.#command("/api/memory", body));
  }

  async reviewMemory(
    memoryId: string,
    input: Omit<MemoryReviewRequest, "command_id"> & { command_id?: string },
  ): Promise<MemoryControlItem> {
    const body = MemoryReviewRequestSchema.parse({ ...input, command_id: input.command_id ?? createCommandId() });
    ClientCommandSchema.parse({ type: "memory.review", memory_id: memoryId, input: body });
    return MemoryControlItemSchema.parse(await this.#command(`/api/memory/${encodeURIComponent(memoryId)}/review`, body));
  }

  async correctMemory(
    memoryId: string,
    input: Omit<MemoryCorrectionRequest, "command_id"> & { command_id?: string },
  ): Promise<MemoryControlItem> {
    const body = MemoryCorrectionRequestSchema.parse({ ...input, command_id: input.command_id ?? createCommandId() });
    ClientCommandSchema.parse({ type: "memory.correct", memory_id: memoryId, input: body });
    return MemoryControlItemSchema.parse(await this.#command(`/api/memory/${encodeURIComponent(memoryId)}/correct`, body));
  }

  async revokeMemory(
    memoryId: string,
    input: { expected_sequence: number; command_id?: string },
  ): Promise<MemoryControlItem> {
    const body = MemoryRevokeRequestSchema.parse({ ...input, command_id: input.command_id ?? createCommandId() });
    ClientCommandSchema.parse({ type: "memory.revoke", memory_id: memoryId, input: body });
    return MemoryControlItemSchema.parse(await this.#command(`/api/memory/${encodeURIComponent(memoryId)}/revoke`, body));
  }

  async deleteMemory(memoryId: string, commandId = createCommandId()): Promise<{ deletedMemoryIds: readonly string[] }> {
    const body = MemoryDeleteRequestSchema.parse({ command_id: commandId });
    ClientCommandSchema.parse({ type: "memory.delete", memory_id: memoryId, input: body });
    return MemoryDeleteResponseSchema.parse(await this.#requestUnknown(`/api/memory/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-tracegraph-command-id": commandId,
      },
      body: JSON.stringify(body),
    }));
  }

  async listExperienceCases(): Promise<ExperienceControlListResponse> {
    ClientQuerySchema.parse({ operation: "experience.list" });
    return ExperienceControlListResponseSchema.parse(await this.#requestUnknown("/api/experience"));
  }

  async reviewExperienceCase(
    caseId: string,
    input: Omit<ExperienceLifecycleReviewRequest, "command_id"> & { command_id?: string },
  ): Promise<ExperienceLifecycleReviewResponse> {
    const body = ExperienceLifecycleReviewRequestSchema.parse({ ...input, command_id: input.command_id ?? createCommandId() });
    ClientCommandSchema.parse({ type: "experience.review", case_id: caseId, input: body });
    return ExperienceLifecycleReviewResponseSchema.parse(await this.#command(
      `/api/experience/${encodeURIComponent(caseId)}/review`,
      body,
    ));
  }

  async restartMcpServer(
    serverName: string,
    input: { command_id?: string } = {},
  ): Promise<McpServerStatusSnapshot> {
    const parsedServerName = MCP_SERVER_NAME_SCHEMA.parse(serverName);
    const body = McpRestartRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
    });
    return McpServerStatusSchema.parse(
      await this.#command(`/api/mcp/restart/${encodeURIComponent(parsedServerName)}`, body),
    );
  }

  async reloadExtension(
    extensionName: string,
    input: { command_id?: string; expected_config_digest?: `sha256:${string}` } = {},
  ): Promise<ExtensionStatusSnapshot> {
    const body = ExtensionReloadCommandSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      extension_name: extensionName,
      ...(input.expected_config_digest === undefined
        ? {}
        : { expected_config_digest: input.expected_config_digest }),
    });
    return ExtensionStatusSchema.parse(
      await this.#command("/api/extensions/reload", body),
    );
  }

  async runExtensionCommand(
    name: string,
    input: { command_id?: string; args?: readonly string[] } = {},
  ): Promise<ExtensionCommandResultSnapshot> {
    const body = ExtensionCommandInvocationSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      name,
      args: input.args ?? [],
    });
    return ExtensionCommandResultSchema.parse(
      await this.#command(`/api/extensions/commands/${encodeURIComponent(name)}`, body),
    );
  }

  async configurePermissionPreset(
    input: Omit<ConfigurePermissionPresetInput, "command_id"> & { command_id?: string },
  ): Promise<PermissionConfigSnapshot> {
    const body = PermissionPresetUpdateRequestSchema.parse({
      ...input,
      command_id: input.command_id ?? createCommandId(),
    });
    return PermissionSettingsResponseSchema.parse(
      await this.#command("/api/permission-config", body),
    );
  }

  async listSessions(input: Partial<SessionListQuery> = {}): Promise<SessionListResponse> {
    const query = SessionListQuerySchema.parse(input);
    const search = new URLSearchParams({ limit: String(query.limit) });
    search.set("view", query.view);
    if (query.project_id !== undefined) search.set("project_id", query.project_id);
    if (query.q !== undefined) search.set("q", query.q);
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    return SessionListResponseSchema.parse(
      await this.#requestUnknown(`/api/sessions?${search.toString()}`),
    );
  }

  async getSession(sessionId: string): Promise<SessionReadResult> {
    return SessionReadResultSchema.parse(
      await this.#requestUnknown(`/api/sessions/${encodeURIComponent(sessionId)}`),
    );
  }

  /**
   * Enter or step within a Host-authorized historical view. The returned
   * replay bearer replaces the current transport authority, so an accidental
   * call to any ordinary mutation is rejected by the Host rather than merely
   * disabled by the UI.
   */
  async createReplay(input: ReplaySnapshotRequest): Promise<ReplaySessionResponse> {
    const body = ReplaySnapshotRequestSchema.parse(input);
    const generation = ++this.#replayGeneration;
    const startedInReplay = this.#replayScope !== undefined;
    const responseValue = await this.#requestUnknown("/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, true, !startedInReplay);
    if (generation !== this.#replayGeneration) {
      throw new Error("Replay request was superseded by a newer authority transition");
    }
    const response = ReplaySessionResponseSchema.parse(responseValue);
    if (this.#replayScope === undefined) this.#liveTokenBeforeReplay = this.#token;
    this.#token = response.replay_token;
    this.#replayScope = {
      sessionId: response.snapshot.session_id,
      runId: response.snapshot.run_id,
    };
    return response;
  }

  async getReplayDiff(input: ReplayDiffInput): Promise<ReplayDiff> {
    const scope = this.#replayScope;
    if (scope === undefined) throw new Error("Create a replay before requesting its diff");
    const query = ReplayDiffQuerySchema.parse({
      session_id: scope.sessionId,
      run_id: scope.runId,
      from: input.from,
      to: input.to,
    });
    const search = new URLSearchParams({
      session_id: query.session_id,
      run_id: query.run_id,
      from: String(query.from),
      to: String(query.to),
    });
    return ReplayDiffSchema.parse(
      await this.#requestUnknown(`/api/replay/diff?${search.toString()}`),
    );
  }

  /** Restore the live bearer retained before createReplay. No domain write is performed. */
  exitReplay(): void {
    // Invalidate an in-flight create/step even if its response has not yet set
    // replayScope. A late Host response must never reverse an explicit exit.
    this.#replayGeneration += 1;
    if (this.#replayScope === undefined) return;
    this.#token = this.#liveTokenBeforeReplay;
    this.#liveTokenBeforeReplay = undefined;
    this.#replayScope = undefined;
  }

  async renameSession(sessionId: string, input: SessionRenameRequest): Promise<SessionReadResult> {
    const body = SessionRenameRequestSchema.parse(input);
    return SessionReadResultSchema.parse(
      await this.#mutation(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", body),
    );
  }

  async deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    return SessionDeleteResponseSchema.parse(
      await this.#mutation(`/api/sessions/${encodeURIComponent(sessionId)}`, "DELETE"),
    );
  }

  async resumeSession(
    sessionId: string,
    input: Partial<SessionResumeRequest> = {},
  ): Promise<SessionResumeResponse> {
    const body = SessionResumeRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
    });
    return SessionResumeResponseSchema.parse(
      await this.#mutation(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, "POST", body),
    );
  }

  async getModelConnections(){return ModelConnectionsSnapshotSchema.parse(await this.#requestUnknown("/api/workbench/models"));}
  async saveModelConnection(input:ModelConnectionSaveRequest){return ModelConnectionsSnapshotSchema.parse(await this.#command("/api/workbench/models",ModelConnectionSaveRequestSchema.parse(input)));}
  async removeModelConnection(id:string,input:ModelConnectionRemoveRequest){return ModelConnectionsSnapshotSchema.parse(await this.#command(`/api/workbench/models/${encodeURIComponent(id)}/remove`,ModelConnectionRemoveRequestSchema.parse(input)));}
  async testModelConnection(id:string,input:{command_id:string}){return ModelConnectionTestResultSchema.parse(await this.#command(`/api/workbench/models/${encodeURIComponent(id)}/test`,ModelConnectionTestRequestSchema.parse(input)));}
  async discoverModelCatalog(id:string,input:ModelCatalogDiscoveryRequest){return ModelCatalogDiscoveryResultSchema.parse(await this.#command(`/api/workbench/models/${encodeURIComponent(id)}/discover`,ModelCatalogDiscoveryRequestSchema.parse(input)));}
  async testModelCapabilities(id:string,input:ModelCapabilityTestRequest){const body=ModelCapabilityTestRequestSchema.parse(input),result=ModelCapabilityTestResultSchema.parse(await this.#command(`/api/workbench/models/${encodeURIComponent(id)}/capability-tests`,body));if(result.command_id!==body.command_id||result.connection_id!==id||result.connection_revision!==body.expected_revision||result.model!==body.model||JSON.stringify(result.results.map(item=>item.feature))!==JSON.stringify(body.features))throw new Error("Model capability receipt differs from the selected test intent");return result;}
  async getModelCapabilityTestReceipt(commandId:string){const result=ModelCapabilityTestReceiptSchema.parse(await this.#requestUnknown(`/api/workbench/model-capability-tests/${encodeURIComponent(commandId)}`));if(result.command_id!==commandId||result.result&&result.result.command_id!==commandId)throw new Error("Model capability receipt refers to a different command");return result;}
  async getSessionRunOptions(id:string){return SessionRunOptionsSnapshotSchema.parse(await this.#requestUnknown(`/api/workbench/sessions/${encodeURIComponent(id)}/options`));}
  async updateSessionRunOptions(id:string,input:SessionRunOptionsUpdateRequest){return SessionRunOptionsSnapshotSchema.parse(await this.#command(`/api/workbench/sessions/${encodeURIComponent(id)}/options`,SessionRunOptionsUpdateRequestSchema.parse(input)));}
  async getPermissionGrant(){return PermissionGrantSchema.parse(await this.#requestUnknown("/api/workbench/permission-grant"));}
  async setPermissionGrant(input:PermissionGrantUpdateRequest){return PermissionGrantSchema.parse(await this.#command("/api/workbench/permission-grant",PermissionGrantUpdateRequestSchema.parse(input)));}

  async startRun(input: StartRunRequest): Promise<RunProjection> {
    const body = StartRunRequestSchema.parse(input);
    return RunProjectionSchema.parse(
      await this.#command("/api/runs", body),
    );
  }

  async startChat(input: StartChatRequest): Promise<RunProjection> {
    const body = StartChatRequestSchema.parse(input);
    return RunProjectionSchema.parse(
      await this.#command("/api/chat/runs", body),
    );
  }

  /** Stage raw attachment bytes and receive an opaque, scope-bound upload id. */
  async uploadAttachment(input: UploadAttachmentInput): Promise<AttachmentStageReceipt> {
    const { bytes, ...metadata } = input;
    const body = AttachmentUploadRequestSchema.parse({
      ...metadata,
      command_id: input.command_id ?? createCommandId(),
    });
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) query.set(key, value);
    }
    const response = await this.#requestResponse(`/api/attachments?${query.toString()}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-tracegraph-command-id": body.command_id,
      },
      body: attachmentBody(bytes),
    });
    return AttachmentStageReceiptSchema.parse(await response.json());
  }

  async approvePlan(
    runId: string,
    input: Omit<ApprovePlanRequest, "command_id"> & { command_id?: string },
  ): Promise<RunProjection> {
    const body = ApprovePlanRequestSchema.parse({
      ...input,
      command_id: input.command_id ?? createCommandId(),
    });
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/plan/approve`, body),
    );
  }

  async getTodos(runId: string): Promise<TodoList> {
    return TodoListSchema.parse(
      await this.#requestUnknown(`/api/runs/${encodeURIComponent(runId)}/todos`),
    );
  }

  async writeTodo(
    runId: string,
    request: Omit<TodoWriteRequest, "command_id"> & { command_id?: string },
  ): Promise<TodoMutationResult> {
    const body = TodoWriteRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TodoMutationResultSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/todos`, body),
    );
  }

  /**
   * Durably enqueue a user steering input for an in-flight Run. Project and
   * actor authority are deliberately absent from this browser-safe request;
   * the loopback Host binds both before handing the command to Runtime.
   */
  async submitUserInput(
    runId: string,
    request: Omit<SubmitUserInputRequest, "command_id" | "input_id"> & {
      command_id?: string;
      input_id?: string;
    },
  ): Promise<SubmitUserInputResult> {
    const body = SubmitUserInputRequestSchema.parse({
      ...request,
      command_id: request.command_id ?? createCommandId(),
      input_id: request.input_id ?? createInputId(),
    });
    return SubmitUserInputResultSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/input`, body),
    );
  }

  async approve(runId: string, command: ApprovalCommand): Promise<RunProjection> {
    const body = ApprovalCommandSchema.parse(command);
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/approve`, body),
    );
  }

  async reject(runId: string, command: ApprovalCommand): Promise<RunProjection> {
    const body = ApprovalCommandSchema.parse(command);
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/reject`, body),
    );
  }

  async stop(runId: string, command: StopRunCommand): Promise<RunProjection> {
    const body = StopRunCommandSchema.parse(command);
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/stop`, body),
    );
  }

  async rollbackAction(
    runId: string,
    actionId: string,
    input: Partial<RollbackActionRequest> = {},
  ): Promise<RunProjection> {
    const body = RollbackActionRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      force: input.force ?? false,
    });
    return RunProjectionSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/rollback`,
        body,
      ),
    );
  }

  async getRun(runId: string): Promise<RunProjection> {
    return RunProjectionSchema.parse(
      await this.#requestUnknown(`/api/runs/${encodeURIComponent(runId)}`),
    );
  }

  /** Same read-only public projection used by Web/Desktop; no task dispatch. */
  async getPublicChat(runId: string): Promise<{ run_id: string; status: RunProjection["status"]; blocks: readonly PublicChatBlock[] }> {
    const run = await this.getRun(runId);
    return { run_id: run.run_id, status: run.status, blocks: projectSessionPublicChat(run.timeline) };
  }

  /** Read the canonical child Run linked by a parent Run's subagent projection. */
  async getSubagent(parentRunId: string, subagentId: string): Promise<RunProjection> {
    return RunProjectionSchema.parse(
      await this.#requestUnknown(
        `/api/runs/${encodeURIComponent(parentRunId)}/subagents/${encodeURIComponent(subagentId)}`,
      ),
    );
  }

  /** Read the canonical team rooted at a coordinator Run. */
  async getTeam(coordinatorRunId: string): Promise<TeamReadResponse> {
    return TeamReadResponseSchema.parse(
      await this.#requestUnknown(
        `/api/runs/${encodeURIComponent(coordinatorRunId)}/team`,
      ),
    );
  }

  async createTeam(
    coordinatorRunId: string,
    request: Partial<CreateTeamRequest> = {},
  ): Promise<TeamMutationResult> {
    const body = CreateTeamRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(coordinatorRunId)}/team`,
        body,
      ),
    );
  }

  async sendTeamMailbox(
    actorRunId: string,
    request: Omit<TeamMailboxSendRequest, "command_id"> & { command_id?: string },
  ): Promise<TeamMutationResult> {
    const body = TeamMailboxSendRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(actorRunId)}/team/mailbox/send`,
        body,
      ),
    );
  }

  async claimTeamMailbox(
    actorRunId: string,
    request: Omit<TeamMailboxClaimRequest, "command_id"> & { command_id?: string },
  ): Promise<TeamMutationResult> {
    const body = TeamMailboxClaimRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(actorRunId)}/team/mailbox/claim`,
        body,
      ),
    );
  }

  async writeTeamTask(
    actorRunId: string,
    request: Omit<TeamTaskWriteRequest, "command_id"> & { command_id?: string },
  ): Promise<TeamMutationResult> {
    const body = TeamTaskWriteRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(actorRunId)}/team/tasks/write`,
        body,
      ),
    );
  }

  async heartbeatTeam(
    memberRunId: string,
    request: Partial<TeamHeartbeatRequest> = {},
  ): Promise<TeamMutationResult> {
    const body = TeamHeartbeatRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input ?? {},
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(memberRunId)}/team/heartbeat`,
        body,
      ),
    );
  }

  async sweepLostTeamMembers(
    coordinatorRunId: string,
    request: Partial<TeamSweepLostMembersRequest> = {},
  ): Promise<TeamMutationResult> {
    const body = TeamSweepLostMembersRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(coordinatorRunId)}/team/sweep`,
        body,
      ),
    );
  }

  async getArtifact(runId: string, artifactId: string): Promise<ArtifactWireResponse> {
    const query = new URLSearchParams({ run_id: runId });
    return ArtifactWireResponseSchema.parse(
      await this.#requestUnknown(
        `/api/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
      ),
    );
  }

  /** Fetch verified binary bytes through the live, relation-scoped Host route. */
  async getAttachmentContent(
    runId: string,
    attachmentId: string,
  ): Promise<AttachmentContentResponse> {
    const response = await this.#requestResponse(
      `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      { headers: { accept: "image/png,image/jpeg,application/pdf" } },
    );
    const mediaType = AttachmentMediaTypeSchema.parse(
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
    );
    const sha256 = response.headers.get("x-tracegraph-content-sha256");
    if (sha256 === null || !/^sha256:[a-f0-9]{64}$/u.test(sha256)) {
      throw new TypeError("Attachment content response has no valid content hash");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new TypeError("Attachment content response was empty");
    }
    return { attachmentId, mediaType, sha256: sha256 as `sha256:${string}`, bytes };
  }

  async *streamEvents(
    runId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<WireSessionEvent, void, void> {
    let afterSequence = options.afterSequence ?? 0;
    let retryMs = options.minRetryMs ?? 250;
    const maxRetryMs = options.maxRetryMs ?? 2_000;
    const reconnect = options.reconnect ?? true;
    let retriedAuthentication = false;

    while (!options.signal?.aborted) {
      try {
        const query = new URLSearchParams({ after_sequence: String(afterSequence) });
        const requestInit: RequestInit = { headers: this.#headers() };
        if (options.signal) requestInit.signal = options.signal;
        const response = await this.#fetch(
          `${this.#baseUrl}/api/runs/${encodeURIComponent(runId)}/events/stream?${query.toString()}`,
          requestInit,
        );
        if (response.status === 401 && this.#replayScope === undefined && !retriedAuthentication) {
          retriedAuthentication = true;
          await this.#refreshCapabilityToken();
          continue;
        }
        if (!response.ok) {
          throw await this.#httpError(response);
        }
        if (!response.body) {
          throw new TypeError("SSE response has no body");
        }

        retryMs = options.minRetryMs ?? 250;
        retriedAuthentication = false;
        for await (const payload of parseSseData(response.body, options.signal)) {
          const event = WireSessionEventSchema.parse(JSON.parse(payload));
          afterSequence = Math.max(afterSequence, event.sequence);
          yield event;
        }
        if (!reconnect) return;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect) throw error;
        await delay(retryMs, options.signal);
        retryMs = Math.min(maxRetryMs, retryMs * 2);
      }
    }
  }

  /**
   * Stream the volatile, safe public-process feed for an active Run. Unlike
   * `streamEvents`, this is not ledger replay: it contains only concise
   * runtime activity suitable for a fast live UI, never provider CoT or token
   * deltas.
   */
  async *streamLiveActivities(
    runId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<LivePublicActivity, void, void> {
    let afterSequence = options.afterSequence ?? 0;
    let retryMs = options.minRetryMs ?? 250;
    const maxRetryMs = options.maxRetryMs ?? 2_000;
    const reconnect = options.reconnect ?? true;
    let retriedAuthentication = false;

    while (!options.signal?.aborted) {
      try {
        const query = new URLSearchParams({ after_sequence: String(afterSequence) });
        const requestInit: RequestInit = { headers: this.#headers() };
        if (options.signal) requestInit.signal = options.signal;
        const response = await this.#fetch(
          `${this.#baseUrl}/api/runs/${encodeURIComponent(runId)}/live/stream?${query.toString()}`,
          requestInit,
        );
        if (response.status === 401 && this.#replayScope === undefined && !retriedAuthentication) {
          retriedAuthentication = true;
          await this.#refreshCapabilityToken();
          continue;
        }
        if (!response.ok) {
          throw await this.#httpError(response);
        }
        if (!response.body) {
          throw new TypeError("SSE response has no body");
        }

        retryMs = options.minRetryMs ?? 250;
        retriedAuthentication = false;
        let lastActivity: LivePublicActivity | undefined;
        for await (const payload of parseSseData(response.body, options.signal)) {
          const activity = LivePublicActivitySchema.parse(JSON.parse(payload));
          lastActivity = activity;
          afterSequence = Math.max(afterSequence, activity.sequence);
          yield activity;
          // Terminal facts are self-describing, so they can stop immediately.
          // plan.ready is different: it may be historical activity in an
          // execute-stage replay, and only becomes a wait boundary when the
          // current Host response ends immediately after that activity.
          if (isTerminalLiveActivity(activity)) return;
        }
        if (!reconnect) return;
        if (lastActivity?.source_event_type === "plan.ready") {
          // EOF alone is not proof that this was the current wait boundary: a
          // proxy can disconnect immediately after replaying a historical
          // plan.ready from an execute-stage Run. Confirm the durable
          // optimistic-lock revision before deciding not to reconnect.
          const projection = await this.getRun(runId);
          if (
            projection.status === "awaiting_plan_approval"
            && projection.pending_plan?.plan_event_id === lastActivity.source_event_id
          ) {
            return;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect) throw error;
        await delay(retryMs, options.signal);
        retryMs = Math.min(maxRetryMs, retryMs * 2);
      }
    }
  }

  /**
   * Stream the transient, model-authored public plan/answer surface. Its
   * cursor is independent of the durable event ledger and of the compact
   * execution feed, so clients can reconnect without dropping token updates.
   */
  async *streamModelSurface(
    runId: string,
    options: ModelSurfaceStreamOptions = {},
  ): AsyncGenerator<ModelSurfaceEvent, void, void> {
    let afterCursor = options.afterCursor ?? 0;
    let retryMs = options.minRetryMs ?? 250;
    const maxRetryMs = options.maxRetryMs ?? 2_000;
    const reconnect = options.reconnect ?? true;
    let retriedAuthentication = false;

    while (!options.signal?.aborted) {
      try {
        const query = new URLSearchParams({ after_cursor: String(afterCursor) });
        const requestInit: RequestInit = { headers: this.#headers() };
        if (options.signal) requestInit.signal = options.signal;
        const response = await this.#fetch(
          `${this.#baseUrl}/api/runs/${encodeURIComponent(runId)}/model-surface/stream?${query.toString()}`,
          requestInit,
        );
        if (response.status === 401 && this.#replayScope === undefined && !retriedAuthentication) {
          retriedAuthentication = true;
          await this.#refreshCapabilityToken();
          continue;
        }
        if (!response.ok) throw await this.#httpError(response);
        if (!response.body) throw new TypeError("SSE response has no body");

        retryMs = options.minRetryMs ?? 250;
        retriedAuthentication = false;
        for await (const payload of parseSseData(response.body, options.signal)) {
          const event = ModelSurfaceEventSchema.parse(JSON.parse(payload));
          afterCursor = Math.max(afterCursor, event.cursor);
          yield event;
        }
        if (!reconnect) return;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect) throw error;
        await delay(retryMs, options.signal);
        retryMs = Math.min(maxRetryMs, retryMs * 2);
      }
    }
  }

  async #command(path: string, body: unknown): Promise<unknown> {
    const commandId =
      typeof body === "object" &&
      body !== null &&
      "command_id" in body &&
      typeof body.command_id === "string"
        ? body.command_id
        : createCommandId();
    return this.#requestUnknown(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tracegraph-command-id": commandId,
      },
      body: JSON.stringify(body),
    });
  }

  async #mutation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<unknown> {
    const commandId =
      typeof body === "object" &&
      body !== null &&
      "command_id" in body &&
      typeof body.command_id === "string"
        ? body.command_id
        : createCommandId();
    return this.#requestUnknown(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-tracegraph-command-id": commandId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async #requestUnknown(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    retryAuthentication = true,
  ): Promise<unknown> {
    const response = await this.#requestResponse(path, init, authenticated, retryAuthentication);
    if (response.status === 204) return undefined;
    return response.json() as Promise<unknown>;
  }

  async #requestResponse(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    retryAuthentication = true,
  ): Promise<Response> {
    // Authority is a property of the request that left the process, not of
    // whatever mode the caller happens to be in when a late response arrives.
    // Remembering it here prevents an exited replay request from turning a
    // delayed 401 into a live bootstrap/retry.
    const startedWithReplayAuthority = this.#replayScope !== undefined;
    const generation=this.#replayGeneration;
    if(authenticated&&this.#managedLiveAuthority&&!startedWithReplayAuthority&&!["GET","HEAD"].includes((init.method??"GET").toUpperCase())){
      // A replaced Host can retain the same gateway address while rotating its
      // bearer. Verify live authority before this one explicit command; never
      // retry the POST/PATCH/DELETE if its response is lost or rejected.
      try{await this.#refreshCapabilityToken();}
      catch{throw new TraceGraphMutationPreflightError();}
      if(generation!==this.#replayGeneration||this.#replayScope!==undefined)throw new TraceGraphMutationPreflightError();
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.#headers(authenticated),
        ...init.headers,
      },
    });
    if (
      response.status === 401
      && authenticated
      && retryAuthentication
      && ["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())
      && !startedWithReplayAuthority
      && this.#replayScope === undefined
    ) {
      await this.#refreshCapabilityToken();
      return this.#requestResponse(path, init, authenticated, false);
    }
    if (!response.ok) {
      throw await this.#httpError(response);
    }
    return response;
  }

  async #refreshCapabilityToken(): Promise<void> {
    if (this.#replayScope !== undefined) {
      throw new TraceGraphHttpError(
        401,
        "Replay capability expired; exit replay before reconnecting live authority",
        { error: "replay_capability_expired" },
      );
    }
    await this.bootstrap();
  }

  #headers(authenticated = true): Record<string, string> {
    const transportHeaders = this.#nodeOrigin === undefined ? {} : { origin: this.#nodeOrigin };
    if (!authenticated) return { accept: "application/json", ...transportHeaders };
    if (!this.#token) throw new Error("TraceGraph client is not bootstrapped");
    return {
      accept: "application/json",
      authorization: `Bearer ${this.#token}`,
      ...transportHeaders,
    };
  }

  async #httpError(response: Response): Promise<TraceGraphHttpError> {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the original text so non-JSON proxy/Host failures remain inspectable.
    }
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `Outlive Agent returned ${response.status}`;
    return new TraceGraphHttpError(response.status, message, body);
  }
}

function attachmentBody(value: Blob | ArrayBuffer | Uint8Array): BodyInit {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return value;
  // Copy views backed by SharedArrayBuffer or a sliced Buffer into an ordinary
  // ArrayBuffer so fetch retries never depend on a mutable/shared backing store.
  return Uint8Array.from(value).buffer;
}

function isBrowserRuntime(): boolean {
  return typeof globalThis.window !== "undefined" && typeof globalThis.document !== "undefined";
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("nodeOrigin must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("nodeOrigin must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function isTerminalLiveActivity(activity: LivePublicActivity): boolean {
  return activity.source_event_type === "run.completed"
    || activity.source_event_type === "run.failed"
    || activity.source_event_type === "run.cancelled"
    || activity.source_event_type === "run.interrupted"
    || activity.source_event_type === "action.diverged";
}

export async function* parseSseData(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    // A pending read does not observe a flag until more bytes arrive. Cancel the
    // actual response, including when a consumer returns after its last event.
    cancellation ??= reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        if (signal?.aborted) return;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    await cancellation;
    reader.releaseLock();
  }
}

const delay = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
};
import {BrowserStatusSchema,BrowserGrantRequestSchema,BrowserGrantSchema,BrowserCommandSchema,BrowserCommandResultSchema,BrowserCommandReceiptSchema,BrowserObservationSchema,GoalCreateRequestSchema,GoalSnapshotSchema,GoalListResponseSchema,GoalCommandRequestSchema,GoalCommandReceiptSchema,GoalBudgetSnapshotSchema,type BrowserGrantRequest,type BrowserCommand,type GoalCreateRequest,type GoalCommandRequest} from "@tracegraph/contracts";
import { ModelCapabilityTestRequestSchema, ModelCapabilityTestResultSchema, ModelCapabilityTestReceiptSchema, type ModelCapabilityTestRequest } from "@tracegraph/contracts";
