import type { NativeRunNavigation } from "@tracegraph/contracts";
import {
  ApprovalCommandSchema,
  ApprovePlanRequestSchema,
  ArtifactWireResponseSchema,
  StopRunCommandSchema,
  SubmitUserInputRequestSchema,
  SubmitUserInputResultSchema,
  TodoListSchema,
  TodoWriteRequestSchema,
  TodoMutationResultSchema,
  StartChatRequestSchema,
  SessionRenameRequestSchema,
  SessionDeleteResponseSchema,
  SessionResumeRequestSchema,
  SessionResumeResponseSchema,
  ExperienceControlListResponseSchema,
  ExperienceLifecycleReviewRequestSchema,
  ExperienceLifecycleReviewResponseSchema,
  IdentifierSchema,
  MemoryCandidateCreateRequestSchema,
  MemoryControlItemSchema,
  MemoryControlListResponseSchema,
  MemoryCorrectionRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryDeleteResponseSchema,
  MemoryReviewRequestSchema,
  MemoryRevokeRequestSchema,
  type MigrationPreviewSnapshot,
  type MigrationCommitReceipt,
  ModelConfigUpdateRequestSchema,
  ProjectSummarySchema,
  PublicModelConfigResponseSchema,
  SessionRecoveryReportSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionReadResultSchema,
  RunProjectionSchema,
  StartRunRequestSchema,
  type ExperienceControlListResponse,
  type ExperienceLifecycleReviewRequest,
  type ExperienceLifecycleReviewResponse,
  type MemoryCandidateCreateRequest,
  type MemoryControlItem,
  type MemoryControlListResponse,
  type MemoryCorrectionRequest,
  type MemoryDeleteRequest,
  type MemoryDeleteResponse,
  type MemoryReviewRequest,
  type MemoryRevokeRequest,
} from "@tracegraph/contracts";
import { z } from "zod";
import type {HostConnectionSnapshot} from "@tracegraph/contracts";
import type { DirectDesktopBridgeApi } from "./direct-routes.js";
import type { DesktopStreamPacket, DesktopStreamOpenInput } from "./stream-contract.js";
import type { DesktopMigrationOutcome } from "./migration-contract.js";

const HostIdentitySchema = z.object({
  package_name: z.enum(["@tracegraph/host", "@tracegraph/desktop-host"]),
  package_version: z.string().min(1).max(128),
  protocol_version: z.string().min(1).max(128),
}).strict();

export const DesktopHostStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), identity: HostIdentitySchema, recovery: SessionRecoveryReportSchema }).strict(),
  z.object({ state: z.literal("offline"), message: z.string().min(1).max(500) }).strict(),
]);

export const DesktopBridgeInputSchemas = {
  listSessions: SessionListQuerySchema,
  getSession: z.string().min(1).max(256),
  getRun: z.string().min(1).max(256),
  startRun: StartRunRequestSchema,
  startChat: StartChatRequestSchema,
  approval: ApprovalCommandSchema.strict(),
  stop: StopRunCommandSchema.strict(),
  approvePlan: z.object({ run_id: IdentifierSchema, input: ApprovePlanRequestSchema }).strict(),
  submitUserInput: z.object({ run_id: IdentifierSchema, input: SubmitUserInputRequestSchema }).strict(),
  writeTodo: z.object({ run_id: IdentifierSchema, input: TodoWriteRequestSchema }).strict(),
  getArtifact: z.object({ run_id: IdentifierSchema, artifact_id: IdentifierSchema }).strict(),
  resumeSession: z.object({ session_id: IdentifierSchema, input: SessionResumeRequestSchema }).strict(),
  renameSession: z.object({ session_id: IdentifierSchema, input: SessionRenameRequestSchema }).strict(),
  openLocalProject: z.object({ access: z.enum(["read_write", "read_only"]) }).strict(),
  projectId: IdentifierSchema,
  configureModel: ModelConfigUpdateRequestSchema,
  createMemoryCandidate: MemoryCandidateCreateRequestSchema,
  memoryReview: z.object({ memory_id: IdentifierSchema, input: MemoryReviewRequestSchema }).strict(),
  memoryCorrect: z.object({ memory_id: IdentifierSchema, input: MemoryCorrectionRequestSchema }).strict(),
  memoryRevoke: z.object({ memory_id: IdentifierSchema, input: MemoryRevokeRequestSchema }).strict(),
  memoryDelete: z.object({ memory_id: IdentifierSchema, input: MemoryDeleteRequestSchema }).strict(),
  experienceReview: z.object({ case_id: IdentifierSchema, input: ExperienceLifecycleReviewRequestSchema }).strict(),
} as const;

