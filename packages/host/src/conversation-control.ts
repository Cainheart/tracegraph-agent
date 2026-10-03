import {randomUUID} from "node:crypto";
import {readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {z} from "zod";
import {
 ModelConnectionsSnapshotSchema,SessionRunOptionsSchema,SessionRunOptionsSnapshotSchema,
 ModelConnectionSaveRequestSchema,ModelConnectionSchema,ModelConnectionTestResultSchema,
 type ModelConnectionsSnapshot,type ModelConnectionSaveRequest,type ModelConnectionRemoveRequest,
 type ModelConnectionTestResult,type SessionRunOptions,type SessionRunOptionsSnapshot,
 type SessionRunOptionsUpdateRequest,type PermissionGrantUpdateRequest,type StartRunRequest,
 type WorkspaceHandle,type EffectivePermissionPolicy,type SessionReadResult,type ReasoningEffort,
 ProjectFileContextSnapshotsSchema,type ProjectFileContextSnapshot,type ProjectFileContextRef,
} from "@tracegraph/contracts";
import {createSecretReference,redactSensitiveText, type CredentialStore,type ModelAdapter,type ModelProviderConfig} from "@tracegraph/core";
import type {TrustedRunDispatch} from "@tracegraph/api";
import {atomicPrivateJson} from "./local-profile.js";
import {WorkbenchJournal,workbenchError} from "./workbench-journal.js";
import {readPersistedModelConfig,saveModelConfig,persistModelConfig,type LoadedModelConfig} from "./composition/model-config.js";
import type {LeasedModelAdapter} from "./composition/leased-model.js";
import type {PermissionConfigController} from "./composition/permission-config.js";

const RegistrySchema=z.object({version:z.literal(1),seeded:z.boolean().default(false),default_connection_id:z.string().nullable(),entries:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9-]+$/u),label:z.string().min(1).max(200),revision:z.number().int().nonnegative(),models:z.array(z.string().min(1).max(200)).min(1).max(100),image_input_models:z.array(z.string().min(1).max(200)).max(100).optional(),test:ModelConnectionTestResultSchema.optional()}).strict()).max(100)}).strict();
type Registry=z.infer<typeof RegistrySchema>;
interface Context {
 profileRoot:string;store:CredentialStore;model:LeasedModelAdapter;
 initial?:LoadedModelConfig;permission:PermissionConfigController;
 readSession(id:string):Promise<SessionReadResult>;
 resolveWorkspace(id:string):Promise<WorkspaceHandle>;
 start(input:Parameters<TrustedRunDispatch["start"]>[0],options:{model:ModelAdapter;permissionPolicy:EffectivePermissionPolicy;projectFileContexts?:readonly ProjectFileContextSnapshot[];modelBinding?:{connection_id:string;revision:number;model:string;image_input?:boolean}}):ReturnType<TrustedRunDispatch["start"]>;
 readFileContext?(projectId:string,path:string,policy:EffectivePermissionPolicy):Promise<ProjectFileContextSnapshot>;
 fallbackModel?:ModelAdapter;
 defaultReasoningEffort?():ReasoningEffort;
 onDefaultChanged?(value:LoadedModelConfig|undefined):Promise<void>;
}
/** One owner resolves credentials/options before workspace admission; clients never swap global adapters. */
export class ConversationControl {
 readonly #ctx:Context;readonly #journal:WorkbenchJournal;
 #registry:Registry={version:1,seeded:false,default_connection_id:null,entries:[]};
 readonly #configs=new Map<string,LoadedModelConfig>();
 #sessionOptions:Record<string,SessionRunOptionsSnapshot>={};
 #queue:Promise<unknown>=Promise.resolve();
 private constructor(ctx:Context){this.#ctx=ctx;this.#journal=new WorkbenchJournal(join(ctx.profileRoot,"conversation-events"));}
 static async open(ctx:Context){
  const self=new ConversationControl(ctx);await self.#journal.initialize();
  try{self.#registry=RegistrySchema.parse(JSON.parse(await readFile(self.#file(),"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw workbenchError("model_registry_invalid","Saved model connections could not be read",503);}
  for(const entry of self.#registry.entries){const value=await readPersistedModelConfig(self.#configPath(entry.id),ctx.store);if(value)self.#configs.set(entry.id,value);}
  if(ctx.initial && (!self.#registry.seeded || ctx.initial.credential?.backend==="environment")){
   // The legacy/default config remains authoritative for its existing public API.
   const id=ctx.initial.credential?.backend==="environment"?"environment":"default";
   self.#configs.set(id,ctx.initial);
   if(id!=="environment")await persistModelConfig(self.#configPath(id),ctx.initial.config);
   const entry=self.#registry.entries.find(e=>e.id===id);
   if(!entry)self.#registry.entries.unshift({id,label:ctx.initial.config.provider,revision:0,models:[ctx.initial.config.model],image_input_models:ctx.model.capabilities().image_input?[ctx.initial.config.model]:[]});
   else if(id==="environment"){
    if(entry.models.length!==1||entry.models[0]!==ctx.initial.config.model)entry.revision+=1;
    entry.models=[ctx.initial.config.model];
    entry.image_input_models=ctx.model.capabilities().image_input?[ctx.initial.config.model]:[];
   }
   if(!self.#registry.default_connection_id)self.#registry.default_connection_id=id;
  }
  try{self.#sessionOptions=z.record(z.string(),SessionRunOptionsSnapshotSchema).parse(JSON.parse(await readFile(self.#sessionFile(),"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw workbenchError("session_options_invalid","Saved conversation options could not be read",503);}
  self.#registry.seeded=true;
  await self.#persist();return self;
 }
 #file(){return join(this.#ctx.profileRoot,"model-connections.json");}
 #sessionFile(){return join(this.#ctx.profileRoot,"session-run-options.json");}
 #configPath(id:string){return join(this.#ctx.profileRoot,"model-connections",id+".json");}
 #imageInputModels(entry:Registry["entries"][number],config:LoadedModelConfig):string[]{
  if(config.credential?.backend==="environment")return this.#ctx.model.capabilities().image_input?[config.config.model]:[];
  if(entry.image_input_models!==undefined)return entry.image_input_models;
  return entry.id==="default"&&this.#ctx.model.capabilities().image_input?[config.config.model]:[];
 }
 async #persist(){await atomicPrivateJson(this.#file(),this.#registry);}
 #serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.#queue.then(operation,operation);this.#queue=next.catch(()=>undefined);return next;}
 snapshot():ModelConnectionsSnapshot {
  return ModelConnectionsSnapshotSchema.parse({default_connection_id:this.#registry.default_connection_id,connections:this.#registry.entries.flatMap(e=>{
   const config=this.#configs.get(e.id);if(!config)return [];
   const reasoning_by_model=Object.fromEntries(e.models.map(model=>{const adapter=this.#ctx.model.forConfiguration({...config.config,model});try{return [model,adapter.supportedReasoningEfforts()];}finally{adapter.releaseRun?.();}}));
   return [ModelConnectionSchema.parse({reasoning_by_model,image_input_models:this.#imageInputModels(e,config),connection_id:e.id,label:e.label,revision:e.revision,provider:config.config.provider,protocol:config.config.protocol,base_url:config.config.baseUrl,model:config.config.model,models:e.models,has_key:config.hasKey,credential:config.credential,source:config.credential?.backend==="environment"?"environment":"profile",writable:config.credential?.writable!==false,...(e.test?{test:e.test}:{})})];
  })});
 }
 save(inputValue:ModelConnectionSaveRequest){const input=ModelConnectionSaveRequestSchema.parse(inputValue);return this.#serial(()=>this.#journal.once(input.command_id,"models.save",input,async()=>{
  const id=input.connection_id??randomUUID();if(!/^[a-zA-Z0-9-]+$/u.test(id))throw workbenchError("connection_id_invalid","Invalid model connection",400);
  const entry=this.#registry.entries.find(e=>e.id===id),old=this.#configs.get(id);
  if(old?.credential?.writable===false)throw workbenchError("model_config_readonly","This connection is managed by the environment");
  if(entry&&input.expected_revision!==entry.revision)throw workbenchError("model_revision_conflict","Reload the model connection before saving");
  if(input.clear_key&&(!entry||input.api_key!==undefined))throw workbenchError("model_clear_invalid","Clear an existing credential separately from replacing it",400);
  const models=[...new Set([input.model,...input.models??[]])];
  const imageInputModels=[...new Set(input.image_input_models??(entry&&old?this.#imageInputModels(entry,old):[]))];
  if(imageInputModels.some(model=>!models.includes(model)))throw workbenchError("model_image_declaration_invalid","Image input can only be enabled for a configured model",400);
  const next:LoadedModelConfig=input.clear_key?{config:{provider:input.provider,protocol:input.protocol,baseUrl:input.base_url,model:input.model,credentialRef:createSecretReference("OUTLIVE_CLEARED_"+randomUUID().replaceAll("-","").toUpperCase())},hasKey:false}:await saveModelConfig({path:this.#configPath(id),store:this.#ctx.store,config:{provider:input.provider,protocol:input.protocol,baseUrl:input.base_url,model:input.model},...(old?{existing:old.config}:{}),...(input.api_key===undefined?{}:{apiKey:input.api_key})}).catch(error=>{throw workbenchError("credential_storage_failed",redactSensitiveText(error instanceof Error?error.message:"The model credential could not be saved"),503);});
  if(input.clear_key)await persistModelConfig(this.#configPath(id),next.config);
  const updated={id,label:input.label,revision:(entry?.revision??-1)+1,models,image_input_models:imageInputModels};
  const previousRegistry=this.#registry;
  this.#registry={...this.#registry,default_connection_id:this.#registry.default_connection_id??id,entries:[...this.#registry.entries.filter(e=>e.id!==id),updated]};
  try{await this.#persist();}catch(error){this.#registry=previousRegistry;if(old)await persistModelConfig(this.#configPath(id),old.config);else await rm(this.#configPath(id),{force:true});this.#retire(next.config,old?.config.credentialRef);throw error;}
  this.#configs.set(id,next);if(id===this.#registry.default_connection_id)await this.#ctx.onDefaultChanged?.(next);this.#retire(old?.config,next.config.credentialRef);return this.snapshot();
 }));}
 remove(id:string,input:ModelConnectionRemoveRequest){return this.#serial(()=>this.#journal.once(input.command_id,"models.remove",{id,...input},async()=>{
  const entry=this.#registry.entries.find(e=>e.id===id),old=this.#configs.get(id);
  if(!entry||!old)throw workbenchError("model_connection_missing","This saved model connection no longer exists",404);
  if(old.credential?.writable===false)throw workbenchError("model_config_readonly","Environment connections cannot be removed");
  if(entry.revision!==input.expected_revision)throw workbenchError("model_revision_conflict","Reload the connection before removing it");
  const previousRegistry=this.#registry;
  this.#registry={...this.#registry,entries:this.#registry.entries.filter(e=>e.id!==id),default_connection_id:this.#registry.default_connection_id===id?this.#registry.entries.find(e=>e.id!==id)?.id??null:this.#registry.default_connection_id};
  try{await this.#persist();}catch(error){this.#registry=previousRegistry;throw error;}this.#configs.delete(id);await rm(this.#configPath(id),{force:true});
  // Update the legacy default reference before retiring a removed credential.
  if(previousRegistry.default_connection_id===id)await this.#ctx.onDefaultChanged?.(this.#registry.default_connection_id?this.#configs.get(this.#registry.default_connection_id):undefined);this.#retire(old.config);return this.snapshot();
 }));}
 #retire(old:ModelProviderConfig|undefined,next?:string){if(!old||old.credentialRef===next||[...this.#configs.values()].some(v=>v.config.credentialRef===old.credentialRef))return;this.#ctx.model.retireCredential(old.credentialRef,()=>this.#ctx.store.delete(old.credentialRef.slice("${secret:".length,-1)));}
 async syncDefault(value:LoadedModelConfig|undefined){await this.#serial(async()=>{
  if(!value){this.#configs.delete("default");this.#registry.entries=this.#registry.entries.filter(e=>e.id!=="default");if(this.#registry.default_connection_id==="default")this.#registry.default_connection_id=this.#registry.entries[0]?.id??null;}
  else{await persistModelConfig(this.#configPath("default"),value.config);this.#configs.set("default",value);const previous=this.#registry.entries.find(e=>e.id==="default");this.#registry.entries=this.#registry.entries.filter(e=>e.id!=="default");this.#registry.entries.unshift({id:"default",label:previous?.label??value.config.provider,revision:(previous?.revision??-1)+1,models:[value.config.model],image_input_models:(previous?.image_input_models??(this.#ctx.model.capabilities().image_input?[value.config.model]:[])).filter(model=>model===value.config.model)});this.#registry.default_connection_id="default";}
  await this.#persist();
 });}
 async test(id:string,commandId:string):Promise<ModelConnectionTestResult>{
  const entry=this.#registry.entries.find(e=>e.id===id),config=this.#configs.get(id);if(!entry||!config)throw workbenchError("model_connection_missing","This model connection no longer exists",404);
  const probe=this.#ctx.model.forConfiguration(config.config),revision=entry.revision;
  try{return await this.#journal.once(commandId,"models.test",{id,revision},async()=>{
   const started=Date.now();let result:ModelConnectionTestResult;
   try{await probe.testConnection({signal:AbortSignal.timeout(15_000)});result={status:"passed",code:"connection_ok",message:"模型连接成功",model:config.config.model,checked_at:new Date().toISOString(),duration_ms:Date.now()-started};}
   catch(error){const code=["TimeoutError","AbortError"].includes((error as Error).name)?"model_timeout":String((error as {code?:string}).code??"model_connection_failed");result={status:"failed",code,message:redactSensitiveText(error instanceof Error?error.message:"模型连接失败").slice(0,1000),model:config.config.model,checked_at:new Date().toISOString(),duration_ms:Date.now()-started};}
   await this.#serial(async()=>{const current=this.#registry.entries.find(e=>e.id===id);if(current?.revision===revision){current.test=result;await this.#persist();}});return result;
  });}finally{(probe as ModelAdapter).releaseRun?.();}
 }
 #defaults():SessionRunOptions{return SessionRunOptionsSchema.parse({...(this.#registry.default_connection_id?{connection_id:this.#registry.default_connection_id}:{}),reasoning_effort:this.#ctx.defaultReasoningEffort?.()??"default",permission_preset:this.#ctx.permission.snapshot().selected_preset_key==="read-only"?"read-only":"workspace-write"});}
 async options(id:string):Promise<SessionRunOptionsSnapshot>{await this.#ctx.readSession(id);return this.#sessionOptions[id]??{session_id:id,revision:0,options:this.#defaults()};}
 async updateOptions(id:string,input:SessionRunOptionsUpdateRequest){return this.#serial(()=>this.#journal.once(input.command_id,"session.options",{id,...input},async()=>{
  await this.#ctx.readSession(id);const current=this.#sessionOptions[id]??{session_id:id,revision:0,options:this.#defaults()};if(current.revision!==input.expected_revision)throw workbenchError("session_options_conflict","Conversation options changed; reload before saving");
  this.#validate(input.options);await this.#assertGrant(input.options);const next={session_id:id,revision:current.revision+1,options:input.options};this.#sessionOptions[id]=next;await atomicPrivateJson(this.#sessionFile(),this.#sessionOptions);return next;
 }));}
 #validate(options:SessionRunOptions){
  const rank={"read-only":0,"workspace-write":1,"full-write":2};if(rank[options.permission_preset]>rank[this.#ctx.permission.snapshot().ceiling_preset_key])throw workbenchError("permission_ceiling","The selected permission is not yet allowed by this installation");
  if(options.connection_id){const value=this.#configs.get(options.connection_id),entry=this.#registry.entries.find(e=>e.id===options.connection_id);if(!value||!entry)throw workbenchError("model_connection_missing","Choose an available saved model",404);if(options.model&&!entry.models.includes(options.model))throw workbenchError("model_not_configured","This model is not configured for the selected service",400);}
  else if(options.model)throw workbenchError("model_connection_required","Choose a saved service for this model",400);
 }
 async #assertGrant(options:SessionRunOptions){if(options.permission_preset==="full-write"&&this.#ctx.permission.snapshot().ceiling_source==="user-consent"&&!(await this.#ctx.permission.localGrant()).enabled)throw workbenchError("permission_grant_revoked","Full access has been revoked for new operations");}
 async resolvePolicy(projectId:string,sessionId?:string){const workspace=await this.#ctx.resolveWorkspace(projectId);const session=sessionId?await this.#ctx.readSession(sessionId):undefined;if(session&&session.header.project_id!==projectId)throw workbenchError("session_project_mismatch","Conversation belongs to another project");const options=sessionId?(await this.options(sessionId)).options:this.#defaults();await this.#assertGrant(options);return this.#ctx.permission.resolveProject(workspace.real_root,options.permission_preset);}
 async prepare(input:StartRunRequest,workspace:WorkspaceHandle):Promise<TrustedRunDispatch>{
  if(input.session_id&&(await this.#ctx.readSession(input.session_id)).header.project_id!==input.project_id)throw workbenchError("session_project_mismatch","Conversation belongs to another project",403);
  const saved=input.session_id?(await this.options(input.session_id)).options:this.#defaults();
  const options=SessionRunOptionsSchema.parse({...saved,...input.run_options,mode:input.run_options?.mode??input.mode,reasoning_effort:input.reasoning_effort??input.run_options?.reasoning_effort??saved.reasoning_effort});this.#validate(options);await this.#assertGrant(options);
  const config=options.connection_id?this.#configs.get(options.connection_id):undefined,entry=this.#registry.entries.find(e=>e.id===options.connection_id);
  if(config&&!config.hasKey)throw workbenchError("credential_required","Replace the API key before starting a task",400);
  const selectedModel=options.model??config?.config.model;
  const imageInput=Boolean(selectedModel&&(config&&entry&&this.#imageInputModels(entry,config).includes(selectedModel)));
  // Capture the credential lease before yielding to policy/workspace admission.
  const selected=config?this.#ctx.model.forConfiguration({...config.config,model:options.model??config.config.model},{image_input:imageInput}):this.#ctx.fallbackModel??this.#ctx.model.forConfiguration(undefined);
  let transferred=false;
  const adapter:ModelAdapter=Object.assign(Object.create(selected),{forRun:()=>{transferred=true;return selected;}});
  try{const permissionPolicy=await this.#ctx.permission.resolveProject(workspace.real_root,options.permission_preset);
   const projectFileContexts=await this.#fileContexts(input.project_id,input.file_contexts??[],permissionPolicy);
   return {
   identity:"conversation-options",release:()=>{if(!transferred)selected.releaseRun?.();},
   start:async(runInput)=>{const projection=await this.#ctx.start({...runInput,mode:options.mode,reasoning_effort:options.reasoning_effort},{model:adapter,permissionPolicy,...(projectFileContexts.length?{projectFileContexts}:{}),...(entry&&config?{modelBinding:{connection_id:entry.id,revision:entry.revision,model:options.model??config.config.model,image_input:imageInput}}:{})});
    if(!transferred)selected.releaseRun?.();
    if(projection.session_id)await this.#serial(async()=>{if(!this.#sessionOptions[projection.session_id!]){this.#sessionOptions[projection.session_id!]={session_id:projection.session_id!,revision:0,options};await atomicPrivateJson(this.#sessionFile(),this.#sessionOptions);}});return projection;},
 };}catch(error){selected.releaseRun?.();throw error;}
 }
 async #fileContexts(projectId:string,refs:readonly ProjectFileContextRef[],policy:EffectivePermissionPolicy){
  if(!refs.length)return [];
  if(!this.#ctx.readFileContext)throw workbenchError("file_context_unavailable","Project file context is unavailable in this Host",503);
  const snapshots:ProjectFileContextSnapshot[]=[];
  for(const ref of refs){const snapshot=await this.#ctx.readFileContext(projectId,ref.path,policy);if(snapshot.sha256!==ref.expected_sha256)throw workbenchError("file_context_revision_conflict","The selected file changed. Select its current version before starting",409);snapshots.push(snapshot);}
  const parsed=ProjectFileContextSnapshotsSchema.safeParse(snapshots);if(!parsed.success)throw workbenchError("file_context_limit","Select at most five files within the 128 KiB total context limit",413);return parsed.data;
 }
 getPermissionGrant(){return this.#ctx.permission.localGrant();}
 setPermissionGrant(input:PermissionGrantUpdateRequest){return this.#serial(()=>this.#journal.once(input.command_id,"permission.grant",input,()=>this.#ctx.permission.setLocalFullGrant(input.enabled)));}
}
