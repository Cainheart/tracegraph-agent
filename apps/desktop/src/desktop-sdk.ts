import type {
  ArtifactWireResponse,
  RunProjection,
  SessionListQuery,
  SessionListResponse,
  SessionReadResult,
  SessionRecoveryReport,
  TodoList,
  MemoryCandidateCreateRequest,
  MemoryReviewRequest,
  MemoryCorrectionRequest,
  MemoryRevokeRequest,
  ExperienceLifecycleReviewRequest,
} from "@tracegraph/contracts";
import { NativeRunNavigationSchema, HostConnectionSnapshotSchema, HostConnectionError, MigrationPreviewSnapshotSchema, MigrationCommitReceiptSchema } from "@tracegraph/contracts";
import type { HostCapabilities } from "@tracegraph/contracts";
import type { DesktopBridgeApi } from "./bridge-contract.js";
import { DesktopStreamPacketSchema, type DesktopStreamOpenInput } from "./stream-contract.js";
import { DesktopMigrationOutcomeSchema } from "./migration-contract.js";
import type { TraceGraphSdkPort } from "@tracegraph/workbench";

type StartRunInput = Parameters<TraceGraphSdkPort["startRun"]>[0];
type ApprovalCommand = Parameters<TraceGraphSdkPort["approve"]>[1];
type RejectCommand = Parameters<TraceGraphSdkPort["reject"]>[1];
type StopCommand = Parameters<TraceGraphSdkPort["stop"]>[1];

export class DesktopHostOperationUnavailableError extends Error {
  constructor(operation: string) {
    super(`The current Desktop Host does not support ${operation}`);
    this.name = "DesktopHostOperationUnavailableError";
  }
}

