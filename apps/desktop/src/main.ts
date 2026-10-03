import { app, BrowserWindow, dialog, ipcMain, session, shell, clipboard, type IpcMainInvokeEvent } from "electron";
import { basename, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MigrationPreviewSnapshotSchema, MigrationCommitReceiptSchema, ProjectSummarySchema, type SessionRecoveryReport, HostConnectionError, HostConnectionSnapshotSchema, HostConnectionCodeSchema } from "@tracegraph/contracts";
import { DESKTOP_HOST_PACKAGE_VERSION, LocalHostConnectionSupervisor, connectLocalHost, type ConnectedLocalHost, type LegacyMigrationSource } from "@tracegraph/desktop-host";
import { DesktopBridgeInputSchemas, DesktopBridgeOutputSchemas, DesktopHostStatusSchema } from "./bridge-contract.js";
import { DIRECT_DESKTOP_ROUTES, DesktopAttachmentUploadSchema, invokeDirectDesktopRoute, type DirectDesktopOperation } from "./direct-routes.js";
import { DESKTOP_IPC } from "./ipc-channels.js";
import { openInConfiguredEditor, resolveProjectFileSelection } from "./native-files.js";
import { DesktopStreamManager } from "./stream-bridge.js";
import { NativePreviewManager } from "./native-preview.js";
import { DesktopMigrationOutcomeSchema } from "./migration-contract.js";
import { z } from "zod";
import {TraceGraphHttpError,TraceGraphMutationPreflightError} from "@tracegraph/sdk";

const appDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererPath = resolve(appDirectory, "renderer/index.html");
const preloadPath = resolve(appDirectory, "preload.cjs");
const previewMode = process.argv.includes("--preview");
let desktopHost: ConnectedLocalHost | null = null;
let supervisor: LocalHostConnectionSupervisor | null = null;
let streams: DesktopStreamManager | null = null;
let recovery: SessionRecoveryReport = { scanned_sessions: 0, truncated_session_ids: [], interrupted_run_ids: [], reconciled_action_ids: [], aborted_action_ids: [], diverged_action_ids: [], recovered_at: new Date().toISOString() };
let hostFailure: string | null = null;
let mainWindow: BrowserWindow | null = null;
let isClosing = false;
const previews = new NativePreviewManager();
let migrationSources: LegacyMigrationSource[] = [];
let migrationBusy = false;
let reconnecting: Promise<void> | undefined;
let pendingMigration: { operationId: string; profileRoot: string } | undefined;
let lastHostTarget: { profileRoot: string; httpPort: number } | undefined;

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame) throw new Error("Desktop IPC is limited to the main renderer frame");
  let requestedPath: string;
  try {
    const url = new URL(frame.url);
    if (url.protocol !== "file:") throw new Error("unexpected protocol");
    requestedPath = resolve(fileURLToPath(url));
  } catch { throw new Error("Desktop IPC sender is not the packaged renderer"); }
  if (requestedPath !== rendererPath) throw new Error("Desktop IPC sender is not the packaged renderer");
}
function requireHost(): ConnectedLocalHost {
  if (desktopHost === null) throw new Error(hostFailure ?? "The local Host is not ready");
  return desktopHost;
}
function requireStreams(): DesktopStreamManager {
  if (streams === null) throw new Error(hostFailure ?? "The local Host is not ready");
  return streams;
}
function hostGatewayPort(address: string): number {
  const url = new URL(address);
  const port = Number(url.port || "80");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The Host gateway address is invalid");
  return port;
}

