import {HostConnectionError,ModelConnectionSaveRequestSchema,SessionRunOptionsSchema,SessionRunOptionsUpdateRequestSchema,ProjectFileSaveRequestSchema,AnswerFeedbackRequestSchema} from "@tracegraph/contracts";
import {randomUUID} from "node:crypto";
import {readFile,stat,writeFile} from "node:fs/promises";
import {extname,resolve} from "node:path";
import {LocalHostConnectionSupervisor,supervisedLocalHost,ensureLocalHost,connectLocalHost,type ConnectedLocalHost,previewLegacyMigration,commitLegacyMigration,type LegacyMigrationOptions} from "@tracegraph/host";
import {redactSensitiveText} from "@tracegraph/core";
import {
  ApprovalCommandSchema,ApprovePlanRequestSchema,ModelConfigUpdateRequestSchema,PermissionPresetUpdateRequestSchema,
  SessionListQuerySchema,StartChatRequestSchema,StartRunRequestSchema,SubmitUserInputRequestSchema,
  ImageProviderConfigUpdateSchema,StartMediaRunRequestSchema,MediaOperationSchema,ReceiptSchema,
  TodoWriteInputSchema,UpdateWorkbenchSettingsRequestSchema,WorkbenchCommandRequestSchema,
  ExperienceLifecycleReviewRequestSchema,MAX_ATTACHMENT_BYTES,type WorkbenchCommandRequest,
  ProjectFileContextRefsSchema, ProjectFilePathSchema, MAX_PROJECT_CONTEXT_FILES, MAX_PROJECT_CONTEXT_FILE_BYTES, MAX_PROJECT_CONTEXT_TOTAL_BYTES,
} from "@tracegraph/contracts";
import type {TraceGraphClient} from "@tracegraph/sdk";
import {runTeamCommand} from "./team-command.js";
import {runMemoryCommand} from "./memory-command.js";
import {runExtensionsCommand} from "./extension-command.js";
import {runMcpCommand} from "./mcp-command.js";
import {attachHostTerminal} from "./terminal-attach.js";

