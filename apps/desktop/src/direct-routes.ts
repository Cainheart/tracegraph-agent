import {
  ProjectFileListRequestSchema,ProjectFileReadRequestSchema,ProjectFileSaveRequestSchema,ProjectFileReconcileRequestSchema,ProjectFileListSchema,ProjectFileSnapshotSchema,ProjectFileSaveResultSchema,AnswerFeedbackSnapshotSchema,AnswerFeedbackRequestSchema,
  ModelConnectionsSnapshotSchema,ModelConnectionSaveRequestSchema,ModelConnectionSchema,ModelConnectionRemoveRequestSchema,SessionRunOptionsSnapshotSchema,SessionRunOptionsUpdateRequestSchema,PermissionGrantSchema,PermissionGrantUpdateRequestSchema,
  AttachmentMediaTypeSchema, AttachmentStageReceiptSchema, AttachmentUploadRequestSchema,
  CreateTeamRequestSchema, ExtensionCommandInvocationSchema, ExtensionCommandResultSchema,
  ExtensionReloadCommandSchema, ExtensionStatusSchema, IdentifierSchema, LspStatusSnapshotSchema,
  MAX_ATTACHMENT_BYTES, MCP_SERVER_NAME_SCHEMA, McpRestartRequestSchema, McpServerStatusSchema,
  McpStatusSnapshotSchema, PermissionPresetUpdateRequestSchema, PermissionSettingsResponseSchema,
  ProjectSummarySchema, ReplayDiffSchema, ReplaySessionResponseSchema, ReplaySnapshotRequestSchema,
  RollbackActionRequestSchema, RunProjectionSchema, Sha256Schema, SkillProjectInspectionSchema,
  TeamHeartbeatRequestSchema, TeamMailboxClaimRequestSchema, TeamMailboxSendRequestSchema,
  TeamMutationResultSchema, TeamReadResponseSchema, TeamSweepLostMembersRequestSchema,
  TeamTaskWriteRequestSchema, TelemetryStatusSchema, UsageSnapshotSchema,
  HostCapabilitiesSchema, ModelConnectionTestRequestSchema, ModelConnectionTestResultSchema,
  WorkbenchSettingsSnapshotSchema, UpdateWorkbenchSettingsRequestSchema, WorkbenchResourcesSchema,
  WorkbenchCommandRequestSchema, WorkbenchCommandResultSchema,
  ImageProviderConfigUpdateSchema, ImageProviderConfigSnapshotSchema, StartMediaRunRequestSchema, MediaMimeTypeSchema, MAX_GENERATED_IMAGE_BYTES,
} from "@tracegraph/contracts";
import type { TraceGraphClient, AttachmentContentResponse } from "@tracegraph/sdk";
import { z } from "zod";

const BytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= MAX_ATTACHMENT_BYTES, "Attachment bytes exceed the product limit");
const CommandOptionsSchema = z.object({ command_id: IdentifierSchema.optional() }).strict();
export const DesktopAttachmentUploadSchema = z.object({ metadata: AttachmentUploadRequestSchema, bytes: BytesSchema }).strict();
export const DesktopAttachmentContentSchema = z.object({ attachmentId: IdentifierSchema, mediaType: AttachmentMediaTypeSchema, sha256: Sha256Schema, bytes: BytesSchema }).strict();
export const DesktopArtifactContentSchema = z.object({ artifactId: IdentifierSchema, mediaType: MediaMimeTypeSchema, sha256: Sha256Schema, bytes: z.custom<Uint8Array>((value)=>value instanceof Uint8Array&&value.byteLength>0&&value.byteLength<=MAX_GENERATED_IMAGE_BYTES,"Artifact bytes exceed the product limit") }).strict();