const standaloneChannels=new Set<string>([DESKTOP_IPC.startHost,DESKTOP_IPC.hostStatus,DESKTOP_IPC.getConnectionStatus,DESKTOP_IPC.readStream,DESKTOP_IPC.closeStream,DESKTOP_IPC.closePreview,DESKTOP_IPC.exitReplay,DESKTOP_IPC.commitMigration,DESKTOP_IPC.copyText]);
const readChannels=new Set<string>([DESKTOP_IPC.listProjectFiles,DESKTOP_IPC.readProjectFile,DESKTOP_IPC.reconcileProjectFileSave,DESKTOP_IPC.getAnswerFeedback,DESKTOP_IPC.getModelConnections,DESKTOP_IPC.getSessionRunOptions,DESKTOP_IPC.getPermissionGrant,DESKTOP_IPC.listSessions,DESKTOP_IPC.getSession,DESKTOP_IPC.getRun,DESKTOP_IPC.getTodos,DESKTOP_IPC.getArtifact,DESKTOP_IPC.listProjects,DESKTOP_IPC.getModelConfig,DESKTOP_IPC.listMemoryControl,DESKTOP_IPC.listExperienceCases,DESKTOP_IPC.getImageConfig,DESKTOP_IPC.getArtifactContent,DESKTOP_IPC.getWorkbenchSettings,DESKTOP_IPC.getCapabilities,DESKTOP_IPC.getWorkbenchResources,DESKTOP_IPC.getPermissionConfig,DESKTOP_IPC.getTelemetryStatus,DESKTOP_IPC.getUsage,DESKTOP_IPC.listExtensions,DESKTOP_IPC.listSkills,DESKTOP_IPC.getMcpStatus,DESKTOP_IPC.getLspStatus,DESKTOP_IPC.getReplayDiff,DESKTOP_IPC.getAttachmentContent,DESKTOP_IPC.getSubagent,DESKTOP_IPC.getTeam,DESKTOP_IPC.getMigrationResult,DESKTOP_IPC.openStream]);
function registerHandler(channel:(typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC],listener:Parameters<typeof ipcMain.handle>[1]):void {
  ipcMain.handle(channel,async(event,...args:unknown[])=>{
    try {
      assertTrustedRenderer(event);
      if(standaloneChannels.has(channel))return await listener(event,...args);
      if(!supervisor)throw new HostConnectionError({state:"offline",generation:0,code:"host_offline",message:hostFailure??"The local Host is not ready"});
      const operation=async()=>listener(event,...args);
      return await (readChannels.has(channel)?supervisor.read(operation):supervisor.mutate(operation));
    }catch(error){
      // Electron strips Error custom properties. Return only this closed, sanitized transport failure.
      const record=error as {name?:string;connection?:unknown;code?:unknown};
      if(error instanceof HostConnectionError||record?.name==="HostConnectionError") {
        const connection=HostConnectionSnapshotSchema.parse(record.connection),code=HostConnectionCodeSchema.parse(record.code);
        return {__outlive_connection_error:{connection,code}};
      }
      if(error instanceof TraceGraphMutationPreflightError)return {__outlive_command_rejected:{code:"mutation_preflight_failed",admission:"rejected",commandDispatched:false}};
      if(error instanceof TraceGraphHttpError&&error.admission==="rejected")return {__outlive_command_rejected:{code:(error.body as {error:string}).error,status:401,admission:"rejected"}};
      throw error;
    }
  });
}