export interface WorkbenchCommandOptions {
  connect?: (options:{profileRoot?:string}, start:boolean)=>Promise<ConnectedLocalHost>;
  write?: (text:string)=>void;
  writeError?: (text:string)=>void;
  readStdin?: ()=>Promise<string>;
  signal?: AbortSignal;
}
const HEADS=new Set(["models","files","feedback","host","config","model","image","media","doctor","capabilities","projects","chat","run","sessions","approval","todo","artifact","attachments","replay","rollback","experience","usage","lsp","telemetry","terminal","preview","git","schedule","resources","team","memory","skills","mcp","extensions"]);
const BOOL=new Set(["--confirm-full-access","--json","--jsonl","--key-stdin","--stdin","--force","--readonly","--help","--enabled","--disabled","--wait","--dry-run","--commit"]);
const REPEAT=new Set(["--attachment-upload-id","--path","--context"]);
const VALUES=new Set(["--profile-root","--command-id","--input-file","--input-json","--name","--template","--access","--project-id","--session-id","--run-id","--task","--mode","--reasoning-effort","--preset","--provider","--protocol","--base-url","--model","--limit","--view","--q","--cursor","--title","--approval-id","--action-id","--plan-event-id","--reason","--kind","--body","--input-id","--todo-id","--state","--file","--media-type","--delivery","--output","--until-sequence","--from","--to","--after-sequence","--after-cursor","--timeout-ms","--sequence","--action","--text","--cols","--rows","--scope","--base","--message","--branch","--worktree-path","--command","--args-json","--port","--source-id","--source","--inventory-json","--server-name","--expected-head","--connection-id","--expected-revision","--expected-sha256","--answer-event-id","--feedback-value","--approval-decision","--image-model","--prompt","--format","--size","--quality","--artifact-id"]);
const HELP=`Outlive shared local Workbench CLI\nUsage: outlive <command> [--profile-root <path>] [--json]\n  host start|status|restart|stop\n  doctor | capabilities | resources | usage | telemetry | lsp\n  config get|set --input-file <json> | config permission get|set --preset <preset>\n  models list|save --input-file <json> [--key-stdin]|test|remove <id> --expected-revision <n>\n  files list|read|save|reconcile --project-id <id> [--path <relative-path>]\n  feedback get|set --run-id <id> [--answer-event-id <id> --feedback-value like|dislike|clear]\n  sessions options-get|options-set <id> [--input-file <json>]\n  config permission grant-status|grant|revoke [--confirm-full-access]\n  model get|configure --provider <provider> --protocol <protocol> --base-url <url> --model <name> [--key-stdin] | model test|clear-key\n  image get|configure --protocol openai-images|openai-responses|openai-chat-images --base-url <url> --model <name> [--image-model <name>] [--key-stdin] | image clear\n  media generate --prompt <text> [--project-id <id>] [--output <new-file>]\n  media diagram|chart --input-file <json> [--project-id <id>] [--output <new-file>]\n  media export --run-id <id> --artifact-id <id> --output <new-file>\n  projects list|create --name <name>|register <directory> [--readonly]|remove <id>\n  chat start --task <text> [--session-id <id>]\n  run start --project-id <id> --task <text> [--mode plan|execute] [--context <project-relative UTF-8 file>]... | run get|events|activity|model <run-id>\n  run input|stop|approve|reject|approve-plan|rollback <run-id> [exact command flags]\n  sessions list|get|rename|delete|resume|archive|unarchive [id]\n  todo list|create|update|write <run-id> [--todo-id <id>] [--title <text>] [--state <state>] [--input-file <json>]\n  artifact get <run-id> <artifact-id>\n  attachments upload --file <path> [--project-id <id>] | attachments content <run-id> <attachment-id> --output <path>\n  replay create|diff --session-id <id> --run-id <id> --until-sequence <n> [--from <n> --to <n>]\n  experience list|review <case-id> --sequence <n> --action validate|reject|revoke\n  terminal list|create|attach|input|resize|close [id] | preview list|start|register|stop [id]\n  git status|diff|stage|unstage|discard|commit|branch|worktree-create|worktree-remove --project-id <id> [...]\n  schedule list|create|update|delete|run|history [id] [--input-file <json>]\n  team / memory / skills / mcp / extensions retain their named workflows through the shared Host.\nMutations accept --command-id for exact retries; events/activity/model write real JSONL. Model/image keys use stdin only. Media writes PNG or constrained SVG; unknown image outcomes are never retried automatically.\n`;
class UsageError extends Error {}
class Arguments {
  readonly positional:string[]=[];readonly values=new Map<string,string[]>();readonly used=new Set<string>();
  constructor(args:readonly string[]){for(let i=0;i<args.length;i++){const token=args[i]!;if(!token.startsWith("--")){this.positional.push(token);continue;}if(BOOL.has(token)){if(this.values.has(token))throw new UsageError(`Duplicate flag ${token}`);this.values.set(token,["true"]);continue;}if(!VALUES.has(token)&&!REPEAT.has(token))throw new UsageError(`Unknown flag ${token}`);const value=args[++i];if(value===undefined||value.startsWith("--"))throw new UsageError(`${token} requires a value`);if(this.values.has(token)&&!REPEAT.has(token))throw new UsageError(`Duplicate flag ${token}`);this.values.set(token,[...this.values.get(token)??[],value]);}}
  value(name:string):string|undefined{this.used.add(name);return this.values.get(name)?.[0];}
  all(name:string):string[]{this.used.add(name);return this.values.get(name)??[];}
  bool(name:string):boolean{return this.value(name)!==undefined;}
  required(name:string):string{const value=this.value(name);if(value===undefined)throw new UsageError(`${name} is required`);return value;}
  id(index=0):string{const value=this.positional[index];if(!value)throw new UsageError("A scoped resource id is required");return value;}
  integer(name:string,fallback?:number):number{const value=this.value(name);if(value===undefined&&fallback!==undefined)return fallback;const parsed=Number(value);if(value===undefined||!Number.isSafeInteger(parsed)||parsed<0)throw new UsageError(`${name} requires a nonnegative integer`);return parsed;}
  done(count=0):void{if(this.positional.length!==count)throw new UsageError("Unexpected positional arguments");for(const key of this.values.keys())if(!this.used.has(key))throw new UsageError(`Flag ${key} does not apply to this operation`);}
}
function outputSafe(value:unknown):unknown {
  if(Array.isArray(value))return value.map(outputSafe);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,["token","replay_token","api_key"].includes(key)?"[private]":outputSafe(entry)]));
  return value;
}
function businessExit(value:unknown):number {
  if(!value||typeof value!=="object")return 0;
  const record=value as Record<string,unknown>;
  if(["failed","failure","conflict","rejected","denied","cancelled","interrupted","needs_manual_review"].includes(String(record.status)))return 1;
  if(["unknown","pending","awaiting_approval","awaiting_plan_approval"].includes(String(record.status)))return 3;
  if(record.business_status!==undefined&&record.business_status!=="success")return 1;
  if(record.receipt!==undefined)return businessExit(record.receipt);
  return 0;
}
async function stdinText():Promise<string>{let value="";for await(const chunk of process.stdin){value+=String(chunk);if(Buffer.byteLength(value)>MAX_ATTACHMENT_BYTES)throw new UsageError("stdin exceeds the product limit");}return value;}