export const DesktopBridgeOutputSchemas = {
  listSessions: SessionListResponseSchema,
  getSession: SessionReadResultSchema,
  getRun: RunProjectionSchema,
  startRun: RunProjectionSchema,
  startChat: RunProjectionSchema,
  approval: RunProjectionSchema,
  approvePlan: RunProjectionSchema,
  stop: RunProjectionSchema,
  getTodos: TodoListSchema,
  writeTodo: TodoMutationResultSchema,
  submitUserInput: SubmitUserInputResultSchema,
  getArtifact: ArtifactWireResponseSchema,
  renameSession: SessionReadResultSchema,
  deleteSession: SessionDeleteResponseSchema,
  resumeSession: SessionResumeResponseSchema,
  listProjects: ProjectSummarySchema.array(),
  openLocalProject: ProjectSummarySchema,
  configureModel: PublicModelConfigResponseSchema,
  getModelConfig: PublicModelConfigResponseSchema,
  listMemoryControl: MemoryControlListResponseSchema,
  createMemoryCandidate: MemoryControlItemSchema,
  reviewMemory: MemoryControlItemSchema,
  correctMemory: MemoryControlItemSchema,
  revokeMemory: MemoryControlItemSchema,
  deleteMemory: MemoryDeleteResponseSchema,
  listExperienceCases: ExperienceControlListResponseSchema,
  reviewExperienceCase: ExperienceLifecycleReviewResponseSchema,
} as const;

export type DesktopHostStatus = z.infer<typeof DesktopHostStatusSchema>;
export type DesktopBridgeApi = DirectDesktopBridgeApi & {
  onNativeRunRequested?(listener: (navigation: NativeRunNavigation) => void): () => void;
  getConnectionStatus():Promise<HostConnectionSnapshot>;
  copyText(text:string):Promise<void>;
  startHost(): Promise<void>;
  getMigrationResult(): Promise<DesktopMigrationOutcome | undefined>;
  previewMigration(): Promise<MigrationPreviewSnapshot | undefined>;
  commitMigration(input: { source_id: string }): Promise<MigrationCommitReceipt>;
  openPreview(previewId: string): Promise<void>;
  closePreview(): Promise<void>;
  openStream(input: DesktopStreamOpenInput): Promise<string>;
  readStream(id: string): Promise<DesktopStreamPacket>;
  closeStream(id: string): Promise<void>;
  getHostStatus(): Promise<DesktopHostStatus>;
  listSessions(input: z.infer<typeof SessionListQuerySchema>): Promise<z.infer<typeof SessionListResponseSchema>>;
  getSession(sessionId: string): Promise<z.infer<typeof SessionReadResultSchema>>;
  getRun(runId: string): Promise<z.infer<typeof RunProjectionSchema>>;
  startRun(input: z.infer<typeof StartRunRequestSchema>): Promise<z.infer<typeof RunProjectionSchema>>;
  startChat(input: z.infer<typeof StartChatRequestSchema>): Promise<z.infer<typeof RunProjectionSchema>>;
  approve(command: z.infer<typeof ApprovalCommandSchema>): Promise<z.infer<typeof RunProjectionSchema>>;
  reject(command: z.infer<typeof ApprovalCommandSchema>): Promise<z.infer<typeof RunProjectionSchema>>;
  stop(command: z.infer<typeof StopRunCommandSchema>): Promise<z.infer<typeof RunProjectionSchema>>;
  approvePlan(input: z.infer<typeof DesktopBridgeInputSchemas.approvePlan>): Promise<z.infer<typeof RunProjectionSchema>>;
  getTodos(runId: string): Promise<z.infer<typeof TodoListSchema>>;
  writeTodo(input: z.infer<typeof DesktopBridgeInputSchemas.writeTodo>): Promise<z.infer<typeof TodoMutationResultSchema>>;
  submitUserInput(input: z.infer<typeof DesktopBridgeInputSchemas.submitUserInput>): Promise<z.infer<typeof SubmitUserInputResultSchema>>;
  getArtifact(input: z.infer<typeof DesktopBridgeInputSchemas.getArtifact>): Promise<z.infer<typeof ArtifactWireResponseSchema>>;
  resumeSession(input: z.infer<typeof DesktopBridgeInputSchemas.resumeSession>): Promise<z.infer<typeof SessionResumeResponseSchema>>;
  renameSession(input: z.infer<typeof DesktopBridgeInputSchemas.renameSession>): Promise<z.infer<typeof SessionReadResultSchema>>;
  deleteSession(sessionId: string): Promise<z.infer<typeof SessionDeleteResponseSchema>>;
  listProjects(): Promise<z.infer<typeof ProjectSummarySchema>[]>;
  openLocalProject(input: z.infer<typeof DesktopBridgeInputSchemas.openLocalProject>): Promise<z.infer<typeof ProjectSummarySchema> | undefined>;
  revealProject(projectId: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  openProjectFile(projectId: string): Promise<void>;
  getModelConfig(): Promise<z.infer<typeof PublicModelConfigResponseSchema>>;
  configureModel(input: z.infer<typeof ModelConfigUpdateRequestSchema>): Promise<z.infer<typeof PublicModelConfigResponseSchema>>;
  listMemoryControl(): Promise<MemoryControlListResponse>;
  createMemoryCandidate(input: MemoryCandidateCreateRequest): Promise<MemoryControlItem>;
  reviewMemory(memoryId: string, input: MemoryReviewRequest): Promise<MemoryControlItem>;
  correctMemory(memoryId: string, input: MemoryCorrectionRequest): Promise<MemoryControlItem>;
  revokeMemory(memoryId: string, input: MemoryRevokeRequest): Promise<MemoryControlItem>;
  deleteMemory(memoryId: string, input: MemoryDeleteRequest): Promise<MemoryDeleteResponse>;
  listExperienceCases(): Promise<ExperienceControlListResponse>;
  reviewExperienceCase(caseId: string, input: ExperienceLifecycleReviewRequest): Promise<ExperienceLifecycleReviewResponse>;
};
