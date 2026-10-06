import {UpdateWorkbenchSettingsRequestSchema,RestoreWorkbenchSettingsRequestSchema,type RestoreWorkbenchSettingsRequest,type RestoreWorkbenchSettingsResult,type WorkbenchSettingsHistory} from "@tracegraph/contracts";
import {settingsHistoryEntry,readSettingsHistory} from "./settings-history.js";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {
  ModelUsageReportSchema,UsageSnapshotSchema,HostCapabilitiesSchema,WorkbenchCommandResultSchema,WorkbenchResourcesSchema,WorkbenchSettingsSnapshotSchema,
  WorkbenchSettingsValuesSchema,WORKBENCH_CONFIG_VERSION,
  type HostCapabilities,type ModelConnectionTestResult,type PublicModelConfigResponse,
  type SessionReadResult,type RunProjection,type StartRunRequest,type UpdateWorkbenchSettingsRequest,type WorkbenchCommandRequest,
  type WorkbenchCommandResult,type WorkbenchResources,type WorkbenchNotification,type WorkbenchSettingsSnapshot,type WorkbenchSettingsValues,type WorkspaceHandle,
} from "@tracegraph/contracts";
import {type AgentRuntime,type ConfigurableModelAdapter,redactSensitiveText,probeNativeSandbox} from "@tracegraph/core";
import type {PermissionConfigController} from "./composition/permission-config.js";
import {atomicPrivateJson} from "./local-profile.js";
import {WorkbenchJournal,workbenchError} from "./workbench-journal.js";
import {DevWorkbench} from "./dev-workbench.js";
import {WorkbenchScheduler} from "./scheduler.js";
import type {WorkspaceCoordinator} from "./workspace-coordinator.js";
export interface WorkbenchControlContext {
  profileRoot:string;profileId:string;dataRoot?:string;runtime:AgentRuntime;model:ConfigurableModelAdapter & {forRun?():ConfigurableModelAdapter & {releaseRun?():void}};
  permissionConfig:PermissionConfigController;workspaceCoordinator:WorkspaceCoordinator;
  resolveWorkspace(projectId:string):Promise<WorkspaceHandle>;
  listProjects():readonly {workspace:WorkspaceHandle}[];
  getModelConfig():PublicModelConfigResponse|Promise<PublicModelConfigResponse>;
  getImageConfig?():Promise<import("@tracegraph/contracts").ImageProviderConfigSnapshot>;
  clearModelKey?():Promise<void>;
  requestStop?():void|Promise<void>;
  /** The owner rejects busy restarts and gates new work before replacing itself. */
  requestRestart?():Promise<void>;
  lsp?:{restart(name:string):Promise<unknown>};
  startRun(input:StartRunRequest):Promise<RunProjection>;
  readSession(sessionId:string):Promise<SessionReadResult>;
  registerWorktree?(root:string):Promise<{workspace:WorkspaceHandle}>;
  unregisterWorktree?(root:string):Promise<void>;
  onSettingsChanged?(settings:WorkbenchSettingsValues,changed:readonly string[]):Promise<void>;
  capabilityOverrides?:Record<string,{state:"available"|"unconfigured"|"readonly"|"policy-denied"|"unavailable";reason?:string}>;
  /** Installed composition supplies the actual managed-project factory. */
  projectCreationAvailable?:boolean;
  /** The shared composition supplies a trusted, permission-checked file-context reader. */
  fileContextAvailable?:boolean;
  conversationDefaultsAvailable?:boolean;
  browserControl?:{status():Promise<import("@tracegraph/contracts").BrowserStatus>};
  goals?:{list():Promise<import("@tracegraph/contracts").GoalListResponse>};
  computerControl?:{status():Promise<import("@tracegraph/contracts").ComputerStatus>};
  personalData?:{profile():Promise<import("@tracegraph/contracts").PersonalProfileSnapshot>};
  visualEvidence?:{settings():Promise<import("@tracegraph/contracts").VisualRetentionSettings>|import("@tracegraph/contracts").VisualRetentionSettings};
  skillManagement?:{readonly writeSupported:boolean};
  modelCapabilities?:{readonly pending:number};
  /** Trusted composition/test seam; never configurable through client DTOs. */
  sandboxProbe?:typeof probeNativeSandbox;
}
export interface WorkbenchControl {
  settings():Promise<WorkbenchSettingsSnapshot>;
  updateSettings(input:UpdateWorkbenchSettingsRequest):Promise<WorkbenchSettingsSnapshot>;
  settingsHistory():Promise<WorkbenchSettingsHistory>;
  restoreSettings(input:RestoreWorkbenchSettingsRequest):Promise<RestoreWorkbenchSettingsResult>;
  capabilities():Promise<HostCapabilities>;
  resources():Promise<WorkbenchResources>;
  testModel(commandId:string):Promise<ModelConnectionTestResult>;
  command(input:WorkbenchCommandRequest):Promise<WorkbenchCommandResult>;
  /** Private owner barrier; no renderer operation changes producer authority. */
  pauseForOwnerUpgrade():{busy:boolean;resume():void};
  close():Promise<void>;
}
export async function createWorkbenchControl(context:WorkbenchControlContext):Promise<WorkbenchControl>{
  const file=join(context.profileRoot,"workbench-settings.json");
  let saved:WorkbenchSettingsSnapshot;
  try{saved=WorkbenchSettingsSnapshotSchema.parse(JSON.parse(await readFile(file,"utf8")));if(saved.profile_id!==context.profileId)throw workbenchError("profile_mismatch","Settings belong to a different profile");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;saved={config_version:WORKBENCH_CONFIG_VERSION,revision:0,profile_id:context.profileId,settings:WorkbenchSettingsValuesSchema.parse({}),fields:[],pending_restart:[]};}
  // A fresh composition has applied persisted restart-scoped values.
  saved={...saved,pending_restart:[]};
  const journal=new WorkbenchJournal(join(context.profileRoot,"workbench-events"));await journal.initialize();
  const initialHistory=await readSettingsHistory(journal,context.profileId,saved.revision);
  if(!initialHistory.entries.some(entry=>entry.revision===saved.revision))await journal.once(`settings-checkpoint:${saved.revision}`,"settings.checkpoint",{revision:saved.revision},async()=>({settings_history:settingsHistoryEntry({revision:saved.revision,command_id:`settings-checkpoint:${saved.revision}`,operation:"checkpoint",settings:saved.settings})}));
  const archiveFile=join(context.profileRoot,"archived-sessions.json");
  let archived:string[]=[];
  try{const value:unknown=JSON.parse(await readFile(archiveFile,"utf8"));if(!Array.isArray(value)||value.some(x=>typeof x!=="string"))throw new Error("Invalid archive index");archived=value as string[];}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const dev=new DevWorkbench({...context,getSettings:()=>saved.settings});await dev.initialize();
  const scheduler=new WorkbenchScheduler({...context,journal});await scheduler.initialize();
  let settingsQueue:Promise<unknown>=Promise.resolve();
  const modelTestFile=join(context.profileRoot,"model-connection-test.json");
  let lastTest:{digest:string;result:ModelConnectionTestResult}|undefined;
  try{lastTest=JSON.parse(await readFile(modelTestFile,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const fingerprint=(value:PublicModelConfigResponse)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const nativeProbes=new Map<string,{at:number,result:Promise<{available:boolean;reason?:string}>}>();
  const nativeCapability=(mode:import("@tracegraph/contracts").SandboxMode)=>{
    const existing=nativeProbes.get(mode);if(existing&&Date.now()-existing.at<5000)return existing.result;
    const result=(async()=>{try{const report=await(context.sandboxProbe??probeNativeSandbox)({mode,workspaceRoot:context.profileRoot});return mode==="danger-full-access"||report.enforcement==="full"?{available:true}:{available:false,reason:`Native sandbox unavailable: ${report.unmet_constraints.join(", ")}`};}catch{return {available:false,reason:"Native sandbox capability probe failed; inspect Host diagnostics"};}})();
    nativeProbes.set(mode,{at:Date.now(),result});return result;
  };
  const snapshot=async():Promise<WorkbenchSettingsSnapshot>=>{
    const model=await context.getModelConfig();
    const fields:WorkbenchSettingsSnapshot["fields"]=Object.entries(saved.settings).flatMap(([group,values])=>Object.keys(values).map(key=>({path:`${group}.${key}`,source:saved.fields.find(field=>field.path===`${group}.${key}`)?.source??"default" as const,scope:"profile" as const,writable:true,effective:["tools","telemetry","memory"].includes(group)?"restart" as const:group==="model"||(group==="developer"&&["shell","worktree_directory","max_parallel_runs"].includes(key))?"new-run" as const:"immediate" as const,...(group==="developer"&&["shell","worktree_directory"].includes(key)?{reason:"Applies to newly created terminals or worktrees; existing resources retain their configuration"}:{})})));
    if (!fields.some(field=>field.path==="general.prevent_sleep_during_tasks")) fields.push({path:"general.prevent_sleep_during_tasks",source:"default",scope:"profile",writable:true,effective:"immediate"});
    fields.push({path:"model.connection",source:model.credential?.backend==="environment"?"environment":"profile",scope:"profile",writable:model.credential?.writable!==false,effective:"new-run",...(model.credential?.writable===false?{reason:"Credential configuration is read-only"}:{})});
    return WorkbenchSettingsSnapshotSchema.parse({...saved,fields,...(lastTest?.digest===fingerprint(model)?{model_test:lastTest.result}:{model_test:undefined})});
  };
  const publishSettings=async(settings:WorkbenchSettingsValues,changed:string[])=>{
    dev.validateSettings(settings);
    if(settings.telemetry.endpoint){const endpoint=new URL(settings.telemetry.endpoint);if(!["https:","http:"].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw workbenchError("telemetry_address_invalid","Telemetry endpoint must be HTTP(S) without credentials",400);}
    if(settings.telemetry.authorization_ref&&!/^\$\{secret:[A-Za-z0-9_.-]+\}$/u.test(settings.telemetry.authorization_ref))throw workbenchError("credential_reference_required","Telemetry authorization must reference a credential",400);
    const pending=[...new Set([...saved.pending_restart,...changed.filter(key=>["tools","memory","telemetry"].includes(key))])];
    const fields=(await snapshot()).fields.map(field=>changed.includes(field.path.split(".")[0]!)?{...field,source:"profile" as const}:field);
    const next={...saved,revision:saved.revision+1,settings,pending_restart:pending,fields};
    await atomicPrivateJson(file,next);saved=next;await context.onSettingsChanged?.(settings,changed);
  };
  const command=async(input:WorkbenchCommandRequest):Promise<WorkbenchCommandResult>=>{
    const execute=async():Promise<WorkbenchCommandResult>=>{
      const base={command_id:input.command_id,status:"succeeded" as const,code:"ok",message:"Operation completed"};
      if(input.type.startsWith("git.")||input.type.startsWith("terminal.")||input.type.startsWith("preview."))return dev.command(input);
      if(input.type.startsWith("schedule."))return scheduler.command(input);
      if(input.type==="sessions.archive"||input.type==="sessions.unarchive"){
        // Validate the session through the same scoped Runtime/session service before indexing.
        const session=await context.readSession(input.session_id);
        if(!session.header)throw workbenchError("session_not_found","Session is unavailable",404);
        archived=input.type==="sessions.archive"?[...new Set([...archived,input.session_id])]:archived.filter(id=>id!==input.session_id);
        await atomicPrivateJson(archiveFile,archived);return {...base,message:input.type==="sessions.archive"?"Session archived; history retained":"Session restored"};
      }
      if(input.type==="model.clear-key"){if(!context.clearModelKey)throw workbenchError("model_clear_unavailable","This Host cannot clear the configured credential",501);await context.clearModelKey();return {...base,message:"Credential cleared for new Runs"};}
      if(input.type==="skills.validate"){const workspace=await context.resolveWorkspace(input.project_id);const result=await context.runtime.inspectSkills(workspace);return {...base,text:JSON.stringify(result,null,2)};}
      if(input.type==="queue.cancel"){if(!context.workspaceCoordinator.cancel(input.holder_id))throw workbenchError("queued_task_not_found","The queued task is unavailable or already started",404);return {...base,message:"Queued task cancelled before execution"};}
      if(input.type==="host.stop"){if(!context.requestStop)throw workbenchError("host_stop_unavailable","Use the local CLI to stop this Host",501);await context.requestStop();return {...base,message:"Host shutdown requested; background resources will stop"};}
      if(input.type==="host.restart"){if(!context.requestRestart)throw workbenchError("host_restart_unavailable","Automatic restart is unavailable in this installation",501);await context.requestRestart();return {...base,code:"restart_requested",message:"Restart requested; reconnect to confirm the updated configuration"};}
      if(input.type==="lsp.restart"){if(!context.lsp)throw workbenchError("lsp_unavailable","LSP is unavailable",501);await context.lsp.restart(input.server_name);return {...base,message:"Configured LSP server stopped; next scoped query starts it"};}
      if(input.type==="usage.query"){
        if(input.project_id)await context.resolveWorkspace(input.project_id);if(input.session_id)await context.readSession(input.session_id);if(input.from&&input.to&&Date.parse(input.from)>Date.parse(input.to))throw workbenchError("usage_range_invalid","End time must follow start time",400);
        const permitted=new Set(context.listProjects().map(project=>project.workspace.project_id));let totals={input_tokens:0,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0,total_tokens:0};const runs=new Set<string>();const costs=new Map<string,number>();
        const ledger=new (await import("@tracegraph/core")).JsonlEventLedger(join(context.dataRoot??join(context.profileRoot,"data"),"events"));
        for(const id of await ledger.listRunIds()){for(const event of await ledger.list(id)){if(!permitted.has(event.project_id)&&event.project_id!=="chat:local")continue;if(input.project_id&&event.project_id!==input.project_id||input.session_id&&event.session_id!==input.session_id||input.from&&Date.parse(event.occurred_at)<Date.parse(input.from)||input.to&&Date.parse(event.occurred_at)>Date.parse(input.to))continue;if(event.type==="run.created")runs.add(id);if(event.type!=="model.usage_reported")continue;const data=event.data;const parsed=ModelUsageReportSchema.safeParse({provider:data.provider,model:data.model,input_tokens:data.input_tokens,output_tokens:data.output_tokens,cached_input_tokens:data.cached_input_tokens,reasoning_output_tokens:data.reasoning_output_tokens,total_tokens:data.total_tokens,request_kind:data.request_kind,request_sequence:data.request_sequence,provider_reported_cost:data.provider_reported_cost});if(!parsed.success)continue;const report=parsed.data;runs.add(id);totals.input_tokens+=report.input_tokens;totals.output_tokens+=report.output_tokens;totals.cached_input_tokens+=report.cached_input_tokens??0;totals.reasoning_output_tokens+=report.reasoning_output_tokens??0;totals.total_tokens+=report.total_tokens;if(report.provider_reported_cost)costs.set(report.provider_reported_cost.currency,(costs.get(report.provider_reported_cost.currency)??0)+report.provider_reported_cost.amount);}}
        return {...base,usage:UsageSnapshotSchema.parse({schema_version:"tracegraph.usage.v1",generated_at:new Date().toISOString(),source:"ledger",run_count:runs.size,...totals,costs:[...costs].map(([currency,amount])=>({currency,amount}))})};
      }
      if(input.type==="host.diagnostics"){
        const model=await context.getModelConfig();const permission=context.permissionConfig.snapshot();
        return {...base,text:JSON.stringify({app_version:"0.1.0-alpha.0",host_version:"0.1.0-alpha.0",cli_version:"0.1.0-alpha.0",protocol_version:"outlive.local-host.v1",profile_id:context.profileId,mode:"shared-local",pid:process.pid,platform:process.platform,node:process.version,model:{provider:model.provider,protocol:model.protocol,configured:model.configured,model:model.model,has_key:model.has_key},permission,resources:{terminals:dev.terminals().length,previews:dev.previews().length,schedules:scheduler.list().length},telemetry:context.runtime.getTelemetryStatus()},null,2)};
      }
      throw workbenchError("operation_unavailable","Host does not support this operation",501);
    };
    const readOnly=["git.status","git.diff","schedule.history","host.diagnostics","skills.validate","usage.query"].includes(input.type);
    return WorkbenchCommandResultSchema.parse(await(readOnly?execute():journal.once(input.command_id,input.type,input,execute)));
  };
  return {
    settings:snapshot,
    settingsHistory:()=>readSettingsHistory(journal,context.profileId,saved.revision),
    updateSettings(inputValue){
      const input=UpdateWorkbenchSettingsRequestSchema.parse(inputValue);
      const execute=async()=>{
        await journal.once(input.command_id,"settings.update",input,async()=>{
          if(saved.revision!==input.expected_revision)throw workbenchError("settings_revision_conflict","Settings changed in another client. Reload before saving");
          const changed=Object.keys(input.patch);
          const merged={...saved.settings};for(const group of changed as Array<keyof WorkbenchSettingsValues>)(merged as Record<string,unknown>)[group]={...saved.settings[group],...input.patch[group]};
          const settings=WorkbenchSettingsValuesSchema.parse(merged);
          await publishSettings(settings,changed);
          return {revision:saved.revision,settings_history:settingsHistoryEntry({revision:saved.revision,command_id:input.command_id,operation:"update",settings:saved.settings})};
        });return snapshot();
      };
      const result=settingsQueue.then(execute,execute);settingsQueue=result.catch(()=>undefined);return result;
    },
    restoreSettings(inputValue){
      const input=RestoreWorkbenchSettingsRequestSchema.parse(inputValue);
      const execute=async():Promise<RestoreWorkbenchSettingsResult>=>{
        const receipt=await journal.once(input.command_id,"settings.restore",input,async()=>{
          if(saved.revision!==input.expected_revision)throw workbenchError("settings_revision_conflict","Settings changed in another client. Reload before restoring");
          const history=await readSettingsHistory(journal,context.profileId,saved.revision);
          const target=history.entries.find(entry=>entry.revision===input.target_revision);
          if(!target)throw workbenchError("settings_history_missing","This settings revision is outside retained history",404);
          const preserved_sections=[...new Set(target.redacted_paths.map(path=>path.split(".")[0]!))] as Array<keyof WorkbenchSettingsValues>;
          const settings={...target.settings} as WorkbenchSettingsValues;for(const section of preserved_sections)(settings as Record<string,unknown>)[section]=saved.settings[section];
          const changed=Object.keys(settings).filter(key=>JSON.stringify(settings[key as keyof WorkbenchSettingsValues])!==JSON.stringify(saved.settings[key as keyof WorkbenchSettingsValues]));
          await publishSettings(WorkbenchSettingsValuesSchema.parse(settings),changed);
          return {restored_from_revision:input.target_revision,preserved_sections,settings_history:settingsHistoryEntry({revision:saved.revision,command_id:input.command_id,operation:"restore",settings:saved.settings,restored_from_revision:input.target_revision})};
        });return {snapshot:await snapshot(),restored_from_revision:receipt.restored_from_revision,preserved_sections:receipt.preserved_sections};
      };
      const result=settingsQueue.then(execute,execute);settingsQueue=result.catch(()=>undefined);return result;
    },
    async capabilities(){
      const model=await context.getModelConfig();
      const mode=context.permissionConfig.snapshot().selected_preset.sandbox_mode;
      const native=await nativeCapability(mode);
      const previewNative=await nativeCapability("read-only");
      const readNative=mode==="danger-full-access"?native:previewNative;
      const writeOps=new Set(["git.stage","git.unstage","git.discard","git.commit","git.branch.create","git.worktree.create","git.worktree.remove","terminal.create"]);
      const operations=["files.list","files.read","files.context","files.save","files.reconcile","feedback.read","feedback.write","models.read","models.write","models.test","models.capabilities.test","models.capabilities.read","session.options.read","session.options.write","permission.grant","projects.create","settings.read","settings.write","settings.history","settings.restore","project.defaults.read","project.defaults.write","session.options.reset","model.configure","model.test","model.clear-key","permission.read","permission.write","usage.read","telemetry.read","skills.read","skills.validate","extensions.read","extensions.reload","mcp.read","mcp.restart","lsp.read","resources.read","memory.read","memory.write","experience.read","experience.write","attachments.upload","attachments.read","replay.read","rollback.write","team.read","team.write","subagent.read","todo.read","todo.write","approval.write","run.cancel","run.resume","queue.cancel","host.diagnostics","host.stop","host.restart","lsp.restart","usage.query","git.status","git.diff","git.stage","git.unstage","git.discard","git.commit","git.branch.create","git.worktree.create","git.worktree.remove","terminal.create","terminal.input","terminal.resize","terminal.close","preview.start","preview.register","preview.stop","schedule.create","schedule.update","schedule.delete","schedule.run","schedule.history","sessions.archive","sessions.unarchive"];
      const image=await context.getImageConfig?.();
      const mediaOperations=["image.read","image.configure","image.clear","media.generate","media.diagram","media.chart","artifacts.binary.read"];
      const mediaCapabilities=mediaOperations.map(operation=>({operation,scope:"profile",state:!image?"unavailable":operation==="media.generate"&&(!image.configured||!image.has_key)?"unconfigured":"available",...(!image?{reason:"This Host has no media configuration"}:operation==="media.generate"&&(!image.configured||!image.has_key)?{reason:"Configure a dedicated PNG image provider and credential first"}:{})}));
      const browser = await context.browserControl?.status();
      const browserCapabilities = ["browser.read","browser.grant","browser.command","browser.observe","browser.evidence.read","browser.receipt.read"].map(operation=>({operation,scope:"project",state:!browser?"unavailable":operation==="browser.read"?"available":!browser.available?"unavailable":operation==="browser.grant"&&!browser.human_grant_available?"unavailable":"available",...(!browser?{reason:"Browser control is unavailable in this runtime"}:!browser.available?{reason:browser.reason}:operation==="browser.grant"&&!browser.human_grant_available?{reason:"Browser permission needs the trusted application confirmation"}:{})}));
      const computer=await context.computerControl?.status();
      const computerCapabilities=["computer.read","computer.targets","computer.grant","computer.revoke","computer.lease","computer.observe","computer.action","computer.capture.read","computer.receipt.read"].map(operation=>{
        let state="available",reason:string|undefined;
        if(!computer){state="unavailable";reason="此安装版本尚未提供电脑操作，请更新安装。";}
        else if(!["computer.read","computer.revoke","computer.receipt.read"].includes(operation)){
          if(!computer.backend_available){state="unavailable";reason="电脑操作组件需要修复安装，请在诊断中查看原因。";}
          else if(computer.locked){state="unconfigured";reason="请先解锁电脑，再手动继续操作。";}
          else if(!computer.accessibility){state="unconfigured";reason="请在系统设置为 Outlive 电脑助手开启辅助功能权限。";}
          else if(operation==="computer.grant"&&!computer.human_grant_available){state="unavailable";reason="请打开应用，通过系统对话框授予目标应用权限。";}
          else if(["computer.lease","computer.action"].includes(operation)&&!computer.input_monitoring){state="unconfigured";reason="请在系统设置开启输入监控，以便你随时接管。";}
          else if(operation==="computer.capture.read"&&!computer.screen_capture){state="unconfigured";reason="请为 Outlive 电脑助手开启屏幕录制权限。";}
        }
        return {operation,scope:"profile",state,...(reason?{reason}:{})};
      });
      const personalCapabilities=["personal.read","personal.write","personal.reconcile","usage.daily","search.public"].map(operation=>({operation,scope:"profile",state:context.personalData?"available":"unavailable",...(!context.personalData?{reason:"此运行环境尚未提供个人资料与公开记录查询，请更新安装。"}:{})}));
      const skillManagementCapabilities=["skills.manage.read","skills.manage.write","skills.manage.validate","skills.manage.reconcile"].map(operation=>({operation,scope:"profile",state:!context.skillManagement?"unavailable":operation==="skills.manage.write"&&mode==="read-only"?"policy-denied":operation==="skills.manage.write"&&!context.skillManagement.writeSupported?"unavailable":"available",...(!context.skillManagement?{reason:"Skill management is unavailable on this installation"}:operation==="skills.manage.write"&&mode==="read-only"?{reason:"Current permissions do not allow Skill changes"}:operation==="skills.manage.write"&&!context.skillManagement.writeSupported?{reason:"Scoped Skill writes require platform validation"}:{})}));
      const goalCapabilities = ["goals.read","goals.write"].map(operation=>({operation,scope:"project",state:context.goals?"available":"unavailable",...(!context.goals?{reason:"Persistent goals are unavailable in this runtime"}:{})}));
      const visualCapabilities=["visual.retention.read","visual.retention.write","visual.evidence.read","visual.evidence.pin","visual.evidence.cleanup","visual.evidence.reconcile"].map(operation=>({operation,scope:"profile",state:context.visualEvidence?"available":"unavailable",...(!context.visualEvidence?{reason:"此安装版本尚未提供截图保留设置，请更新安装。"}:{}),...context.capabilityOverrides?.[operation]}));
      return HostCapabilitiesSchema.parse({profile_id:context.profileId,protocol_version:"outlive.local-host.v1",capabilities:operations.map(operation=>({operation,scope:operation.startsWith("files.")||operation.startsWith("git.")||operation.startsWith("terminal.")||operation.startsWith("preview.")?"project":"profile",state:operation==="model.test"&&(!model.configured||!model.has_key)?"unconfigured":(operation==="model.configure"||operation==="model.clear-key")&&model.credential?.writable===false?"readonly":"available",...(operation==="model.test"&&(!model.configured||!model.has_key)?{reason:"Configure a model and credential first"}:{}),...(operation==="files.save"&&mode==="read-only"?{state:"policy-denied",reason:"The current permission preset denies file saves"}:{}),...(writeOps.has(operation)?mode==="read-only"?{state:"policy-denied",reason:"The current Host permission preset denies developer writes"}:!native.available?{state:"unavailable",reason:native.reason}:{}:operation==="preview.start"&&!previewNative.available?{state:"unavailable",reason:previewNative.reason}:["git.status","git.diff"].includes(operation)&&!readNative.available?{state:"unavailable",reason:readNative.reason}:{}),...(["project.defaults.read","project.defaults.write","session.options.reset"].includes(operation)&&!context.conversationDefaultsAvailable?{state:"unavailable",reason:"This runtime has no configuration inheritance controller"}:{}),...(operation==="host.restart"&&!context.requestRestart?{state:"unavailable",reason:"Automatic restart is unavailable in this installation"}:{}),...(operation==="projects.create"&&!context.projectCreationAvailable?{state:"unavailable",reason:"This runtime cannot create managed projects"}:{}),...(operation==="files.context"&&!context.fileContextAvailable?{state:"unavailable",reason:"Project file context is unavailable in this installation"}:{}),...(operation.startsWith("models.capabilities.")&&!context.modelCapabilities?{state:"unavailable",reason:"Model capability tests are unavailable in this runtime"}:{}),...context.capabilityOverrides?.[operation]})).concat(mediaCapabilities as never[],browserCapabilities as never[],goalCapabilities as never[],computerCapabilities as never[],personalCapabilities as never[],skillManagementCapabilities as never[],visualCapabilities as never[])});
    },
    async resources(){
      const runs:WorkbenchResources["runs"]=[];
      const notifications:WorkbenchNotification[]=[];
      const notificationEvents={completed:"run.completed",failed:"run.failed",interrupted:"run.interrupted",awaiting_approval:"approval.requested",awaiting_plan_approval:"plan.ready"} as const;
      if(context.dataRoot){
        const ledger=new (await import("@tracegraph/core")).JsonlEventLedger(join(context.dataRoot,"events"));
        for(const id of (await ledger.listRunIds()).slice(-256)){try{const p=await context.runtime.getProjection(id);const workspace=await context.resolveWorkspace(p.project_id);if(workspace.project_id!==p.project_id)continue;if(!["completed","failed","cancelled"].includes(p.status))runs.push({run_id:p.run_id,project_id:p.project_id,task:p.task,status:p.status,...(p.session_id?{session_id:p.session_id}:{})});
          if(p.status in notificationEvents){const status=p.status as keyof typeof notificationEvents;const enabled=status==="completed"?saved.settings.general.notify_completed:status==="failed"||status==="interrupted"?saved.settings.general.notify_failed:saved.settings.general.notify_approval;
            const event=[...p.timeline].reverse().find(event=>event.type===notificationEvents[status]&&event.run_id===p.run_id&&event.project_id===p.project_id);
            if(enabled&&event)notifications.push({notification_id:event.event_id,event_id:event.event_id,run_id:p.run_id,project_id:p.project_id,...(p.session_id?{session_id:p.session_id}:{}),task:p.task,status,occurred_at:event.occurred_at});}
        }catch{/* inaccessible legacy journal excluded */}}
      }
      for(const claim of context.workspaceCoordinator.list().filter(x=>x.state==="queued"))runs.push({run_id:`queued:${claim.holder_id}`,project_id:claim.project_id,task:`Waiting for workspace: ${claim.kind}`,status:"queued"});
      notifications.sort((a,b)=>Date.parse(b.occurred_at)-Date.parse(a.occurred_at)||a.notification_id.localeCompare(b.notification_id));
      return WorkbenchResourcesSchema.parse({runs,notifications:notifications.slice(0,128),terminals:dev.terminals(),previews:dev.previews(),schedules:scheduler.list(),archived_session_ids:archived});
    },
    async testModel(commandId){
      // Capture public identity and the credential lease without yielding to a configuration update.
      const publicConfig=context.getModelConfig();
      const probe=context.model.forRun?.()??context.model;
      try{const model=await publicConfig;const digest=fingerprint(model);return await journal.once(commandId,"model.test",{commandId,digest},async()=>{
      const started=Date.now();
      const finish=async(result:ModelConnectionTestResult)=>{lastTest={digest,result};await atomicPrivateJson(modelTestFile,lastTest);return result;};
      try{if((!model.configured||!model.has_key))throw workbenchError("model_unconfigured","Save a model and credential before testing",400);await probe.testConnection({signal:AbortSignal.timeout(15_000)});return finish({status:"passed",code:"connection_ok",message:"The configured model returned a valid response",checked_at:new Date().toISOString(),model:model.model,duration_ms:Date.now()-started});}
      catch(error){const name=(error as Error)?.name;const raw=(error as {code?:string})?.code;const code=name==="TimeoutError"||name==="AbortError"?"model_timeout":raw??"model_address_invalid";return finish({status:"failed",code,message:code==="model_timeout"?"The model did not respond within 15 seconds":redactSensitiveText(error instanceof Error?error.message:"Model connection failed").slice(0,1000),checked_at:new Date().toISOString(),model:model.model,duration_ms:Date.now()-started});}
      });}finally{if("releaseRun" in probe&&typeof probe.releaseRun==="function")probe.releaseRun();}
    },
    command,
    pauseForOwnerUpgrade:()=>scheduler.pauseForOwnerUpgrade(),
    async close(){await scheduler.close();await dev.close();},
  };
}