/** Each entry binds one fixed renderer method to one public typed SDK method. */
export const DIRECT_DESKTOP_ROUTES = {
  listProjectFiles:{input:z.tuple([IdentifierSchema,ProjectFileListRequestSchema.optional()]),output:ProjectFileListSchema},
  readProjectFile:{input:z.tuple([IdentifierSchema,ProjectFileReadRequestSchema]),output:ProjectFileSnapshotSchema},
  saveProjectFile:{input:z.tuple([IdentifierSchema,ProjectFileSaveRequestSchema]),output:ProjectFileSaveResultSchema},
  reconcileProjectFileSave:{input:z.tuple([IdentifierSchema,ProjectFileReconcileRequestSchema]),output:ProjectFileSaveResultSchema},
  getAnswerFeedback:{input:z.tuple([IdentifierSchema]),output:AnswerFeedbackSnapshotSchema},
  setAnswerFeedback:{input:z.tuple([IdentifierSchema,AnswerFeedbackRequestSchema]),output:AnswerFeedbackSnapshotSchema},
  getModelConnections:{input:z.tuple([]),output:ModelConnectionsSnapshotSchema},
  saveModelConnection:{input:z.tuple([ModelConnectionSaveRequestSchema]),output:ModelConnectionsSnapshotSchema},
  removeModelConnection:{input:z.tuple([IdentifierSchema,ModelConnectionRemoveRequestSchema]),output:ModelConnectionsSnapshotSchema},
  testModelConnection:{input:z.tuple([IdentifierSchema,ModelConnectionTestRequestSchema]),output:ModelConnectionTestResultSchema},
  getSessionRunOptions:{input:z.tuple([IdentifierSchema]),output:SessionRunOptionsSnapshotSchema},
  updateSessionRunOptions:{input:z.tuple([IdentifierSchema,SessionRunOptionsUpdateRequestSchema]),output:SessionRunOptionsSnapshotSchema},
  getPermissionGrant:{input:z.tuple([]),output:PermissionGrantSchema},
  setPermissionGrant:{input:z.tuple([PermissionGrantUpdateRequestSchema]),output:PermissionGrantSchema},
  getImageConfig: { input: z.tuple([]), output: ImageProviderConfigSnapshotSchema },
  configureImageProvider: { input: z.tuple([ImageProviderConfigUpdateSchema]), output: ImageProviderConfigSnapshotSchema },
  clearImageProvider: { input: z.tuple([]), output: ImageProviderConfigSnapshotSchema },
  startMediaRun: { input: z.tuple([StartMediaRunRequestSchema]), output: RunProjectionSchema },
  getArtifactContent: { input: z.tuple([IdentifierSchema,IdentifierSchema]), output: DesktopArtifactContentSchema },
  getWorkbenchSettings: { input: z.tuple([]), output: WorkbenchSettingsSnapshotSchema },
  updateWorkbenchSettings: { input: z.tuple([UpdateWorkbenchSettingsRequestSchema]), output: WorkbenchSettingsSnapshotSchema },
  getCapabilities: { input: z.tuple([]), output: HostCapabilitiesSchema },
  testModel: { input: z.tuple([ModelConnectionTestRequestSchema.optional()]), output: ModelConnectionTestResultSchema },
  getWorkbenchResources: { input: z.tuple([]), output: WorkbenchResourcesSchema },
  workbenchCommand: { input: z.tuple([WorkbenchCommandRequestSchema]), output: WorkbenchCommandResultSchema },
  createProject: { input: z.tuple([z.object({ name: z.string().min(1).max(200), template: z.literal("typescript").optional() }).strict()]), output: ProjectSummarySchema },
  getPermissionConfig: { input: z.tuple([]), output: PermissionSettingsResponseSchema },
  configurePermissionPreset: { input: z.tuple([PermissionPresetUpdateRequestSchema.extend({ command_id: IdentifierSchema.optional() })]), output: PermissionSettingsResponseSchema },
  getTelemetryStatus: { input: z.tuple([]), output: TelemetryStatusSchema },
  getUsage: { input: z.tuple([]), output: UsageSnapshotSchema },
  listExtensions: { input: z.tuple([]), output: ExtensionStatusSchema.array().max(64) },
  listSkills: { input: z.tuple([]), output: SkillProjectInspectionSchema.array().max(256) },
  getMcpStatus: { input: z.tuple([]), output: McpStatusSnapshotSchema },
  getLspStatus: { input: z.tuple([]), output: LspStatusSnapshotSchema },
  restartMcpServer: { input: z.tuple([MCP_SERVER_NAME_SCHEMA, CommandOptionsSchema.optional()]), output: McpServerStatusSchema },
  reloadExtension: { input: z.tuple([IdentifierSchema, ExtensionReloadCommandSchema.omit({ extension_name: true }).partial().optional()]), output: ExtensionStatusSchema },
  runExtensionCommand: { input: z.tuple([IdentifierSchema, ExtensionCommandInvocationSchema.omit({ name: true }).partial().optional()]), output: ExtensionCommandResultSchema },
  createReplay: { input: z.tuple([ReplaySnapshotRequestSchema]), output: ReplaySessionResponseSchema },
  getReplayDiff: { input: z.tuple([z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict()]), output: ReplayDiffSchema },
  exitReplay: { input: z.tuple([]), output: z.void() },
  getAttachmentContent: { input: z.tuple([IdentifierSchema, IdentifierSchema]), output: DesktopAttachmentContentSchema },
  getSubagent: { input: z.tuple([IdentifierSchema, IdentifierSchema]), output: RunProjectionSchema },
  getTeam: { input: z.tuple([IdentifierSchema]), output: TeamReadResponseSchema },
  createTeam: { input: z.tuple([IdentifierSchema, CreateTeamRequestSchema.partial().optional()]), output: TeamMutationResultSchema },
  sendTeamMailbox: { input: z.tuple([IdentifierSchema, TeamMailboxSendRequestSchema.extend({ command_id: IdentifierSchema.optional() })]), output: TeamMutationResultSchema },
  claimTeamMailbox: { input: z.tuple([IdentifierSchema, TeamMailboxClaimRequestSchema.extend({ command_id: IdentifierSchema.optional() })]), output: TeamMutationResultSchema },
  writeTeamTask: { input: z.tuple([IdentifierSchema, TeamTaskWriteRequestSchema.extend({ command_id: IdentifierSchema.optional() })]), output: TeamMutationResultSchema },
  heartbeatTeam: { input: z.tuple([IdentifierSchema, TeamHeartbeatRequestSchema.partial().optional()]), output: TeamMutationResultSchema },
  sweepLostTeamMembers: { input: z.tuple([IdentifierSchema, TeamSweepLostMembersRequestSchema.partial().optional()]), output: TeamMutationResultSchema },
  rollbackAction: { input: z.tuple([IdentifierSchema, IdentifierSchema, RollbackActionRequestSchema.partial().optional()]), output: RunProjectionSchema },
} as const;

export type DirectDesktopOperation = keyof typeof DIRECT_DESKTOP_ROUTES;
export type DirectDesktopBridgeApi = Omit<Pick<TraceGraphClient, DirectDesktopOperation>, "exitReplay"> & {
  exitReplay(): Promise<void>;
  uploadAttachment(input: z.infer<typeof DesktopAttachmentUploadSchema>): Promise<z.infer<typeof AttachmentStageReceiptSchema>>;
  getAttachmentContent(runId: string, attachmentId: string): Promise<AttachmentContentResponse>;
};

export async function invokeDirectDesktopRoute(client: TraceGraphClient, operation: DirectDesktopOperation, args: unknown[]): Promise<unknown> {
  const route = DIRECT_DESKTOP_ROUTES[operation];
  const parsed = route.input.parse(args);
  const method = client[operation] as (...input: unknown[]) => unknown;
  return route.output.parse(await method.apply(client, parsed));
}