/** Adapts fixed private Host methods into the shared Workbench port. */
export function createDesktopSdkPort(bridge: DesktopBridgeApi): TraceGraphSdkPort & Pick<DesktopBridgeApi, "previewMigration" | "commitMigration" | "startHost" | "getMigrationResult" | "getConnectionStatus" | "copyText" | "listProjectFiles" | "readProjectFile" | "saveProjectFile" | "reconcileProjectFileSave" | "getAnswerFeedback" | "setAnswerFeedback" | "getModelConnections" | "saveModelConnection" | "removeModelConnection" | "testModelConnection" | "testModelCapabilities" | "getModelCapabilityTestReceipt" | "getSessionRunOptions" | "updateSessionRunOptions" | "getPermissionGrant" | "setPermissionGrant" | "listManagedSkills" | "readManagedSkill" | "validateManagedSkill" | "managedSkillCommand" | "getManagedSkillCommandReceipt" | "getVisualRetentionSettings" | "updateVisualRetentionSettings" | "listVisualEvidence" | "pinVisualEvidence" | "cleanupVisualEvidence" | "getVisualEvidenceCommandReceipt"> {
  return {
    ...(bridge.onNativeRunRequested ? {onNativeRunRequested: (listener: Parameters<NonNullable<DesktopBridgeApi["onNativeRunRequested"]>>[0]) => bridge.onNativeRunRequested!(navigation=>listener(NativeRunNavigationSchema.parse(navigation)))} : {}),
    listProjectFiles:(...args:Parameters<DesktopBridgeApi["listProjectFiles"]>)=>bridge.listProjectFiles(...args),
    readProjectFile:(...args:Parameters<DesktopBridgeApi["readProjectFile"]>)=>bridge.readProjectFile(...args),
    saveProjectFile:(...args:Parameters<DesktopBridgeApi["saveProjectFile"]>)=>bridge.saveProjectFile(...args),
    reconcileProjectFileSave:(...args:Parameters<DesktopBridgeApi["reconcileProjectFileSave"]>)=>bridge.reconcileProjectFileSave(...args),
    getAnswerFeedback:(...args:Parameters<DesktopBridgeApi["getAnswerFeedback"]>)=>bridge.getAnswerFeedback(...args),
    setAnswerFeedback:(...args:Parameters<DesktopBridgeApi["setAnswerFeedback"]>)=>bridge.setAnswerFeedback(...args),
    getModelConnections:(...args:Parameters<DesktopBridgeApi["getModelConnections"]>)=>bridge.getModelConnections(...args),
    saveModelConnection:(...args:Parameters<DesktopBridgeApi["saveModelConnection"]>)=>bridge.saveModelConnection(...args),
    removeModelConnection:(...args:Parameters<DesktopBridgeApi["removeModelConnection"]>)=>bridge.removeModelConnection(...args),
    testModelConnection:(...args:Parameters<DesktopBridgeApi["testModelConnection"]>)=>bridge.testModelConnection(...args),
    testModelCapabilities:(...args:Parameters<DesktopBridgeApi["testModelCapabilities"]>)=>bridge.testModelCapabilities(...args),
    getModelCapabilityTestReceipt:(...args:Parameters<DesktopBridgeApi["getModelCapabilityTestReceipt"]>)=>bridge.getModelCapabilityTestReceipt(...args),
    getSessionRunOptions:(...args:Parameters<DesktopBridgeApi["getSessionRunOptions"]>)=>bridge.getSessionRunOptions(...args),
    updateSessionRunOptions:(...args:Parameters<DesktopBridgeApi["updateSessionRunOptions"]>)=>bridge.updateSessionRunOptions(...args),
    getPermissionGrant:(...args:Parameters<DesktopBridgeApi["getPermissionGrant"]>)=>bridge.getPermissionGrant(...args),
    setPermissionGrant:(...args:Parameters<DesktopBridgeApi["setPermissionGrant"]>)=>bridge.setPermissionGrant(...args),
    getConnectionStatus:()=>bridge.getConnectionStatus().then(value=>HostConnectionSnapshotSchema.parse(value)),
    copyText:(text:string)=>bridge.copyText(text),
    getImageConfig() { return bridge.getImageConfig(); },
    configureImageProvider(input) { return bridge.configureImageProvider(input); },
    clearImageProvider() { return bridge.clearImageProvider(); },
    startMediaRun(input) { return bridge.startMediaRun(input); },
    getArtifactContent(runId,artifactId) { return bridge.getArtifactContent(runId,artifactId); },
    startHost() { return bridge.startHost(); },
    async getMigrationResult() { const result = await bridge.getMigrationResult(); return result === undefined ? undefined : DesktopMigrationOutcomeSchema.parse(result); },
    async previewMigration() { const result = await bridge.previewMigration(); return result === undefined ? undefined : MigrationPreviewSnapshotSchema.parse(result); },
    async commitMigration(input) { return MigrationCommitReceiptSchema.parse(await bridge.commitMigration(input)); },
    async bootstrap() {
      const status = await bridge.getHostStatus();
      if (status.state !== "ready") throw new Error(status.message);
      return {
        // The private connection authority remains in Main. Renderers only need
        // a bootstrap-shaped readiness marker, never the local Host bearer.
        token: "desktop-local-host",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        recovery: status.recovery as SessionRecoveryReport,
      };
    },
    async listProjects() {
      return bridge.listProjects();
    },
    async openLocalProject(input) {
      return bridge.openLocalProject({ access: input?.access ?? "read_write" });
    },
    revealProject(projectId) {
      return bridge.revealProject(projectId);
    },
    removeProject(projectId) {
      return bridge.removeProject(projectId);
    },
    openProjectFile(projectId) {
      return bridge.openProjectFile(projectId);
    },
    openPreview(previewId) { return bridge.openPreview(previewId); },
    closePreview() { return bridge.closePreview(); },
    createProject(input) { return bridge.createProject(input); },
    getPermissionConfig() { return bridge.getPermissionConfig(); },
    configurePermissionPreset(input) { return bridge.configurePermissionPreset({ ...input, command_id: input.command_id ?? createCommandId() }); },
    getTelemetryStatus() { return bridge.getTelemetryStatus(); },
    getUsage() { return bridge.getUsage(); },
    listExtensions() { return bridge.listExtensions(); },
    reloadExtension(name) { return bridge.reloadExtension(name); },
    listSkills() { return bridge.listSkills(); },
    getMcpStatus() { return bridge.getMcpStatus(); },
    restartMcpServer(name, input) { return bridge.restartMcpServer(name, input); },
    getLspStatus() { return bridge.getLspStatus(); },
    getBrowserCommandReceipt:(...args:Parameters<DesktopBridgeApi["getBrowserCommandReceipt"]>)=>bridge.getBrowserCommandReceipt(...args),
    getComputerStatus:(...args:Parameters<DesktopBridgeApi["getComputerStatus"]>)=>bridge.getComputerStatus(...args),
    listComputerTargets:(...args:Parameters<DesktopBridgeApi["listComputerTargets"]>)=>bridge.listComputerTargets(...args),
    requestComputerGrant:(...args:Parameters<DesktopBridgeApi["requestComputerGrant"]>)=>bridge.requestComputerGrant(...args),
    revokeComputerGrant:(...args:Parameters<DesktopBridgeApi["revokeComputerGrant"]>)=>bridge.revokeComputerGrant(...args),
    acquireComputerLease:(...args:Parameters<DesktopBridgeApi["acquireComputerLease"]>)=>bridge.acquireComputerLease(...args),
    resumeComputerLease:(...args:Parameters<DesktopBridgeApi["resumeComputerLease"]>)=>bridge.resumeComputerLease(...args),
    releaseComputerLease:(...args:Parameters<DesktopBridgeApi["releaseComputerLease"]>)=>bridge.releaseComputerLease(...args),
    observeComputer:(...args:Parameters<DesktopBridgeApi["observeComputer"]>)=>bridge.observeComputer(...args),
    computerAction:(...args:Parameters<DesktopBridgeApi["computerAction"]>)=>bridge.computerAction(...args),
    getComputerCommandReceipt:(...args:Parameters<DesktopBridgeApi["getComputerCommandReceipt"]>)=>bridge.getComputerCommandReceipt(...args),
    getComputerCapture:(...args:Parameters<DesktopBridgeApi["getComputerCapture"]>)=>bridge.getComputerCapture(...args),
    listManagedSkills:(...args:Parameters<DesktopBridgeApi["listManagedSkills"]>)=>bridge.listManagedSkills(...args),
    readManagedSkill:(...args:Parameters<DesktopBridgeApi["readManagedSkill"]>)=>bridge.readManagedSkill(...args),
    validateManagedSkill:(...args:Parameters<DesktopBridgeApi["validateManagedSkill"]>)=>bridge.validateManagedSkill(...args),
    managedSkillCommand:(...args:Parameters<DesktopBridgeApi["managedSkillCommand"]>)=>bridge.managedSkillCommand(...args),
    getManagedSkillCommandReceipt:(...args:Parameters<DesktopBridgeApi["getManagedSkillCommandReceipt"]>)=>bridge.getManagedSkillCommandReceipt(...args),
    getVisualRetentionSettings:(...args:Parameters<DesktopBridgeApi["getVisualRetentionSettings"]>)=>bridge.getVisualRetentionSettings(...args),
    updateVisualRetentionSettings:(...args:Parameters<DesktopBridgeApi["updateVisualRetentionSettings"]>)=>bridge.updateVisualRetentionSettings(...args),
    listVisualEvidence:(...args:Parameters<DesktopBridgeApi["listVisualEvidence"]>)=>bridge.listVisualEvidence(...args),
    pinVisualEvidence:(...args:Parameters<DesktopBridgeApi["pinVisualEvidence"]>)=>bridge.pinVisualEvidence(...args),
    cleanupVisualEvidence:(...args:Parameters<DesktopBridgeApi["cleanupVisualEvidence"]>)=>bridge.cleanupVisualEvidence(...args),
    getVisualEvidenceCommandReceipt:(...args:Parameters<DesktopBridgeApi["getVisualEvidenceCommandReceipt"]>)=>bridge.getVisualEvidenceCommandReceipt(...args),
    getPersonalProfile:(...args:Parameters<DesktopBridgeApi["getPersonalProfile"]>)=>bridge.getPersonalProfile(...args),
    updatePersonalProfile:(...args:Parameters<DesktopBridgeApi["updatePersonalProfile"]>)=>bridge.updatePersonalProfile(...args),
    getPersonalProfileCommandReceipt:(...args:Parameters<DesktopBridgeApi["getPersonalProfileCommandReceipt"]>)=>bridge.getPersonalProfileCommandReceipt(...args),
    queryPersonalUsage:(...args:Parameters<DesktopBridgeApi["queryPersonalUsage"]>)=>bridge.queryPersonalUsage(...args),
    searchPublicSessions:(...args:Parameters<DesktopBridgeApi["searchPublicSessions"]>)=>bridge.searchPublicSessions(...args),
    getBrowserStatus:(...args:Parameters<DesktopBridgeApi["getBrowserStatus"]>)=>bridge.getBrowserStatus(...args),
    requestBrowserGrant:(...args:Parameters<DesktopBridgeApi["requestBrowserGrant"]>)=>bridge.requestBrowserGrant(...args),
    browserCommand:(...args:Parameters<DesktopBridgeApi["browserCommand"]>)=>bridge.browserCommand(...args),
    observeBrowser:(...args:Parameters<DesktopBridgeApi["observeBrowser"]>)=>bridge.observeBrowser(...args),
    getBrowserEvidence:(...args:Parameters<DesktopBridgeApi["getBrowserEvidence"]>)=>bridge.getBrowserEvidence(...args),
    listGoals:(...args:Parameters<DesktopBridgeApi["listGoals"]>)=>bridge.listGoals(...args),
    createGoal:(...args:Parameters<DesktopBridgeApi["createGoal"]>)=>bridge.createGoal(...args),
    getGoal:(...args:Parameters<DesktopBridgeApi["getGoal"]>)=>bridge.getGoal(...args),
    goalCommand:(...args:Parameters<DesktopBridgeApi["goalCommand"]>)=>bridge.goalCommand(...args),
    getGoalCreationReceipt:(...args:Parameters<DesktopBridgeApi["getGoalCreationReceipt"]>)=>bridge.getGoalCreationReceipt(...args),
    getGoalCommandReceipt:(...args:Parameters<DesktopBridgeApi["getGoalCommandReceipt"]>)=>bridge.getGoalCommandReceipt(...args),
    getGoalBudget:(...args:Parameters<DesktopBridgeApi["getGoalBudget"]>)=>bridge.getGoalBudget(...args),
    getWorkbenchSettingsHistory:(...args:Parameters<DesktopBridgeApi["getWorkbenchSettingsHistory"]>)=>bridge.getWorkbenchSettingsHistory(...args),
    restoreWorkbenchSettings:(...args:Parameters<DesktopBridgeApi["restoreWorkbenchSettings"]>)=>bridge.restoreWorkbenchSettings(...args),
    getProjectRunDefaults:(...args:Parameters<DesktopBridgeApi["getProjectRunDefaults"]>)=>bridge.getProjectRunDefaults(...args),
    updateProjectRunDefaults:(...args:Parameters<DesktopBridgeApi["updateProjectRunDefaults"]>)=>bridge.updateProjectRunDefaults(...args),
    resetSessionRunOptions:(...args:Parameters<DesktopBridgeApi["resetSessionRunOptions"]>)=>bridge.resetSessionRunOptions(...args),
    getWorkbenchSettings() { return bridge.getWorkbenchSettings(); },
    updateWorkbenchSettings(input) { return bridge.updateWorkbenchSettings(input); },
    async getCapabilities() {
      const snapshot: HostCapabilities=await bridge.getCapabilities();
      return { ...snapshot, capabilities: [...snapshot.capabilities,
        { operation: "host.start", state: "available" as const, scope: "profile" as const, requires_restart: false },
        { operation: "projects.open.native", state: "available" as const, reason: "Native explicit folder selection", scope: "profile" as const, requires_restart: false },
        { operation: "migration.result", state: "available" as const, scope: "profile" as const, requires_restart: false },
        { operation: "preview.open", state: "available" as const, reason: "Isolated Desktop project preview", scope: "profile" as const, requires_restart: false },
        { operation: "migration.preview", state: "available" as const, reason: "Native source selection", scope: "profile" as const, requires_restart: false },
        { operation: "migration.commit", state: "available" as const, reason: "Native source selection and backup-first Host migration", scope: "profile" as const, requires_restart: true },
      ] };
    },
    testModel(input) { return bridge.testModel(input); },
    getWorkbenchResources() { return bridge.getWorkbenchResources(); },
    workbenchCommand(input) { return bridge.workbenchCommand(input); },
    createReplay(input) { return bridge.createReplay(input); },
    getReplayDiff(input) { return bridge.getReplayDiff(input); },
    exitReplay() { void bridge.exitReplay(); },
    getSubagent(parentRunId, subagentId) { return bridge.getSubagent(parentRunId, subagentId); },
    createTeam(runId, request) { return bridge.createTeam(runId, request); },
    sendTeamMailbox(runId, request) { return bridge.sendTeamMailbox(runId, { ...request, command_id: request.command_id ?? createCommandId() }); },
    writeTeamTask(runId, request) { return bridge.writeTeamTask(runId, { ...request, command_id: request.command_id ?? createCommandId() }); },
    rollbackAction(runId, actionId, input) { return bridge.rollbackAction(runId, actionId, input); },
    async uploadAttachment(input) {
      const { bytes, ...metadata } = input;
      const value = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      return bridge.uploadAttachment({ metadata: { ...metadata, command_id: metadata.command_id ?? createCommandId() }, bytes: value });
    },
    async getAttachmentContent(runId, attachmentId) {
      const content = await bridge.getAttachmentContent(runId, attachmentId);
      return { ...content, bytes: new Uint8Array(content.bytes) };
    },
    getModelConfig() {
      return bridge.getModelConfig();
    },
    configureModel(input) {
      return bridge.configureModel(input);
    },
    listMemoryControl() {
      return bridge.listMemoryControl();
    },
    createMemoryCandidate(input) {
      return bridge.createMemoryCandidate({ ...input, command_id: input.command_id ?? createCommandId() } as MemoryCandidateCreateRequest);
    },
    reviewMemory(memoryId, input) {
      return bridge.reviewMemory(memoryId, { ...input, command_id: input.command_id ?? createCommandId() } as MemoryReviewRequest);
    },
    correctMemory(memoryId, input) {
      return bridge.correctMemory(memoryId, { ...input, command_id: input.command_id ?? createCommandId() } as MemoryCorrectionRequest);
    },
    revokeMemory(memoryId, input) {
      return bridge.revokeMemory(memoryId, { ...input, command_id: input.command_id ?? createCommandId() } as MemoryRevokeRequest);
    },
    deleteMemory(memoryId) {
      return bridge.deleteMemory(memoryId, { command_id: createCommandId() });
    },
    listExperienceCases() {
      return bridge.listExperienceCases();
    },
    reviewExperienceCase(caseId, input) {
      return bridge.reviewExperienceCase(caseId, {
        ...input,
        command_id: input.command_id ?? createCommandId(),
      } as ExperienceLifecycleReviewRequest);
    },
    listSessions(input?: SessionListQuery): Promise<SessionListResponse> {
      return bridge.listSessions(input ?? { view: "roots", limit: 50 });
    },
    getSession(sessionId: string): Promise<SessionReadResult> {
      return bridge.getSession(sessionId);
    },
    renameSession(sessionId, input) { return bridge.renameSession({ session_id: sessionId, input }); },
    deleteSession(sessionId) { return bridge.deleteSession(sessionId); },
    resumeSession(sessionId, input) { return bridge.resumeSession({ session_id: sessionId, input: { command_id: input?.command_id ?? createCommandId() } }); },
    startChat(input) { return bridge.startChat(input); },
    async startRun(input: StartRunInput): Promise<RunProjection> {
      const { command_id: _commandId, ...request } = input;
      return bridge.startRun({ ...request, command_id: input.command_id });
    },
    approve(runId: string, command: ApprovalCommand): Promise<RunProjection> { assertRunId(runId, command.run_id); return bridge.approve(command); },
    approvePlan(runId, input) { return bridge.approvePlan({ run_id: runId, input: { ...input, command_id: input.command_id ?? createCommandId() } }); },
    getTodos(runId: string): Promise<TodoList> { return bridge.getTodos(runId); },
    writeTodo(runId, request) { return bridge.writeTodo({ run_id: runId, input: { ...request, command_id: request.command_id ?? createCommandId() } }); },
    submitUserInput(runId, request) { return bridge.submitUserInput({ run_id: runId, input: { ...request, command_id: request.command_id ?? createCommandId(), input_id: request.input_id ?? createCommandId() } }); },
    reject(runId: string, command: RejectCommand): Promise<RunProjection> { assertRunId(runId, command.run_id); return bridge.reject(command); },
    stop(runId: string, command: StopCommand): Promise<RunProjection> { assertRunId(runId, command.run_id); return bridge.stop(command); },
    getRun(runId: string): Promise<RunProjection> { return bridge.getRun(runId); },
    getArtifact(runId: string, artifactId: string): Promise<ArtifactWireResponse> { return bridge.getArtifact({ run_id: runId, artifact_id: artifactId }); },
    async *streamEvents(runId, options) {
      for await (const packet of streamPackets(bridge, { kind: "ledger", run_id: runId, after: options.afterSequence ?? 0, reconnect: options.reconnect ?? true }, options.signal)) {
        if (packet.state === "event" && packet.kind === "ledger") yield packet.value;
      }
    },
    async *streamLiveActivities(runId, options) {
      for await (const packet of streamPackets(bridge, { kind: "activity", run_id: runId, after: options.afterSequence ?? 0, reconnect: options.reconnect ?? true }, options.signal)) {
        if (packet.state === "event" && packet.kind === "activity") yield packet.value;
      }
    },
    async *streamModelSurface(runId, options) {
      for await (const packet of streamPackets(bridge, { kind: "model_surface", run_id: runId, after: options.afterCursor ?? 0, reconnect: options.reconnect ?? true }, options.signal)) {
        if (packet.state === "event" && packet.kind === "model_surface" && packet.value.type !== "thinking_snapshot") yield packet.value;
      }
    },
  };
}

function assertRunId(expected: string, command: string): void {
  if (expected !== command) throw new Error("Run command identity does not match the selected Run");
}

function createCommandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function* streamPackets(bridge: DesktopBridgeApi, input: DesktopStreamOpenInput, signal?: AbortSignal) {
  if (signal?.aborted) return;
  const connection=bridge.getConnectionStatus?await bridge.getConnectionStatus():undefined;
  const generation=connection?.generation;
  const id = await bridge.openStream({...input,...(generation===undefined?{}:{generation})});
  const abort = (): void => { void bridge.closeStream(id).catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) return;
    while (!signal?.aborted) {
      const packet = DesktopStreamPacketSchema.parse(await bridge.readStream(id));
      if(generation!==undefined&&packet.generation!==undefined&&packet.generation!==generation)throw new HostConnectionError({state:"reconnecting",generation,code:"host_read_stale",message:"The Host stream owner changed. Read the current projection before reconnecting."});
      if (signal?.aborted || packet.state === "end") return;
      if (packet.state === "error") throw new Error(packet.message);
      yield packet;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await bridge.closeStream(id).catch(()=>undefined);
  }
}