function registerIpcHandlers(): void {
  registerHandler(DESKTOP_IPC.copyText,async(_event,text:unknown)=>{const input=z.string().max(1024*1024).parse(text);await clipboard.writeText(input);if(await clipboard.readText()!==input)throw new Error("The clipboard write was not confirmed");});
  registerHandler(DESKTOP_IPC.getConnectionStatus,async()=>{void supervisor?.refresh();return HostConnectionSnapshotSchema.parse(supervisor?.getSnapshot()??{state:"offline",generation:0,code:"host_offline",message:hostFailure??"The local Host is not ready"});});
  registerHandler(DESKTOP_IPC.getMigrationResult, async (event) => {
    assertTrustedRenderer(event);
    if (!pendingMigration) return undefined;
    const operation = pendingMigration;
    const host = requireHost();
    if (host.status.profile_root !== operation.profileRoot) throw new Error("Migration result belongs to another profile");
    const result = await host.native.migrationResult(operation.operationId);
    const outcome = DesktopMigrationOutcomeSchema.parse({ state: result.state, operation_id: operation.operationId,
      ...(result.code ? { code: result.code } : {}), ...(result.state === "failed" ? { message: "Migration failed; the source remains unchanged. Inspect the backup and source before retrying." } : {}),
      ...(result.state === "succeeded" && result.result ? { receipt: { selected_source_id: result.result.selected_source_id, copied_files: result.result.copied_files, quarantined_source_ids: result.result.quarantined_source_ids, backup_created: true } } : {}),
    });
    if (result.state !== "queued") pendingMigration = undefined;
    return outcome;
  });
  registerHandler(DESKTOP_IPC.startHost,async()=>{
    if(migrationBusy)throw new Error("Wait for the current migration result before reconnecting");
    if(!reconnecting)reconnecting=(async()=>{if(!supervisor)await launchHost(undefined,undefined,true);else await supervisor.repair();hostFailure=null;})().finally(()=>{reconnecting=undefined;});
    await reconnecting;
  });
  registerHandler(DESKTOP_IPC.previewMigration, async (event) => {
    assertTrustedRenderer(event);
    if (migrationBusy) throw new Error("A migration is already in progress");
    if (reconnecting) throw new Error("Wait for the Host connection before importing");
    const selection = await dialog.showOpenDialog(requireMainWindow(), { title: "Select legacy Outlive data directories", buttonLabel: "Inspect sources", properties: ["openDirectory", "multiSelections"] });
    if (selection.canceled || selection.filePaths.length === 0) return undefined;
    if (selection.filePaths.length > 8) throw new Error("Select at most eight legacy sources");
    const sources = await Promise.all(selection.filePaths.map(async (path, index): Promise<LegacyMigrationSource> => {
      const dataRoot = resolve(path);
      const existing = async (name: string): Promise<string | undefined> => {
        const candidate = join(dataRoot, name);
        try { await stat(candidate); return candidate; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      };
      const sessionRoot = await existing("sessions"), modelConfigPath = await existing("model-config.json"), permissionConfigPath = await existing("harness-config.json"), credentialFile = await existing("credentials.json");
      return { id: `legacy-${index + 1}`, dataRoot, ...(sessionRoot ? { sessionRoot } : {}), ...(modelConfigPath ? { modelConfigPath } : {}), ...(permissionConfigPath ? { permissionConfigPath } : {}), ...(credentialFile ? { credentialFile } : {}) };
    }));
    const preview = await requireHost().native.previewMigration({ sources });
    migrationSources = sources;
    return MigrationPreviewSnapshotSchema.parse({
      sources: sources.map((source) => ({ source_id: source.id, label: basename(source.dataRoot), file_count: preview.files.filter((file) => file.source_id === source.id).length })),
      selected_source_id: preview.selected_source_id, requires_source_selection: preview.requires_source_selection,
      files: preview.files.map(({ path: _path, ...file }) => file), conflicts: preview.conflicts,
      active_writer_sources: preview.active_writer_sources, warnings: preview.warnings,
    });
  });
  registerHandler(DESKTOP_IPC.commitMigration, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = z.object({ source_id: z.string().min(1).max(64) }).strict().parse(input);
    if (migrationBusy) throw new Error("A migration is already in progress");
    if (reconnecting) throw new Error("Wait for the Host connection before importing");
    if (pendingMigration) throw new Error("The previous migration outcome is unknown. Inspect its persistent result before importing again.");
    if (!migrationSources.some((source) => source.id === request.source_id)) throw new Error("Inspect and select a migration source first");
    migrationBusy = true;
    await supervisor?.connection();
    const releaseMonitor=await supervisor?.pause();
    const previous = requireHost();
    try {
      const receipt = await previous.native.commitMigration({ sources: migrationSources, selectedSourceId: request.source_id });
      await streams?.closeAll();
      await previous.close();
      desktopHost = null;
      await launchHost(previous.status.profile_root);
      migrationSources = [];
      return MigrationCommitReceiptSchema.parse({ selected_source_id: receipt.selected_source_id, copied_files: receipt.copied_files, quarantined_source_ids: receipt.quarantined_source_ids, backup_created: true });
    } catch (error) {
      const operationId = typeof error === "object" && error !== null && "operation_id" in error ? error.operation_id : undefined;
      if (typeof operationId === "string" && /^[A-Za-z0-9:._-]{1,256}$/u.test(operationId)) pendingMigration = { operationId, profileRoot: previous.status.profile_root };
      // A terminal migration failure may still have retired the old owner.
      // Reconnect only to an already-running owner; never turn this recovery into a new import.
      try {
        const rebound = await connectLocalHost({ profileRoot: previous.status.profile_root });
        await streams?.closeAll(); await previous.close();
        desktopHost = rebound; streams = new DesktopStreamManager(rebound.client);
        const snapshot = await rebound.client.bootstrap(); recovery = snapshot.recovery ?? recovery;
      } catch { /* getHostStatus will report the actual unavailable old channel */ }
      throw error;
    } finally { releaseMonitor?.(); migrationBusy = false; }
  });
  registerHandler(DESKTOP_IPC.openPreview, async (event, previewId: unknown) => { assertTrustedRenderer(event); await previews.open(requireMainWindow(), requireHost().client, previewId); });
  registerHandler(DESKTOP_IPC.closePreview, (event) => { assertTrustedRenderer(event); previews.close(); });
  registerHandler(DESKTOP_IPC.hostStatus,async()=>{
    await supervisor?.refresh();
    const connection=supervisor?.getSnapshot();
    return DesktopHostStatusSchema.parse(connection?.state==="connected"&&desktopHost
      ?{state:"ready",identity:{package_name:"@tracegraph/host",package_version:DESKTOP_HOST_PACKAGE_VERSION,protocol_version:desktopHost.status.protocol_version},recovery}
      :{state:"offline",message:connection?.message??hostFailure??"The local Host is not ready"});
  });
  registerHandler(DESKTOP_IPC.listSessions, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.listSessions.parse(input);
    return DesktopBridgeOutputSchemas.listSessions.parse(await requireHost().client.listSessions(request));
  });
  registerHandler(DESKTOP_IPC.getSession, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.getSession.parse(input);
    return DesktopBridgeOutputSchemas.getSession.parse(await requireHost().client.getSession(request));
  });
  registerHandler(DESKTOP_IPC.getRun, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.getRun.parse(input);
    return DesktopBridgeOutputSchemas.getRun.parse(await requireHost().client.getRun(request));
  });
  registerHandler(DESKTOP_IPC.startRun, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.startRun.parse(input);
    return DesktopBridgeOutputSchemas.startRun.parse(await requireHost().client.startRun(request));
  });
  registerHandler(DESKTOP_IPC.startChat, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.startChat.parse(input);
    return DesktopBridgeOutputSchemas.startChat.parse(await requireHost().client.startChat(request));
  });
  registerHandler(DESKTOP_IPC.approve, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.approval.parse(input);
    if (request.type !== "approve") throw new Error("Approval route requires type=approve");
    return DesktopBridgeOutputSchemas.approval.parse(await requireHost().client.approve(request.run_id, request));
  });
  registerHandler(DESKTOP_IPC.reject, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.approval.parse(input);
    if (request.type !== "reject") throw new Error("Approval route requires type=reject");
    return DesktopBridgeOutputSchemas.approval.parse(await requireHost().client.reject(request.run_id, request));
  });
  registerHandler(DESKTOP_IPC.stop, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.stop.parse(input);
    return DesktopBridgeOutputSchemas.stop.parse(await requireHost().client.stop(request.run_id, request));
  });
  registerHandler(DESKTOP_IPC.approvePlan, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.approvePlan.parse(input);
    return DesktopBridgeOutputSchemas.approvePlan.parse(await requireHost().client.approvePlan(request.run_id, request.input));
  });
  registerHandler(DESKTOP_IPC.getTodos, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.getRun.parse(input);
    return DesktopBridgeOutputSchemas.getTodos.parse(await requireHost().client.getTodos(request));
  });
  registerHandler(DESKTOP_IPC.writeTodo, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.writeTodo.parse(input);
    return DesktopBridgeOutputSchemas.writeTodo.parse(await requireHost().client.writeTodo(request.run_id, request.input));
  });
  registerHandler(DESKTOP_IPC.submitUserInput, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.submitUserInput.parse(input);
    return DesktopBridgeOutputSchemas.submitUserInput.parse(await requireHost().client.submitUserInput(request.run_id, request.input));
  });
  registerHandler(DESKTOP_IPC.getArtifact, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.getArtifact.parse(input);
    return DesktopBridgeOutputSchemas.getArtifact.parse(await requireHost().client.getArtifact(request.run_id, request.artifact_id));
  });
  registerHandler(DESKTOP_IPC.resumeSession, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.resumeSession.parse(input);
    return DesktopBridgeOutputSchemas.resumeSession.parse(await requireHost().client.resumeSession(request.session_id, request.input));
  });
  registerHandler(DESKTOP_IPC.renameSession, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.renameSession.parse(input);
    return DesktopBridgeOutputSchemas.renameSession.parse(await requireHost().client.renameSession(request.session_id, request.input));
  });
  registerHandler(DESKTOP_IPC.deleteSession, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.getSession.parse(input);
    return DesktopBridgeOutputSchemas.deleteSession.parse(await requireHost().client.deleteSession(request));
  });
  registerHandler(DESKTOP_IPC.createMemoryCandidate, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.createMemoryCandidate.parse(input);
    return DesktopBridgeOutputSchemas.createMemoryCandidate.parse(await requireHost().client.createMemoryCandidate(request));
  });
  registerHandler(DESKTOP_IPC.reviewMemory, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.memoryReview.parse(input);
    return DesktopBridgeOutputSchemas.reviewMemory.parse(await requireHost().client.reviewMemory(request.memory_id, request.input));
  });
  registerHandler(DESKTOP_IPC.correctMemory, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.memoryCorrect.parse(input);
    return DesktopBridgeOutputSchemas.correctMemory.parse(await requireHost().client.correctMemory(request.memory_id, request.input));
  });
  registerHandler(DESKTOP_IPC.revokeMemory, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.memoryRevoke.parse(input);
    return DesktopBridgeOutputSchemas.revokeMemory.parse(await requireHost().client.revokeMemory(request.memory_id, request.input));
  });
  registerHandler(DESKTOP_IPC.deleteMemory, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.memoryDelete.parse(input);
    return DesktopBridgeOutputSchemas.deleteMemory.parse(await requireHost().client.deleteMemory(request.memory_id, request.input.command_id));
  });
  registerHandler(DESKTOP_IPC.reviewExperienceCase, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.experienceReview.parse(input);
    return DesktopBridgeOutputSchemas.reviewExperienceCase.parse(await requireHost().client.reviewExperienceCase(request.case_id, request.input));
  });
  registerHandler(DESKTOP_IPC.configureModel, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.configureModel.parse(input);
    return DesktopBridgeOutputSchemas.configureModel.parse(await requireHost().client.configureModel(request));
  });
  registerHandler(DESKTOP_IPC.listProjects, async (event) => {
    assertTrustedRenderer(event);
    return DesktopBridgeOutputSchemas.listProjects.parse(await requireHost().client.listProjects());
  });
  registerHandler(DESKTOP_IPC.getModelConfig, async (event) => {
    assertTrustedRenderer(event);
    return DesktopBridgeOutputSchemas.getModelConfig.parse(await requireHost().client.getModelConfig());
  });
  registerHandler(DESKTOP_IPC.listMemoryControl, async (event) => {
    assertTrustedRenderer(event);
    return DesktopBridgeOutputSchemas.listMemoryControl.parse(await requireHost().client.listMemoryControl());
  });
  registerHandler(DESKTOP_IPC.listExperienceCases, async (event) => {
    assertTrustedRenderer(event);
    return DesktopBridgeOutputSchemas.listExperienceCases.parse(await requireHost().client.listExperienceCases());
  });
  for (const operation of Object.keys(DIRECT_DESKTOP_ROUTES) as DirectDesktopOperation[]) {
    registerHandler(DESKTOP_IPC[operation], async (event, ...args: unknown[]) => {
      assertTrustedRenderer(event);
      const host=requireHost();
      const result = await invokeDirectDesktopRoute(host.client, operation, args);
      if(operation==="exitReplay")await supervisor?.refresh();
      if(operation==="workbenchCommand" && typeof args[0]==="object" && args[0]!==null && "type" in args[0] && args[0].type==="host.restart") {
        if(reconnecting)throw new Error("Wait for the current Host connection");
        reconnecting=replaceHostAfterRestart(host).finally(()=>{reconnecting=undefined;});
        await reconnecting;
      }
      // Replay authority stays in Main, just like the live private connection token.
      return operation === "createReplay" ? { ...result as Record<string, unknown>, replay_token: "desktop-scoped-replay" } : result;
    });
  }
  registerHandler(DESKTOP_IPC.uploadAttachment, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const { metadata, bytes } = DesktopAttachmentUploadSchema.parse(input);
    return requireHost().client.uploadAttachment({ ...metadata, bytes });
  });
  registerHandler(DESKTOP_IPC.openStream, (event, input: unknown) => { assertTrustedRenderer(event); return requireStreams().open(event.sender.id, input); });
  registerHandler(DESKTOP_IPC.readStream, (event, id: unknown) => { assertTrustedRenderer(event); return requireStreams().read(event.sender.id, id); });
  registerHandler(DESKTOP_IPC.closeStream, (event, id: unknown) => { assertTrustedRenderer(event); return requireStreams().close(event.sender.id, id); });
  registerHandler(DESKTOP_IPC.openLocalProject, async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const request = DesktopBridgeInputSchemas.openLocalProject.parse(input);
    const selection = await dialog.showOpenDialog(requireMainWindow(), { title: "Open local folder", buttonLabel: "Open", properties: ["openDirectory"] });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || selectedPath === undefined) return undefined;
    const host = requireHost();
    const registered = await host.native.registerProject({ selectedPath, access: request.access });
    const summary = (await host.client.listProjects()).find((project) => project.project_id === registered.project_id);
    if (summary === undefined) throw new Error("Registered project is unavailable");
    return ProjectSummarySchema.parse(summary);
  });
  registerHandler(DESKTOP_IPC.revealProject, async (event, projectId: unknown) => {
    assertTrustedRenderer(event);
    const id = DesktopBridgeInputSchemas.projectId.parse(projectId);
    const { root } = await requireHost().native.resolveProjectRoot(id);
    if (await shell.openPath(root)) throw new Error("Could not reveal the registered project folder");
  });
  registerHandler(DESKTOP_IPC.removeProject, async (event, projectId: unknown) => {
    assertTrustedRenderer(event);
    const id = DesktopBridgeInputSchemas.projectId.parse(projectId);
    await requireHost().client.removeProject(id);
  });
  registerHandler(DESKTOP_IPC.openProjectFile, async (event, projectId: unknown) => {
    assertTrustedRenderer(event);
    const id = DesktopBridgeInputSchemas.projectId.parse(projectId);
    const host = requireHost();
    const { root } = await host.native.resolveProjectRoot(id);
    const selection = await dialog.showOpenDialog(requireMainWindow(), { title: `Open file in ${basename(root)}`, buttonLabel: "Open", defaultPath: root, properties: ["openFile"] });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || selectedPath === undefined) return;
    const file = await resolveProjectFileSelection(root, selectedPath);
    if ((await host.native.resolveProjectRoot(id)).root !== root) throw new Error("Project registration changed while selecting the file");
    const editor = (await host.client.getWorkbenchSettings()).settings.developer.editor;
    if (editor) await openInConfiguredEditor(editor, file);
    else if (await shell.openPath(file)) throw new Error("Could not open the selected project file");
  });
}
function requireMainWindow(): BrowserWindow {
  if (mainWindow === null || mainWindow.isDestroyed()) throw new Error("Desktop window is not available");
  return mainWindow;
}
async function replaceHostAfterRestart(previous:ConnectedLocalHost):Promise<void>{
  if(!supervisor)throw new Error("The Host connection is not ready");
  await supervisor.waitForReplacement(previous.status.boot_nonce);
}
async function launchHost(profileRoot=process.env.OUTLIVE_PROFILE_ROOT,httpPort?:number,startStoppedOwner=false):Promise<void>{
  if(supervisor){await supervisor.repair();return;}
  supervisor=new LocalHostConnectionSupervisor({...(profileRoot===undefined?{}:{profileRoot}),...(httpPort===undefined?{}:{httpPort}),...(app.isPackaged?{runtimeDirectory:join(process.resourcesPath,"runtime"),webAssetRoot:join(process.resourcesPath,"app","apps","web","dist")}:{}),...(process.env.OUTLIVE_CREDENTIAL_BACKEND==="private-file"?{credentialBackend:"private-file" as const}:{}),
    onDisconnect:async()=>{await streams?.closeAll();streams=null;desktopHost=null;},
    onRebind:async(host,generation)=>{const snapshot=await host.client.bootstrap();recovery=snapshot.recovery??recovery;desktopHost=host;streams=new DesktopStreamManager(host.client,generation);lastHostTarget={profileRoot:host.status.profile_root,httpPort:hostGatewayPort(host.status.http_address)};hostFailure=null;},
  });
  await supervisor.initialize();
  // A fresh user application launch is an explicit start intent. Activation,
  // window recreation and ordinary monitoring never clear the stop marker.
  if(startStoppedOwner&&supervisor.getSnapshot().state==="stopped")await supervisor.repair();
  const state=supervisor.getSnapshot();if(state.state!=="connected")hostFailure=state.message??"The local Host could not be reached";
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: "Outlive Agent",
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  mainWindow = window;
  const streamOwner = window.webContents.id;
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) void streams?.closeOwner(streamOwner);
  });
  window.webContents.on("render-process-gone", () => {
    void streams?.closeOwner(streamOwner);
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      if (target.protocol !== "file:" || resolve(fileURLToPath(target)) !== rendererPath) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  window.on("closed", () => {
    previews.close();
    if (mainWindow === window) mainWindow = null;
    void streams?.closeOwner(streamOwner);
  });
  await window.loadFile(rendererPath, { query: previewMode ? { preview: "1" } : {} });
}

registerIpcHandlers();

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (!previewMode) {
    try {
      await launchHost(undefined,undefined,true);
    } catch (error) {
      hostFailure = error instanceof Error ? error.message : "Desktop Host failed to start";
    }
  }
  await createMainWindow();
}).catch((error: unknown) => {
  hostFailure = error instanceof Error ? error.message : "Desktop startup failed";
  app.quit();
});

app.on("activate", () => {
  void supervisor?.refresh();
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (supervisor === null || isClosing) return;
  event.preventDefault();
  isClosing = true;
  previews.close();
  desktopHost = null;
  // Client shutdown detaches private streams. The independent Host owns Run lifetime.
  void (async () => { await supervisor?.close(); })().catch(() => { process.exitCode = 1; }).finally(() => {
    isClosing = false;
    app.quit();
  });
});