/** Return undefined only for an older command not owned by the shared local surface. */
export async function maybeRunWorkbenchCommand(argv:readonly string[],options:WorkbenchCommandOptions={}):Promise<number|undefined> {
  const head=argv[0];if(head===undefined||!HEADS.has(head))return undefined;
  const write=options.write??(text=>{process.stdout.write(text);});
  const writeError=options.writeError??(text=>{process.stderr.write(text);});
  const readStdin=options.readStdin??stdinText;
  let connection:ConnectedLocalHost|undefined;
  const localAbort=new AbortController();let timedOut=false;
  const abort=()=>localAbort.abort();
  options.signal?.addEventListener("abort",abort,{once:true});
  if(options.signal?.aborted)abort();
  if(!options.signal)process.once("SIGINT",abort);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    if(argv.includes("--help")){write(HELP);return 0;}
    if(argv.some(value=>["--api-key","--token","--credential"].includes(value)))throw new UsageError("Credentials are accepted through model/image --key-stdin only");
    const argsForLegacy=extractGlobalFlags(argv.slice(1));
    if(["team","memory","mcp","extensions"].includes(head)){
      if(argsForLegacy.args.includes("--host-url"))throw new UsageError("Shared local commands use --profile-root instead of --host-url");
      connection=await (options.connect??defaultConnect)(argsForLegacy.profileRoot===undefined?{}:{profileRoot:argsForLegacy.profileRoot},true);
      const lines:string[]=[];const deps={createClient:()=>connection!.client,write:(text:string)=>lines.push(text)};
      if(head==="team")await runTeamCommand(argsForLegacy.args,deps);else if(head==="memory")await runMemoryCommand(argsForLegacy.args,deps);else if(head==="mcp")await runMcpCommand(argsForLegacy.args,deps);else await runExtensionsCommand(argsForLegacy.args,deps);
      const value=JSON.parse(lines.join(""));write(JSON.stringify(outputSafe(value),null,2)+"\n");return businessExit(value);
    }
    const sub=argv[1]&&!argv[1]!.startsWith("--")?argv[1]:undefined;
    const args=new Arguments(argv.slice(sub===undefined?1:2));
    const profileRoot=args.value("--profile-root");args.bool("--json");args.bool("--jsonl");
    const commandId=args.value("--command-id")??randomUUID();
    const timeoutMs=args.integer("--timeout-ms",60_000);if(timeoutMs>0)timeout=setTimeout(()=>{timedOut=true;localAbort.abort();},timeoutMs);
    const connect=()=> {const scope=profileRoot===undefined?{}:{profileRoot};const start=!(head==="host"&&["status","stop"].includes(sub??""));return options.connect?options.connect(scope,start):defaultConnect(scope,start,head==="host"&&sub==="start");};
    const perform=async<T>(action:()=>Promise<T>|T,count=0):Promise<T>=>{args.done(count);return action();};
    const inputJson=async():Promise<unknown>=>{const inline=args.value("--input-json");const file=args.value("--input-file");if((inline===undefined)===(file===undefined))throw new UsageError("Provide exactly one --input-file or --input-json");const text=inline??(file==="-"?await readStdin():await readFile(resolve(file!),"utf8"));if(Buffer.byteLength(text)>1_048_576)throw new UsageError("JSON input exceeds the product limit");return JSON.parse(text);};
    // Validate unknown flags before opening a profile; operation-specific validation precedes each mutation.
    if(head==="host"&&(sub==="migration"||sub==="migrate")){
      const operation=sub==="migrate"?(args.bool("--commit")?"commit":args.bool("--dry-run")?"preview":undefined):args.positional.shift();
      if(operation==="result") {
        const id=args.id();args.done(1);
        if(!/^[A-Za-z0-9:._-]{1,256}$/u.test(id))throw new UsageError("A migration operation identifier is required");
        connection=await (options.connect??defaultConnect)(profileRoot===undefined?{}:{profileRoot},false);
        const value=await connection.native.migrationResult(id);
        write(JSON.stringify(outputSafe(value),null,2)+"\n");return value.state==="succeeded"?0:value.state==="failed"?1:3;
      }
      const inventory=args.value("--inventory-json");
      const supplied=inventory===undefined?await inputJson():JSON.parse(await readFile(resolve(inventory),"utf8"));
      if(!supplied||typeof supplied!=="object"||!("sources" in supplied)||!Array.isArray(supplied.sources))throw new UsageError("Migration input requires explicit sources");
      const selected=args.value("--source-id")??args.value("--source");
      const request={...supplied,...(profileRoot===undefined?{}:{profileRoot}),...(selected===undefined?{}:{selectedSourceId:selected})} as LegacyMigrationOptions;
      args.done();
      if(operation!=="preview"&&operation!=="commit")throw new UsageError("host migration requires preview or commit");
      let current:ConnectedLocalHost|undefined;
      try { current=await (options.connect??defaultConnect)(profileRoot===undefined?{}:{profileRoot},false); }
      catch(error) {
        // This explicit offline migration path still acquires the profile/root leases.
        // Only a never-bound, absent owner may use it; stop/replay/identity errors stay closed.
        const absentOwner=error instanceof HostConnectionError&&error.code==="host_recovery_exhausted"&&error.connection.state==="offline"&&error.connection.generation===0;
        if(!absentOwner&&!["ENOENT","ECONNREFUSED","ECONNRESET"].includes((error as NodeJS.ErrnoException).code??""))throw error;
      }
      connection=current;
      const value=current
        ? operation==="preview"?await current.native.previewMigration(request):await current.native.commitMigration(request)
        : operation==="preview"?await previewLegacyMigration(request):await commitLegacyMigration(request);
      write(JSON.stringify(outputSafe(value),null,2)+"\n");return 0;
    }
    connection=await connect();const client=connection.client;
    let result:unknown;
    if(head==="host"){
      if(sub==="start"||sub==="status")result=await perform(()=>connection!.status);
      else if(sub==="restart")result=await perform(()=>client.workbenchCommand({type:"host.restart",command_id:commandId}));
      else if(sub==="stop")result=await perform(async()=>{await connection!.stop();return {status:"succeeded",code:"host_stopping"};});
      else throw new UsageError("host requires start, status, restart or stop");
    } else if(head==="doctor")result=await perform(()=>client.workbenchCommand({type:"host.diagnostics",command_id:commandId}));
    else if(head==="capabilities")result=await perform(()=>client.getCapabilities());
    else if(head==="models"){
      if(sub==="list")result=await perform(()=>client.getModelConnections());
      else if(sub==="save"){const raw=await inputJson() as Record<string,unknown>;if("api_key" in raw)throw new UsageError("Model keys must use --key-stdin");const key=args.bool("--key-stdin");const input=ModelConnectionSaveRequestSchema.parse({...raw,command_id:commandId,...(key?{api_key:(await readStdin()).replace(/[\r\n]+$/u,"")}:{})});result=await perform(()=>client.saveModelConnection(input));}
      else if(sub==="remove"){const id=args.id(),revision=args.integer("--expected-revision");result=await perform(()=>client.removeModelConnection(id,{command_id:commandId,expected_revision:revision}),1);}
      else if(sub==="test"){const id=args.id();result=await perform(()=>client.testModelConnection(id,{command_id:commandId}),1);}
      else throw new UsageError("models requires list, save, remove or test");
    }
    else if(head==="files"){
      const project=args.required("--project-id"),path=args.value("--path");
      if(sub==="list")result=await perform(()=>client.listProjectFiles(project,path?{path}:{}));
      else if(sub==="read"){if(!path)throw new UsageError("--path is required");result=await perform(()=>client.readProjectFile(project,{path}));}
      else if(sub==="reconcile")result=await perform(()=>client.reconcileProjectFileSave(project,{command_id:commandId}));
      else if(sub==="save"){if(!path)throw new UsageError("--path is required");const expected=args.required("--expected-sha256"),file=args.value("--file"),stdin=args.bool("--stdin");if((file===undefined)===(!stdin))throw new UsageError("Provide --file or --stdin for file content");const content=file?await readFile(resolve(file),"utf8"):await readStdin(),session=args.value("--session-id"),approval=args.value("--approval-id"),decision=args.value("--approval-decision");const input=ProjectFileSaveRequestSchema.parse({command_id:commandId,path,expected_sha256:expected,content,...field("session_id",session),...(approval?{approval:{approval_id:approval,decision:decision??"approve"}}:{})});result=await perform(()=>client.saveProjectFile(project,input));}
      else throw new UsageError("files requires list, read, save or reconcile");
    }
    else if(head==="feedback"){const run=args.required("--run-id");if(sub==="get")result=await perform(()=>client.getAnswerFeedback(run));else if(sub==="set"){const input=AnswerFeedbackRequestSchema.parse({command_id:commandId,answer_event_id:args.required("--answer-event-id"),value:args.required("--feedback-value")});result=await perform(()=>client.setAnswerFeedback(run,input));}else throw new UsageError("feedback requires get or set");}
    else if(head==="resources")result=await perform(()=>client.getWorkbenchResources());
    else if(head==="usage") { const project=args.value("--project-id"),session=args.value("--session-id"),from=args.value("--from"),to=args.value("--to");
      if(project||session||from||to){const query=WorkbenchCommandRequestSchema.parse({type:"usage.query",command_id:commandId,...field("project_id",project),...field("session_id",session),...field("from",from),...field("to",to)});result=await perform(async()=>{const value=await client.workbenchCommand(query);return value.usage??value;});}else result=await perform(()=>client.getUsage());
    }
    else if(head==="telemetry")result=await perform(()=>client.getTelemetryStatus());
    else if(head==="lsp") {if(sub===undefined||sub==="list")result=await perform(()=>client.getLspStatus());else if(sub==="restart"){const server=args.positional[0]??args.required("--server-name");result=await perform(()=>client.workbenchCommand({type:"lsp.restart",command_id:commandId,server_name:server}),args.positional.length?1:0);}else throw new UsageError("lsp requires list or restart <server-name>");}
    else if(head==="model"||(head==="config"&&sub==="model")){
      const operation=head==="model"?sub:args.positional.shift();
      if(operation==="get")result=await perform(()=>client.getModelConfig());
      else if(operation==="test")result=await perform(()=>client.testModel({command_id:commandId}));
      else if(operation==="clear-key")result=await perform(()=>client.workbenchCommand({type:"model.clear-key",command_id:commandId}));
      else if(operation==="configure"||operation==="set"){
        const keyStdin=args.bool("--key-stdin");
        const input=ModelConfigUpdateRequestSchema.parse({provider:args.required("--provider"),protocol:args.required("--protocol"),base_url:args.required("--base-url"),model:args.required("--model"),...(keyStdin?{api_key:(await readStdin()).replace(/[\r\n]+$/u,"")}:{})});
        result=await perform(()=>client.configureModel(input));
      }else throw new UsageError("model requires get, configure, test or clear-key");
    }else if(head==="image"){
      if(sub==="get")result=await perform(()=>client.getImageConfig());
      else if(sub==="clear")result=await perform(()=>client.clearImageProvider());
      else if(sub==="configure") {const key=args.bool("--key-stdin");const input=ImageProviderConfigUpdateSchema.parse({protocol:args.required("--protocol"),base_url:args.required("--base-url"),model:args.required("--model"),...field("image_model",args.value("--image-model")),...(key?{api_key:(await readStdin()).replace(/[\r\n]+$/u,"")}:{})});result=await perform(()=>client.configureImageProvider(input));}
      else throw new UsageError("image requires get, configure or clear; generated raster output is PNG only");
    }else if(head==="media"){
      if(sub==="export"){const run=args.required("--run-id"),id=args.required("--artifact-id"),output=resolve(args.required("--output"));result=await perform(async()=>{const content=await client.getArtifactContent(run,id);await writeFile(output,content.bytes,{flag:"wx",mode:0o600});return {status:"succeeded",run_id:run,artifact_id:id,media_type:content.mediaType,sha256:content.sha256,bytes:content.bytes.byteLength,output};});}
      else if(["generate","diagram","chart"].includes(sub??"")){
        const project=args.value("--project-id"),outputValue=args.value("--output");
        const operation=MediaOperationSchema.parse(sub==="generate"?{kind:"generate",prompt:args.required("--prompt"),...field("format",args.value("--format")),...field("size",args.value("--size")),...field("quality",args.value("--quality"))}:{...await inputJson() as object,kind:sub});
        const input=StartMediaRunRequestSchema.parse({command_id:commandId,...field("project_id",project),operation});
        result=await perform(async()=>{
          const started=await client.startMediaRun(input);const run=await waitRun(client,started.run_id,localAbort.signal);
          const receipts=run.timeline.filter(event=>["tool.completed","tool.failed","tool.unknown"].includes(event.type)).map(event=>ReceiptSchema.safeParse(event.data.receipt)).filter(value=>value.success).map(value=>value.data!);
          const receipt=receipts.find(value=>["generate_image","render_diagram","render_chart"].includes(value.tool_name));
          if(receipt?.business_status==="unknown")return {status:"unknown",code:receipt.code,run_id:run.run_id,message:"Provider outcome unknown; inspect the existing Run/provider account before creating another request"};
          if(["awaiting_approval","awaiting_plan_approval"].includes(run.status))return {status:"pending",code:"media_approval_required",run_id:run.run_id,approval:run.pending_approval};
          const ref=receipt?.business_status==="success"&&receipt.code==="media_artifact_created"?receipt.artifact_refs.find(artifact=>artifact.run_id===run.run_id&&artifact.project_id===run.project_id&&["image/png","image/svg+xml"].includes(artifact.mime_type)&&run.artifact_refs.some(canonical=>canonical.artifact_id===artifact.artifact_id&&canonical.content_hash===artifact.content_hash)):undefined;
          if(run.status!=="completed"||!ref)return {status:"failed",code:receipt?.code??"media_output_missing",run_id:run.run_id,message:"No verified successful media Artifact is recorded",...(receipt?{receipt}:{})};
          const content=await client.getArtifactContent(run.run_id,ref.artifact_id);if(content.sha256!==ref.content_hash||content.mediaType!==ref.mime_type||content.bytes.byteLength!==ref.byte_length)throw new Error("Media content differs from its canonical receipt");
          const output=outputValue?resolve(outputValue):undefined;if(output)await writeFile(output,content.bytes,{flag:"wx",mode:0o600});return {status:"succeeded",run_id:run.run_id,project_id:run.project_id,receipt_id:receipt!.receipt_id,artifact:ref,...(output?{output}:{})};
        });
      }else throw new UsageError("media requires generate, diagram, chart or export");
    }else if(head==="config"){
      if(sub==="get")result=await perform(()=>client.getWorkbenchSettings());
      else if(sub==="set") {const input=UpdateWorkbenchSettingsRequestSchema.parse(await inputJson());result=await perform(()=>client.updateWorkbenchSettings(input));}
      else if(sub==="permission"){
        const operation=args.positional.shift();
        if(operation==="get")result=await perform(()=>client.getPermissionConfig());
        else if(operation==="set"){const input=PermissionPresetUpdateRequestSchema.parse({command_id:commandId,preset_key:args.required("--preset")});result=await perform(()=>client.configurePermissionPreset(input));}
        else if(operation==="grant"||operation==="revoke"){if(!args.bool("--confirm-full-access"))throw new UsageError("Explicit --confirm-full-access is required to change this local grant");result=await perform(()=>client.setPermissionGrant({command_id:commandId,enabled:operation==="grant",confirmed:true}));}
        else if(operation==="grant-status")result=await perform(()=>client.getPermissionGrant());
        else throw new UsageError("config permission requires get, set, grant-status, grant or revoke");
      }else throw new UsageError("config requires get, set, model or permission");
    }else if(head==="projects"){
      if(sub==="list")result=await perform(()=>client.listProjects());
      else if(sub==="create"){const name=args.required("--name"),template=args.value("--template");if(template!==undefined&&template!=="typescript")throw new UsageError("Only the typescript project template is available");result=await perform(()=>client.createProject({name,...(template===undefined?{}:{template})}));}
      else if(sub==="register"||sub==="open"){const selectedPath=resolve(args.id()),readonly=args.bool("--readonly"),access=args.value("--access")??(readonly?"read_only":"read_write");if(!["read_only","read_write"].includes(access))throw new UsageError("Invalid project access");result=await perform(()=>connection!.native.registerProject({selectedPath,access:access as "read_only"|"read_write"}),1);}
      else if(sub==="remove"){const id=args.id();result=await perform(async()=>{await client.removeProject(id,commandId);return {status:"succeeded",project_id:id};},1);}
      else if(sub==="reveal"){const id=args.id();result=await perform(()=>client.revealProject(id,commandId),1);}
      else throw new UsageError("projects requires list, create, register, reveal or remove");
    }else if(head==="chat"||(head==="run"&&sub==="start")){
      if(head==="chat"&&sub!=="start")throw new UsageError("chat requires start");
      const wait=args.bool("--wait");
      const connection=args.value("--connection-id"),modelName=args.value("--model"),preset=args.value("--preset"),mode=args.value("--mode")??(head==="chat"?"execute":"plan"),effort=args.value("--reasoning-effort");
      const runOptions=(connection||modelName||preset)?SessionRunOptionsSchema.parse({...field("connection_id",connection),...field("model",modelName),...field("permission_preset",preset),mode,...field("reasoning_effort",effort)}):undefined;
      const request={...(runOptions?{run_options:runOptions}:{}),mode,command_id:commandId,task:args.required("--task"),...field("session_id",args.value("--session-id")),...field("reasoning_effort",effort),attachment_upload_ids:args.all("--attachment-upload-id")};
      if(head==="chat"){const input=StartChatRequestSchema.parse(request);result=await perform(async()=>{const run=await client.startChat(input);return wait?waitRun(client,run.run_id,localAbort.signal):run;});}
      else {
        const projectId=args.required("--project-id"),paths=args.all("--context").map(path=>ProjectFilePathSchema.parse(path));
        if(paths.length>MAX_PROJECT_CONTEXT_FILES||new Set(paths).size!==paths.length)throw new UsageError("Choose at most five distinct project context files");
        args.done();
        result=await perform(async()=>{
          const snapshots=await Promise.all(paths.map(path=>client.readProjectFile(projectId,{path})));
          if(snapshots.some(snapshot=>snapshot.kind!=="text"||snapshot.content===undefined||snapshot.byte_length>MAX_PROJECT_CONTEXT_FILE_BYTES))throw new UsageError("Project context requires existing UTF-8 files of at most 64 KiB each");
          if(snapshots.reduce((sum,snapshot)=>sum+snapshot.byte_length,0)>MAX_PROJECT_CONTEXT_TOTAL_BYTES)throw new UsageError("Selected project context exceeds 128 KiB");
          const refs=ProjectFileContextRefsSchema.parse(snapshots.map(snapshot=>({path:snapshot.path,expected_sha256:snapshot.sha256})));
          const input=StartRunRequestSchema.parse({...request,project_id:projectId,mode,...(refs.length?{file_contexts:refs}:{})});
          const run=await client.startRun(input);return wait?waitRun(client,run.run_id,localAbort.signal):run;
        });
      }
    }else if(head==="run"||head==="approval"||head==="rollback"){
      const operation=head==="rollback"?"rollback":sub;const runId=head==="rollback"?sub??args.id():args.id();const count=head==="rollback"?0:1;
      if(operation==="cancel"&&runId.startsWith("queued:"))result=await perform(()=>client.workbenchCommand({type:"queue.cancel",command_id:commandId,holder_id:runId.slice("queued:".length)}),count);
      else if(operation==="get")result=await perform(()=>client.getRun(runId),count);
      else if(["events","activity","model"].includes(operation??"")){
        const after=operation==="model"?args.integer("--after-cursor",0):args.integer("--after-sequence",0);args.done(count);
        const stream=operation==="events"?client.streamEvents(runId,{afterSequence:after,signal:localAbort.signal,reconnect:false}):operation==="activity"?client.streamLiveActivities(runId,{afterSequence:after,signal:localAbort.signal,reconnect:false}):client.streamModelSurface(runId,{afterCursor:after,signal:localAbort.signal,reconnect:false});
        for await(const event of stream){if("type" in event&&event.type==="thinking_snapshot")continue;write(JSON.stringify(outputSafe(event))+"\n");if(localAbort.signal.aborted||("type" in event&&["run.completed","run.failed","run.cancelled"].includes(String(event.type))))break;}
        return timedOut?124:localAbort.signal.aborted?130:0;
      }else if(operation==="input") {const input=SubmitUserInputRequestSchema.parse({command_id:commandId,input_id:args.value("--input-id")??randomUUID(),kind:args.value("--kind")??"message",body:args.required("--body")});result=await perform(()=>client.submitUserInput(runId,input),count);}
      else if(operation==="approve-plan") {const input=ApprovePlanRequestSchema.parse({command_id:commandId,plan_event_id:args.required("--plan-event-id")});result=await perform(()=>client.approvePlan(runId,input),count);}
      else if(operation==="rollback") {const actionId=args.required("--action-id"),force=args.bool("--force");result=await perform(()=>client.rollbackAction(runId,actionId,{command_id:commandId,force}),count);}
      else if(operation==="stop"||operation==="cancel"||operation==="approve"||operation==="reject"){
        const reason=args.value("--reason");const current=await client.getRun(runId);
        if(operation==="stop"||operation==="cancel") {
          const cancelled=await perform(()=>client.stop(runId,{type:"stop",command_id:commandId,project_id:current.project_id,run_id:runId,...field("reason",reason)}),count);
          write(JSON.stringify(outputSafe(cancelled),null,2)+"\n");
          return cancelled.status==="cancelled"?0:["running","indexing","awaiting_approval","awaiting_plan_approval"].includes(cancelled.status)?3:1;
        }
        else {const command=ApprovalCommandSchema.parse({type:operation,command_id:commandId,project_id:current.project_id,run_id:runId,approval_id:args.required("--approval-id"),action_id:args.required("--action-id"),...field("reason",reason)});result=await perform(()=>operation==="approve"?client.approve(runId,command):client.reject(runId,command),count);}
      }else throw new UsageError("run/approval requires an exact named operation");
    }else if(head==="sessions"){
      if(sub==="list") {const query=SessionListQuerySchema.parse({view:args.value("--view")??"roots",limit:args.integer("--limit",50),...field("project_id",args.value("--project-id")),...field("q",args.value("--q")),...field("cursor",args.value("--cursor"))});result=await perform(()=>client.listSessions(query));}
      else {const id=args.id();if(sub==="get")result=await perform(()=>client.getSession(id),1);else if(sub==="options-get")result=await perform(()=>client.getSessionRunOptions(id),1);else if(sub==="options-set"){const raw=await inputJson() as object;const input=SessionRunOptionsUpdateRequestSchema.parse({...raw,command_id:commandId});result=await perform(()=>client.updateSessionRunOptions(id,input),1);}else if(sub==="rename"){const title=args.required("--title");result=await perform(()=>client.renameSession(id,{title}),1);}else if(sub==="delete")result=await perform(()=>client.deleteSession(id),1);else if(sub==="resume")result=await perform(()=>client.resumeSession(id,{command_id:commandId}),1);else if(sub==="archive"||sub==="unarchive")result=await perform(()=>client.workbenchCommand({type:sub==="archive"?"sessions.archive":"sessions.unarchive",command_id:commandId,session_id:id}),1);else throw new UsageError("Unknown sessions operation");}
    }else if(head==="todo"){
      const id=args.id();if(sub==="list")result=await perform(()=>client.getTodos(id),1);
      else if(sub==="create"||sub==="update"||sub==="write") {const input=TodoWriteInputSchema.parse(sub==="write"?await inputJson():{operation:sub,todo_id:args.required("--todo-id"),...field("title",args.value("--title")),...field("state",args.value("--state"))});result=await perform(()=>client.writeTodo(id,{command_id:commandId,input}),1);}
      else throw new UsageError("todo requires list, create, update or write");
    }else if(head==="artifact") {if(sub!=="get")throw new UsageError("artifact requires get");const run=args.id(),artifact=args.id(1);result=await perform(()=>client.getArtifact(run,artifact),2);}
    else if(head==="attachments"){
      if(sub==="upload"){const file=resolve(args.required("--file"));const metadata=await stat(file);if(!metadata.isFile()||metadata.size>MAX_ATTACHMENT_BYTES)throw new UsageError("Attachment file exceeds the product limit");const bytes=new Uint8Array(await readFile(file));const project=args.value("--project-id"),session=args.value("--session-id");const media=args.value("--media-type")??({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".pdf":"application/pdf"} as Record<string,string>)[extname(file).toLowerCase()];if(!media)throw new UsageError("Declare --media-type for this attachment");const delivery=args.value("--delivery")??"offload";if(delivery!=="inline"&&delivery!=="offload")throw new UsageError("Invalid attachment delivery");result=await perform(()=>client.uploadAttachment({command_id:commandId,declared_media_type:media,delivery,...field("session_id",session),...(project===undefined?{target:"chat" as const}:{target:"project" as const,project_id:project}),bytes}));}
      else if(sub==="content"){const run=args.id(),id=args.id(1),output=resolve(args.required("--output"));result=await perform(async()=>{const content=await client.getAttachmentContent(run,id);await writeFile(output,content.bytes,{flag:"wx",mode:0o600});return {attachment_id:id,media_type:content.mediaType,sha256:content.sha256,bytes:content.bytes.byteLength,output};},2);}
      else throw new UsageError("attachments requires upload or content");
    }else if(head==="replay"){
      const request={session_id:args.required("--session-id"),run_id:args.required("--run-id"),until_sequence:args.integer("--until-sequence")};
      if(sub==="create"||sub==="get")result=await perform(()=>client.createReplay(request));
      else if(sub==="diff"){const from=args.integer("--from"),to=args.integer("--to");result=await perform(async()=>{await client.createReplay(request);return client.getReplayDiff({from,to});});}
      else throw new UsageError("replay requires create or diff; its read-only authority ends when this CLI command exits");
    }else if(head==="experience"){
      if(sub==="list")result=await perform(()=>client.listExperienceCases());
      else if(sub==="review"){const id=args.id();const input=ExperienceLifecycleReviewRequestSchema.parse({command_id:commandId,expected_sequence:args.integer("--sequence"),action:args.required("--action")});result=await perform(()=>client.reviewExperienceCase(id,input),1);}
      else throw new UsageError("experience requires list or review");
    }else if(head==="skills"){
      if(sub==="list")result=await perform(()=>client.listSkills());else if(sub==="validate"){const project=args.required("--project-id");result=await perform(()=>client.workbenchCommand({type:"skills.validate",command_id:commandId,project_id:project}));}else throw new UsageError("skills requires list or validate --project-id");
    }else if(["terminal","preview","git","schedule"].includes(head)){
      if(head==="terminal"&&sub==="attach"){const id=args.id();args.done(1);if(args.values.has("--json")||args.values.has("--jsonl"))throw new UsageError("Interactive terminal attach writes raw output; use terminal list for JSON");return await attachHostTerminal(client,id,{signal:localAbort.signal,write});}
      else if(sub==="list"&&head!=="git"){args.done();const resources=await client.getWorkbenchResources();result=head==="terminal"?resources.terminals:head==="preview"?resources.previews:resources.schedules;}
      else {const input=await resourceCommand(head,sub,args,commandId,inputJson,readStdin);const count=head==="terminal"&&["input","resize","close"].includes(sub??"")||head==="preview"&&sub==="stop"||head==="schedule"&&["update","delete","run","history"].includes(sub??"")?1:0;result=await perform(()=>client.workbenchCommand(input),count);}
    }else throw new UsageError("Unknown Workbench operation");
    write(JSON.stringify(outputSafe(result),null,2)+"\n");return businessExit(result);
  }catch(error){
    const record=typeof error==="object"&&error!==null?error as Record<string,unknown>:{};
    const candidateStatus=record.status??record.statusCode;const status=typeof candidateStatus==="number"&&candidateStatus>=400&&candidateStatus<=599?candidateStatus:undefined;
    const code=typeof record.code==="string"&&/^[a-z][a-z0-9_]{0,100}$/u.test(record.code)?record.code:error instanceof UsageError?"invalid_arguments":status===409?"conflict":status===403?"forbidden":"operation_failed";
    const operationId=typeof record.operation_id==="string"&&/^[A-Za-z0-9:._-]{1,256}$/u.test(record.operation_id)?record.operation_id:undefined;
    const message=redactSensitiveText(error instanceof Error?error.message:"CLI command failed");
    writeError(JSON.stringify({error:{code,...(status===undefined?{}:{status}),...(operationId===undefined?{}:{operation_id:operationId}),message}})+"\n");return error instanceof UsageError?2:timedOut?124:localAbort.signal.aborted?130:1;
  }
  finally {if(timeout)clearTimeout(timeout);localAbort.abort();options.signal?.removeEventListener("abort",abort);if(!options.signal)process.removeListener("SIGINT",abort);await connection?.close();}
}
async function defaultConnect(options:{profileRoot?:string},start:boolean,explicitStart=false):Promise<ConnectedLocalHost>{
  const supervisor=new LocalHostConnectionSupervisor({...options,...(!start?{recoveryAttempts:0}:{})});
  try{if(explicitStart)await supervisor.repair();await supervisor.initialize();return await supervisedLocalHost(supervisor);}
  catch(error){await supervisor.close();throw error;}
}
function field<K extends string>(name:K,value:string|undefined):Partial<Record<K,string>> {return value===undefined?{}:{[name]:value} as Record<K,string>;}
function extractGlobalFlags(args:readonly string[]):{args:string[];profileRoot?:string}{const remaining:string[]=[];let profileRoot:string|undefined;for(let i=0;i<args.length;i++){const arg=args[i]!;if(arg==="--profile-root"){if(profileRoot!==undefined)throw new UsageError("Duplicate --profile-root");profileRoot=args[++i];if(!profileRoot||profileRoot.startsWith("--"))throw new UsageError("--profile-root requires a value");}else if(!["--json","--jsonl"].includes(arg))remaining.push(arg);}return {args:remaining,...(profileRoot===undefined?{}:{profileRoot})};}
async function resourceCommand(head:string,sub:string|undefined,args:Arguments,command_id:string,inputJson:()=>Promise<unknown>,readStdin:()=>Promise<string>):Promise<WorkbenchCommandRequest>{
  const project=()=>args.required("--project-id");let input:unknown;
  if(head==="terminal"){
    if(sub==="create")input={type:"terminal.create",command_id,project_id:project(),...field("title",args.value("--title")),cols:args.integer("--cols",100),rows:args.integer("--rows",30)};
    else if(sub==="input")input={type:"terminal.input",command_id,terminal_id:args.id(),text:args.bool("--stdin")?await readStdin():args.required("--text")};
    else if(sub==="resize")input={type:"terminal.resize",command_id,terminal_id:args.id(),cols:args.integer("--cols"),rows:args.integer("--rows")};
    else if(sub==="close")input={type:"terminal.close",command_id,terminal_id:args.id()};
    else throw new UsageError("terminal requires list, create, input, resize or close");
  }else if(head==="preview"){
    if(sub==="start")input={type:"preview.start",command_id,project_id:project(),command:args.required("--command"),args:JSON.parse(args.value("--args-json")??"[]"),port:args.integer("--port")};
    else if(sub==="register")input={type:"preview.register",command_id,project_id:project(),port:args.integer("--port")};
    else if(sub==="stop")input={type:"preview.stop",command_id,preview_id:args.id()};
    else throw new UsageError("preview requires list, start, register or stop");
  }else if(head==="git"){
    const base={command_id,project_id:project()};
    if(sub==="status")input={...base,type:"git.status"};else if(sub==="diff")input={...base,type:"git.diff",scope:args.value("--scope")??"workspace",...field("base",args.value("--base"))};
    else if(sub==="stage"||sub==="unstage"||sub==="discard")input={...base,type:`git.${sub}`,paths:args.all("--path"),...field("expected_head",args.value("--expected-head"))};
    else if(sub==="commit")input={...base,type:"git.commit",message:args.required("--message")};else if(sub==="branch")input={...base,type:"git.branch.create",name:args.required("--name")};
    else if(sub==="worktree-create")input={...base,type:"git.worktree.create",name:args.required("--name"),branch:args.required("--branch")};
    else if(sub==="worktree-remove")input={...base,type:"git.worktree.remove",worktree_path:args.required("--worktree-path")};else throw new UsageError("Unknown Git operation");
  }else if(head==="schedule"){
    if(sub==="create")input={type:"schedule.create",command_id,input:await inputJson()};else if(sub==="update")input={type:"schedule.update",command_id,schedule_id:args.id(),expected_revision:args.integer("--sequence"),input:await inputJson()};
    else if(sub==="delete"||sub==="run"||sub==="history")input={type:`schedule.${sub}`,command_id,schedule_id:args.id()};else throw new UsageError("Unknown schedule operation");
  }
  return WorkbenchCommandRequestSchema.parse(input);
}

async function waitRun(client:TraceGraphClient,runId:string,signal:AbortSignal){
  while(!signal.aborted){const run=await client.getRun(runId);if(!["created","queued","indexing","running","planning","executing"].includes(run.status))return run;await new Promise<void>(done=>{const complete=()=>{clearTimeout(timer);signal.removeEventListener("abort",complete);done();};const timer=setTimeout(complete,100);signal.addEventListener("abort",complete,{once:true});});}
  throw new Error("Waiting for the Run ended; the background Run was not cancelled");
}
