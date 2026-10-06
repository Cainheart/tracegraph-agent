import type {ModelRequestBudget,AgentRuntimeOptions} from "@tracegraph/core";
import {SessionRunOptionsUpdateRequestSchema,SessionRunOptionsOverrideSchema,SessionRunOptionsResetRequestSchema,ProjectRunDefaultsUpdateRequestSchema,type SessionRunOptionsOverride,type SessionRunOptionsResetRequest,type ProjectRunDefaultsUpdateRequest,type ProjectRunDefaultsSnapshot} from "@tracegraph/contracts";
import {randomUUID} from "node:crypto";
import {readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {z} from "zod";
import {
 ModelConnectionsSnapshotSchema,SessionRunOptionsSchema,SessionRunOptionsSnapshotSchema,
 ModelCatalogDiscoveryRequestSchema,ModelCatalogDiscoveryResultSchema,ModelCatalogEntrySchema,
 resolveModelCatalogEntry,
 ModelConnectionSaveRequestSchema,ModelConnectionSchema,ModelConnectionTestResultSchema,
 type ModelConnectionsSnapshot,type ModelConnectionSaveRequest,type ModelConnectionRemoveRequest,type ModelCatalogEntry,type ModelCatalogDiscoveryRequest,type ModelCatalogDiscoveryResult,
 type ModelConnectionTestResult,type SessionRunOptions,type SessionRunOptionsSnapshot,
 type SessionRunOptionsUpdateRequest,type PermissionGrantUpdateRequest,type StartRunRequest,
 type WorkspaceHandle,type EffectivePermissionPolicy,type SessionReadResult,type ReasoningEffort,
 ProjectFileContextSnapshotsSchema,MAX_PROJECT_CONTEXT_TOTAL_BYTES,type ProjectFileContextSnapshot,type ProjectFileContextRef,
} from "@tracegraph/contracts";
import {createSecretReference,credentialNameFromReference,redactSensitiveText, type CredentialStore,type ModelAdapter,type ModelProviderConfig} from "@tracegraph/core";
import type {TrustedRunDispatch} from "@tracegraph/api";
import {atomicPrivateJson} from "./local-profile.js";
import {WorkbenchJournal,workbenchError} from "./workbench-journal.js";
import {readPersistedModelConfig,saveModelConfig,persistModelConfig,type LoadedModelConfig} from "./composition/model-config.js";
import type {LeasedModelAdapter} from "./composition/leased-model.js";
import type {PermissionConfigController} from "./composition/permission-config.js";

const RegistrySchema=z.object({version:z.literal(1),seeded:z.boolean().default(false),default_connection_id:z.string().nullable(),entries:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9-]+$/u),label:z.string().min(1).max(200),revision:z.number().int().nonnegative(),models:z.array(z.string().min(1).max(200)).min(1).max(100),image_input_models:z.array(z.string().min(1).max(200)).max(100).optional(),model_catalog:z.array(ModelCatalogEntrySchema).max(1000).optional(),model_catalog_status:z.enum(["succeeded","failed"]).optional(),model_catalog_checked_at:z.string().datetime({offset:true}).optional(),model_catalog_error_code:z.string().max(100).optional(),test:ModelConnectionTestResultSchema.optional(),capability_test:ModelCapabilityTestResultSchema.optional()}).strict()).max(100)}).strict();
type Registry=z.infer<typeof RegistrySchema>;
interface Context {
 profileRoot:string;store:CredentialStore;model:LeasedModelAdapter;
 initial?:LoadedModelConfig;permission:PermissionConfigController;
 readSession(id:string):Promise<SessionReadResult>;
 resolveWorkspace(id:string):Promise<WorkspaceHandle>;
 start(input:Parameters<TrustedRunDispatch["start"]>[0],options:{model:ModelAdapter;requestBudget?:ModelRequestBudget;backgroundModelDerivation?:false;permissionPolicy:EffectivePermissionPolicy;projectFileContexts?:readonly ProjectFileContextSnapshot[];modelBinding?:{connection_id:string;revision:number;model:string;image_input?:boolean;capabilities?:import("@tracegraph/contracts").ModelCapabilities}}):ReturnType<TrustedRunDispatch["start"]>;
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
 #projectOverrides:Record<string,{revision:number;overrides:SessionRunOptionsOverride}>={};
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
    // Environment credentials can change outside this registry without a
    // revisioned save. Keep old canonical receipts, but do not reuse their
    // capability summary as proof of this owner's current configuration.
    delete entry.capability_test;
    if(entry.models.length!==1||entry.models[0]!==ctx.initial.config.model)entry.revision+=1;
    entry.models=[ctx.initial.config.model];
    entry.image_input_models=ctx.model.capabilities().image_input?[ctx.initial.config.model]:[];
   }
   if(!self.#registry.default_connection_id)self.#registry.default_connection_id=id;
  }
  try{self.#sessionOptions=z.record(z.string(),SessionRunOptionsSnapshotSchema).parse(JSON.parse(await readFile(self.#sessionFile(),"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw workbenchError("session_options_invalid","Saved conversation options could not be read",503);}
  try{self.#projectOverrides=z.record(z.string(),z.object({revision:z.number().int().nonnegative(),overrides:SessionRunOptionsOverrideSchema}).strict()).parse(JSON.parse(await readFile(self.#projectFile(),"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw workbenchError("project_options_invalid","Saved project defaults could not be read",503);}
  self.#registry.seeded=true;
  await self.#persist();return self;
 }
 #file(){return join(this.#ctx.profileRoot,"model-connections.json");}
 #projectFile(){return join(this.#ctx.profileRoot,"project-run-defaults.json");}
 #sessionFile(){return join(this.#ctx.profileRoot,"session-run-options.json");}
 #configPath(id:string){return join(this.#ctx.profileRoot,"model-connections",id+".json");}
 #imageInputModels(entry:Registry["entries"][number],config:LoadedModelConfig):string[]{
  if(config.credential?.backend==="environment")return this.#ctx.model.capabilities().image_input?[config.config.model]:[];
  if(entry.image_input_models!==undefined)return entry.image_input_models;
  return entry.id==="default"&&this.#ctx.model.capabilities().image_input?[config.config.model]:[];
 }
 #modelCapabilities(entry:Registry["entries"][number],config:LoadedModelConfig,model:string){
  const found=resolveModelCatalogEntry(model,entry.model_catalog,config.config.provider,config.config.baseUrl);
  const imageInput=found?.input_modalities!==undefined?found.input_modalities.includes("image"):this.#imageInputModels(entry,config).includes(model);
  return {image_input:imageInput,...(found?.context_window_tokens===undefined?{}:{context_window_tokens:found.context_window_tokens}),...(found?.max_output_tokens===undefined?{}:{max_output_tokens:found.max_output_tokens})};
 }
 async #persist(){await atomicPrivateJson(this.#file(),this.#registry);}
 #serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.#queue.then(operation,operation);this.#queue=next.catch(()=>undefined);return next;}
 snapshot():ModelConnectionsSnapshot {
  return ModelConnectionsSnapshotSchema.parse({default_connection_id:this.#registry.default_connection_id,connections:this.#registry.entries.flatMap(e=>{
   const config=this.#configs.get(e.id);if(!config)return [];
   const reasoning_by_model=Object.fromEntries(e.models.map(model=>{const confirmed=resolveModelCatalogEntry(model,e.model_catalog,config.config.provider,config.config.baseUrl)?.reasoning_efforts;return [model,["default",...(confirmed??[]).filter((effort):effort is Exclude<typeof effort,"none">=>effort!=="none")]];}));
   return [ModelConnectionSchema.parse({reasoning_by_model,image_input_models:this.#imageInputModels(e,config),...(e.model_catalog?{model_catalog:e.model_catalog}:{}),...(e.model_catalog_status?{model_catalog_status:e.model_catalog_status}:{}),...(e.model_catalog_checked_at?{model_catalog_checked_at:e.model_catalog_checked_at}:{}),...(e.model_catalog_error_code?{model_catalog_error_code:e.model_catalog_error_code}:{}),connection_id:e.id,label:e.label,revision:e.revision,provider:config.config.provider,protocol:config.config.protocol,base_url:config.config.baseUrl,model:config.config.model,models:e.models,has_key:config.hasKey,credential:config.credential,source:config.credential?.backend==="environment"?"environment":"profile",writable:config.credential?.writable!==false,...(e.test?{test:e.test}:{}),...(e.capability_test?.connection_id===e.id&&e.capability_test.connection_revision===e.revision?{capability_test:e.capability_test}:{})})];
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
  const keepCatalog=Boolean(entry?.model_catalog&&old&&input.api_key===undefined&&old.config.provider===input.provider&&old.config.protocol===input.protocol&&old.config.baseUrl===input.base_url);
  const updated={id,label:input.label,revision:(entry?.revision??-1)+1,models,image_input_models:imageInputModels,...(keepCatalog?{model_catalog:entry!.model_catalog}:{})};
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
 async discoverModels(id:string,inputValue:ModelCatalogDiscoveryRequest):Promise<ModelCatalogDiscoveryResult>{
  const input=ModelCatalogDiscoveryRequestSchema.parse(inputValue);
  return this.#serial(()=>this.#journal.once(input.command_id,"models.discover",{id,...input},async()=>{
   const entry=this.#registry.entries.find(value=>value.id===id),loaded=this.#configs.get(id);
   if(!entry||!loaded)throw workbenchError("model_connection_missing","This model connection no longer exists",404);
   if(entry.revision!==input.expected_revision)throw workbenchError("model_revision_conflict","Reload the model connection before discovering models",409);
   if(!loaded.hasKey)throw workbenchError("credential_required","Add an API key before discovering models",400);
   const checkedAt=new Date().toISOString();let result:ModelCatalogDiscoveryResult;
   try{
    const name=credentialNameFromReference(loaded.config.credentialRef),apiKey=await this.#ctx.store.get(name);
    if(!apiKey)throw Object.assign(new Error("The saved credential is unavailable"),{code:"credential_unavailable"});
    const discovered=await fetchModelCatalog(loaded.config,apiKey);
    result=ModelCatalogDiscoveryResultSchema.parse({connection_id:id,connection_revision:entry.revision,status:"succeeded",discovered_at:checkedAt,models:discovered});
   }catch(error){
    const code=discoveryErrorCode(error),message=discoveryErrorMessage(code);
    result=ModelCatalogDiscoveryResultSchema.parse({connection_id:id,connection_revision:entry.revision,status:"failed",discovered_at:checkedAt,models:[],error_code:code,message});
   }
   if(loaded.credential?.backend!=="environment"&&loaded.credential?.writable!==false){
    const previous=this.#registry;this.#registry={...previous,entries:previous.entries.map(value=>{if(value.id!==id)return value;const updated={...value,model_catalog:result.models,model_catalog_status:result.status,model_catalog_checked_at:result.discovered_at};if(result.error_code)updated.model_catalog_error_code=result.error_code;else delete updated.model_catalog_error_code;return updated;})};
    try{await this.#persist();}catch(error){this.#registry=previous;throw error;}
   }
   return result;
  }));
 }
 /** Capture one exact saved configuration without changing an admitted task. */
 recordCapabilityTest(resultValue:ModelCapabilityTestResult){const result=ModelCapabilityTestResultSchema.parse(resultValue);return this.#serial(async()=>{const entry=this.#registry.entries.find(value=>value.id===result.connection_id);if(!entry||entry.revision!==result.connection_revision||!entry.models.includes(result.model))return;const previous=entry.capability_test;entry.capability_test=result;try{await this.#persist();}catch(error){entry.capability_test=previous;throw error;}});}
 captureCapabilityProbe(id:string,model:string,revision:number){
  const entry=this.#registry.entries.find(value=>value.id===id),config=this.#configs.get(id);
  if(!entry||!config)throw workbenchError("model_connection_missing","Choose an available saved model connection",404);
  if(entry.revision!==revision)throw workbenchError("model_connection_revision_conflict","The saved connection changed. Reload it before testing",409);
  if(!config.hasKey)throw workbenchError("model_not_configured","Add a credential before testing this connection",400);
  if(!entry.models.includes(model))throw workbenchError("model_not_configured","Choose a configured model before testing",400);
  return {adapter:this.#ctx.model.forConfiguration({...config.config,model}),provider:config.config.provider,protocol:config.config.protocol,revision:entry.revision};
 }
 #defaults():SessionRunOptions{return SessionRunOptionsSchema.parse({...(this.#registry.default_connection_id?{connection_id:this.#registry.default_connection_id}:{}),reasoning_effort:this.#ctx.defaultReasoningEffort?.()??"default",permission_preset:this.#ctx.permission.snapshot().selected_preset_key});}
 #resolve(projectId:string,sessionOverrides:SessionRunOptionsOverride={},requestOverrides:SessionRunOptionsOverride={}){
  const global=this.#defaults(),project=this.#projectOverrides[projectId]?.overrides??{};
  const options=SessionRunOptionsSchema.parse({...global,...project,...sessionOverrides,...requestOverrides});
  const fields=(["connection_id","model","reasoning_effort","mode","permission_preset"] as const).map(path=>({path,source:Object.hasOwn(requestOverrides,path)?"request" as const:Object.hasOwn(sessionOverrides,path)?"session" as const:Object.hasOwn(project,path)?"project" as const:path==="mode"?"default" as const:"profile" as const,effective:"new-run" as const}));
  return {options,fields};
 }
 async projectDefaults(projectId:string):Promise<ProjectRunDefaultsSnapshot>{await this.#ctx.resolveWorkspace(projectId);const stored=this.#projectOverrides[projectId]??{revision:0,overrides:{}};return {project_id:projectId,...stored,...this.#resolve(projectId)};}
 async updateProjectDefaults(projectId:string,inputValue:ProjectRunDefaultsUpdateRequest){const input=ProjectRunDefaultsUpdateRequestSchema.parse(inputValue);return this.#serial(()=>this.#journal.once(input.command_id,"project.defaults",{projectId,...input},async()=>{
  await this.#ctx.resolveWorkspace(projectId);const current=this.#projectOverrides[projectId]??{revision:0,overrides:{}};
  if(current.revision!==input.expected_revision)throw workbenchError("project_options_conflict","Project defaults changed; reload before saving");
  const effective=SessionRunOptionsSchema.parse({...this.#defaults(),...input.overrides});this.#validate(effective);await this.#assertGrant(effective);
  const next={revision:current.revision+1,overrides:input.overrides},all={...this.#projectOverrides,[projectId]:next};await atomicPrivateJson(this.#projectFile(),all);this.#projectOverrides=all;return this.projectDefaults(projectId);
 }));}
 async options(id:string):Promise<SessionRunOptionsSnapshot>{const session=await this.#ctx.readSession(id);await this.#ctx.resolveWorkspace(session.header.project_id);const stored=this.#sessionOptions[id];const overrides=stored?.overrides??stored?.options??{};return {session_id:id,revision:stored?.revision??0,overrides,...this.#resolve(session.header.project_id,overrides)};}
 async updateOptions(id:string,inputValue:SessionRunOptionsUpdateRequest){const input=SessionRunOptionsUpdateRequestSchema.parse(inputValue);return this.#serial(()=>this.#journal.once(input.command_id,"session.options",{id,...input},async()=>{
  const session=await this.#ctx.readSession(id),current=await this.options(id);if(current.revision!==input.expected_revision)throw workbenchError("session_options_conflict","Conversation options changed; reload before saving");
  const overrides=input.overrides??input.options!;const effective=this.#resolve(session.header.project_id,overrides).options;this.#validate(effective);await this.#assertGrant(effective);const next={session_id:id,revision:current.revision+1,options:effective,overrides},all={...this.#sessionOptions,[id]:next};await atomicPrivateJson(this.#sessionFile(),all);this.#sessionOptions=all;return {session_id:id,revision:next.revision,overrides:next.overrides,...this.#resolve(session.header.project_id,next.overrides)};
 }));}
 async resetOptions(id:string,inputValue:SessionRunOptionsResetRequest){const input=SessionRunOptionsResetRequestSchema.parse(inputValue);return this.#serial(()=>this.#journal.once(input.command_id,"session.options.reset",{id,...input},async()=>{
  const session=await this.#ctx.readSession(id),current=await this.options(id);if(current.revision!==input.expected_revision)throw workbenchError("session_options_conflict","Conversation options changed; reload before resetting");
  const overrides={...current.overrides};for(const key of input.fields??["connection_id","model","reasoning_effort","mode","permission_preset"])delete overrides[key];
  const resolved=this.#resolve(session.header.project_id,overrides);this.#validate(resolved.options);await this.#assertGrant(resolved.options);
  const next={session_id:id,revision:current.revision+1,overrides,...resolved},all={...this.#sessionOptions,[id]:next};await atomicPrivateJson(this.#sessionFile(),all);this.#sessionOptions=all;return next;
 }));}
 #validate(options:SessionRunOptions){
  const rank={"read-only":0,"workspace-write":1,"full-write":2};if(rank[options.permission_preset]>rank[this.#ctx.permission.snapshot().ceiling_preset_key])throw workbenchError("permission_ceiling","The selected permission is not yet allowed by this installation");
  if(options.connection_id){const value=this.#configs.get(options.connection_id),entry=this.#registry.entries.find(e=>e.id===options.connection_id);if(!value||!entry)throw workbenchError("model_connection_missing","Choose an available saved model",404);if(options.model&&!entry.models.includes(options.model))throw workbenchError("model_not_configured","This model is not configured for the selected service",400);}
  else if(options.model)throw workbenchError("model_connection_required","Choose a saved service for this model",400);
 }
 async #assertGrant(options:SessionRunOptions){if(options.permission_preset==="full-write"&&this.#ctx.permission.snapshot().ceiling_source==="user-consent"&&!(await this.#ctx.permission.localGrant()).enabled)throw workbenchError("permission_grant_revoked","Full access has been revoked for new operations");}
 async resolvePolicy(projectId:string,sessionId?:string){const workspace=await this.#ctx.resolveWorkspace(projectId);const session=sessionId?await this.#ctx.readSession(sessionId):undefined;if(session&&session.header.project_id!==projectId)throw workbenchError("session_project_mismatch","Conversation belongs to another project");const options=sessionId?(await this.options(sessionId)).options:this.#resolve(projectId).options;await this.#assertGrant(options);return this.#ctx.permission.resolveProject(workspace.real_root,options.permission_preset);}
 /** Read-only recovery admission. Never selects a new default or performs a provider probe. */
 async resolveRecoveryModel(input:Parameters<NonNullable<AgentRuntimeOptions["resolveRecoveredModel"]>>[0]):Promise<{model:ModelAdapter;permissionPolicy:EffectivePermissionPolicy}>{
  const session=await this.#ctx.readSession(input.sessionId);if(session.header.project_id!==input.projectId||!session.header.run_ids.includes(input.runId))throw workbenchError("session_project_mismatch","Recovered task is outside this conversation",403);
  const binding=input.modelBinding;let selected:ModelAdapter;
    if(binding){const entry=this.#registry.entries.find(value=>value.id===binding.connection_id),config=this.#configs.get(binding.connection_id);if(!entry||!config||!config.hasKey||entry.revision!==binding.revision||!entry.models.includes(binding.model))throw workbenchError("delivery_model_binding_changed","The original saved model or credential configuration is unavailable",409);selected=this.#ctx.model.forConfiguration({...config.config,model:binding.model},binding.capabilities??this.#modelCapabilities(entry,config,binding.model));}
  else {if(!this.#ctx.fallbackModel)throw workbenchError("delivery_model_binding_missing","The original model connection is unavailable",409);selected=this.#ctx.fallbackModel;}
  if(selected.recoveryIdentity?.()!==input.expectedIdentity){selected.releaseRun?.();throw workbenchError("delivery_model_binding_changed","The original provider/model/credential identity has changed",409);}
  try{const permissionPolicy=await this.resolvePolicy(input.projectId,input.sessionId);return{model:Object.assign(Object.create(selected),{recoveryIdentity:()=>selected.recoveryIdentity?.(),forRun:()=>selected,releaseRun:()=>selected.releaseRun?.()}),permissionPolicy};}catch(error){selected.releaseRun?.();throw error;}
 }
 async prepare(input:StartRunRequest,workspace:WorkspaceHandle,trustedControl?:{requestBudget:ModelRequestBudget;backgroundModelDerivation:false}):Promise<TrustedRunDispatch>{
  if(workspace.project_id!==input.project_id)throw workbenchError("workspace_project_mismatch","Workspace belongs to another project",403);
  if(input.session_id&&(await this.#ctx.readSession(input.session_id)).header.project_id!==input.project_id)throw workbenchError("session_project_mismatch","Conversation belongs to another project",403);
  const saved=input.session_id?(await this.options(input.session_id)).options:this.#resolve(input.project_id).options;
  const options=SessionRunOptionsSchema.parse({...saved,...input.run_options,mode:input.run_options?.mode??input.mode,reasoning_effort:input.reasoning_effort??input.run_options?.reasoning_effort??saved.reasoning_effort});this.#validate(options);await this.#assertGrant(options);
  const config=options.connection_id?this.#configs.get(options.connection_id):undefined,entry=this.#registry.entries.find(e=>e.id===options.connection_id);
  if(config&&!config.hasKey)throw workbenchError("credential_required","Replace the API key before starting a task",400);
  const selectedModel=options.model??config?.config.model;
  const modelCapabilities=selectedModel&&config&&entry?this.#modelCapabilities(entry,config,selectedModel):undefined;
  const imageInput=Boolean(modelCapabilities?.image_input);
  // Capture the credential lease before yielding to policy/workspace admission.
  const selected=config&&entry?this.#ctx.model.forConfiguration({...config.config,model:options.model??config.config.model},modelCapabilities):this.#ctx.fallbackModel??this.#ctx.model.forConfiguration(undefined);
  let transferred=false;
  const adapter:ModelAdapter=Object.assign(Object.create(selected),{forRun:()=>{transferred=true;return selected;},recoveryIdentity:()=>selected.recoveryIdentity?.()});
  try{const permissionPolicy=await this.#ctx.permission.resolveProject(workspace.real_root,options.permission_preset);
   const projectFileContexts=await this.#fileContexts(input.project_id,input.file_contexts??[],permissionPolicy);
   return {
   identity:trustedControl?`conversation-options:${trustedControl.requestBudget.identity}`:"conversation-options",release:()=>{if(!transferred)selected.releaseRun?.();},
   start:async(runInput)=>{const projection=await this.#ctx.start({...runInput,mode:options.mode,reasoning_effort:options.reasoning_effort},{model:adapter,permissionPolicy,...trustedControl,...(projectFileContexts.length?{projectFileContexts}:{}),...(entry&&config?{modelBinding:{connection_id:entry.id,revision:entry.revision,model:options.model??config.config.model,image_input:imageInput,...(modelCapabilities?{capabilities:modelCapabilities}:{})}}:{})});
    if(!transferred)selected.releaseRun?.();
    if(projection.session_id)await this.#serial(async()=>{if(!this.#sessionOptions[projection.session_id!]){const overrides=SessionRunOptionsOverrideSchema.parse({...input.run_options,mode:input.mode,...(input.reasoning_effort===undefined?{}:{reasoning_effort:input.reasoning_effort})});const all={...this.#sessionOptions,[projection.session_id!]:{session_id:projection.session_id!,revision:0,options,overrides}};await atomicPrivateJson(this.#sessionFile(),all);this.#sessionOptions=all;}});return projection;},
 };}catch(error){selected.releaseRun?.();throw error;}
 }
 async #fileContexts(projectId:string,refs:readonly ProjectFileContextRef[],policy:EffectivePermissionPolicy){
  if(!refs.length)return [];
  if(!this.#ctx.readFileContext)throw workbenchError("file_context_unavailable","Project file context is unavailable in this Host",503);
  const snapshots:ProjectFileContextSnapshot[]=[];
  let total=0;
  for(const ref of refs){const snapshot=await this.#ctx.readFileContext(projectId,ref.path,policy);if(snapshot.sha256!==ref.expected_sha256)throw workbenchError("file_context_revision_conflict","The selected file changed. Select its current version before starting",409);total+=snapshot.byte_length;if(total>MAX_PROJECT_CONTEXT_TOTAL_BYTES)throw workbenchError("file_context_limit","Selected files exceed the 128 KiB total context limit",413);snapshots.push(snapshot);}
  const parsed=ProjectFileContextSnapshotsSchema.safeParse(snapshots);if(!parsed.success)throw workbenchError("file_context_limit","Select at most five files within the 128 KiB total context limit",413);return parsed.data;
 }
 getPermissionGrant(){return this.#ctx.permission.localGrant();}
 setPermissionGrant(input:PermissionGrantUpdateRequest){return this.#serial(()=>this.#journal.once(input.command_id,"permission.grant",input,()=>this.#ctx.permission.setLocalFullGrant(input.enabled)));}
}
import {ModelCapabilityTestResultSchema,type ModelCapabilityTestResult} from "@tracegraph/contracts";
const OPENAI_OFFICIAL_MODEL_CAPABILITIES:Readonly<Record<string,Omit<ModelCatalogEntry,"id"|"name"|"source"|"capability_status">>>={
 "gpt-6-astra":{context_window_tokens:1_050_000,max_output_tokens:128_000,input_modalities:["text","image"],output_modalities:["text"],reasoning_efforts:["low","medium","high","xhigh","max"]},
 "gpt-6.1-sol":{context_window_tokens:1_050_000,max_output_tokens:128_000,input_modalities:["text","image"],output_modalities:["text"],reasoning_efforts:["low","medium","high","xhigh","max"]},
 "gpt-6-luna":{context_window_tokens:1_050_000,max_output_tokens:128_000,input_modalities:["text","image"],output_modalities:["text"],reasoning_efforts:["none","low","medium","high","xhigh","max"]},
};
class ModelCatalogError extends Error{constructor(readonly code:string){super(code);this.name="ModelCatalogError";}}
async function fetchModelCatalog(config:ModelProviderConfig,apiKey:string):Promise<ModelCatalogEntry[]>{
 const base=new URL(config.baseUrl),path=`${base.pathname.replace(/\/+$/u,"")}/models`;base.pathname=path;base.search="";base.hash="";
 const anthropic=config.protocol==="anthropic-messages";
 let response:Response;
 try{response=await fetch(base,{headers:anthropic?{"x-api-key":apiKey,"anthropic-version":"2023-06-01"}:{authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(15_000)});}catch(error){if(error instanceof Error&&error.name==="TimeoutError")throw new ModelCatalogError("model_catalog_timeout");throw new ModelCatalogError("model_catalog_unreachable");}
 if(!response.ok){await response.body?.cancel();throw new ModelCatalogError(response.status===401||response.status===403?"model_catalog_authentication_failed":response.status===404?"model_catalog_endpoint_unsupported":response.status===429?"model_catalog_rate_limited":response.status>=500?"model_catalog_provider_unavailable":"model_catalog_request_failed");}
 const raw=await readCatalogBody(response,1_048_576);let payload:unknown;try{payload=JSON.parse(raw) as unknown;}catch{throw new ModelCatalogError("model_catalog_invalid_response");}
 if(!payload||typeof payload!=="object"||!Array.isArray((payload as {data?:unknown}).data))throw new ModelCatalogError("model_catalog_invalid_response");
 const rawModels=(payload as {data:unknown[]}).data;if(rawModels.length===0)throw new ModelCatalogError("model_catalog_empty");
 const entries:ModelCatalogEntry[]=[];
 for(const rawModel of rawModels.slice(0,1000)){
  if(!rawModel||typeof rawModel!=="object")continue;const value=rawModel as Record<string,unknown>;if(typeof value.id!=="string"||!value.id.trim()||value.id.length>200)continue;
  const id=value.id.trim();const official=config.provider==="openai"&&new URL(config.baseUrl).hostname==="api.openai.com"?OPENAI_OFFICIAL_MODEL_CAPABILITIES[id]:undefined;
  const contextWindow=positiveInteger(value.context_window),maxOutput=positiveInteger(value.max_output_tokens);
  const inputModalities=stringEnums(value.input_modalities,["text","image","audio","video"] as const),outputModalities=stringEnums(value.output_modalities,["text","image","audio","video"] as const);
  const effort=isRecord(value.effort)?value.effort:undefined;const efforts=stringEnums(effort?.supported_levels,["none","low","medium","high","xhigh","max"] as const);const reasoningDefault=typeof effort?.default_level==="string"&&["none","low","medium","high","xhigh","max"].includes(effort.default_level)?effort.default_level as "none"|"low"|"medium"|"high"|"xhigh"|"max":undefined;
  const model:ModelCatalogEntry=official?{id,...(typeof value.name==="string"?{name:value.name}:{}),capability_status:"confirmed",source:"official_catalog",...official}:
   contextWindow!==undefined||maxOutput!==undefined||inputModalities!==undefined||outputModalities!==undefined||efforts!==undefined?{id,...(typeof value.name==="string"?{name:value.name}:{}),capability_status:contextWindow!==undefined&&maxOutput!==undefined&&inputModalities!==undefined&&outputModalities!==undefined?"confirmed":"partial",source:"provider_response",...(contextWindow===undefined?{}:{context_window_tokens:contextWindow}),...(maxOutput===undefined?{}:{max_output_tokens:maxOutput}),...(inputModalities===undefined?{}:{input_modalities:inputModalities}),...(outputModalities===undefined?{}:{output_modalities:outputModalities}),...(efforts===undefined?{}:{reasoning_efforts:efforts}),...(reasoningDefault===undefined?{}:{reasoning_default:reasoningDefault})}:
   {id,...(typeof value.name==="string"?{name:value.name}:{}),capability_status:"unknown",source:"model_id_only"};
  const parsed=ModelCatalogEntrySchema.safeParse(model);if(parsed.success)entries.push(parsed.data);
 }
 if(entries.length===0)throw new ModelCatalogError("model_catalog_invalid_response");return entries;
}
async function readCatalogBody(response:Response,limit:number){const reader=response.body?.getReader();if(!reader)throw new ModelCatalogError("model_catalog_invalid_response");const chunks:Uint8Array[]=[];let size=0;try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>limit){await reader.cancel();throw new ModelCatalogError("model_catalog_response_too_large");}chunks.push(item.value);}}finally{reader.releaseLock();}return Buffer.concat(chunks).toString("utf8");}
function positiveInteger(value:unknown){return typeof value==="number"&&Number.isSafeInteger(value)&&value>0?value:undefined;}
function stringEnums<const T extends readonly string[]>(value:unknown,allowed:T){if(!Array.isArray(value))return undefined;const values=value.filter((item):item is T[number]=>typeof item==="string"&&allowed.includes(item as T[number]));return [...new Set(values)];}
function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function discoveryErrorCode(error:unknown){if(error instanceof ModelCatalogError)return error.code;if(error instanceof Error&&error.name==="TimeoutError")return "model_catalog_timeout";return "model_catalog_unreachable";}
function discoveryErrorMessage(code:string){return ({model_catalog_authentication_failed:"模型认证失败，请检查 API Key。",model_catalog_endpoint_unsupported:"此服务未提供兼容的模型目录接口。",model_catalog_rate_limited:"模型服务暂时限流，请稍后重试。",model_catalog_provider_unavailable:"模型服务暂时不可用。",model_catalog_timeout:"连接模型服务超时。",model_catalog_empty:"服务没有返回可用模型。",model_catalog_invalid_response:"模型服务返回的数据无法识别。",model_catalog_response_too_large:"模型目录响应超过安全读取上限。",model_catalog_unreachable:"无法连接模型服务，请检查地址和网络。",model_catalog_request_failed:"模型目录请求失败。"} as Record<string,string>)[code]??"模型目录读取失败。";}
