import {mkdtemp,mkdir,rm,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer,request as httpRequest} from "node:http";
import {describe,it,expect,vi} from "vitest";
import {TraceGraphClient} from "@tracegraph/sdk";
import {WorkbenchSettingsValuesSchema} from "@tracegraph/contracts";
import {startLocalHost,connectLocalHost,ensureLocalHost} from "../dist/local-host.js";
import {initializeLocalProfile} from "../dist/local-profile.js";
import {createLocalFetch} from "./local-fetch.js";

async function eventually<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean):Promise<T>{const deadline=Date.now()+10_000;while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error("Timed out waiting for canonical Host state");}
const finish={decision_id:"decision:complete",kind:"finish",public_reason:"Fixture completed",evidence_refs:[],risk:"none",final_answer:"Fixture response"};
describe("one authenticated long-lived local Host",()=>{
 it("shares real UDS/TCP state, queues same workspace, runs another workspace and survives client closure",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-owner-"));
  const pending:Array<()=>void>=[];const modelCalls:Array<{model:string;authorization:string|undefined}>=[];
  const modelServer=createServer(async(request,response)=>{let bytes="";for await(const chunk of request)bytes+=String(chunk);const payload=JSON.parse(bytes) as {model:string,messages?:Array<{content:string}>};if(payload.messages?.[0]?.content.startsWith("You extract")){response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:"No reusable facts",candidates:[]})}}]}));return;}modelCalls.push({model:payload.model,authorization:request.headers.authorization});pending.push(()=>{response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(finish)}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));});});
  await new Promise<void>(resolve=>modelServer.listen(0,"127.0.0.1",resolve));const address=modelServer.address();if(!address||typeof address==="string")throw new Error("Missing provider address");
  const owner=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});
  const a=await connectLocalHost({profileRoot:root});const b=await connectLocalHost({profileRoot:root});
  const web=new TraceGraphClient({baseUrl:owner.status.http_address});await web.bootstrap();
  try{
   expect(a.status.boot_nonce).toBe(b.status.boot_nonce);await expect(startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"})).rejects.toThrow("already owns");
   // The shared owner disables directory picking, not its trusted OS permission
   // channel. Reading these statuses must not open or accept a permission dialog.
   const hasNativePrompt=["darwin","win32"].includes(process.platform);
   for(const client of [a.client,b.client,web]){
    expect((await client.getBrowserStatus()).human_grant_available).toBe(hasNativePrompt);
    expect((await client.getComputerStatus()).human_grant_available).toBe(hasNativePrompt);
   }
   await a.client.configureModel({provider:"custom",protocol:"openai-chat-completions",base_url:`http://127.0.0.1:${address.port}/v1`,model:"isolated-fixture-model",api_key:"isolated-fixture-key"});
   expect(await web.getModelConfig()).toMatchObject({model:"isolated-fixture-model",has_key:true});expect(await b.client.getModelConfig()).toMatchObject({model:"isolated-fixture-model",has_key:true});
   await mkdir(join(root,"project-a"));await mkdir(join(root,"project-b"));const projectA=await a.native.registerProject({selectedPath:join(root,"project-a"),access:"read_write"});const projectB=await a.native.registerProject({selectedPath:join(root,"project-b"),access:"read_write"});expect((await web.listProjects()).some(x=>x.project_id===projectA.project_id)).toBe(true);
   const first=await a.client.startRun({command_id:"command:first",project_id:projectA.project_id,task:"Respond with the fixture answer",mode:"execute"});await eventually(async()=>modelCalls.length,x=>x===1);
   const queuedPromise=b.client.startRun({command_id:"command:queued",project_id:projectA.project_id,task:"Respond with the fixture answer again",mode:"execute"});
   await eventually(async()=>owner.composition.workspaceCoordinator.list(),claims=>claims.some(x=>x.holder_id==="command:queued"&&x.state==="queued"));
   const other=await b.client.startRun({command_id:"command:independent",project_id:projectB.project_id,task:"Respond independently",mode:"execute"});await eventually(async()=>modelCalls.length,x=>x===2);
   await a.close();expect((await b.client.getRun(first.run_id)).status).toBe("running");pending.shift()!();pending.shift()!();
   await eventually(()=>b.client.getRun(first.run_id),x=>x.status==="completed");await eventually(()=>b.client.getRun(other.run_id),x=>x.status==="completed");
   const queued=await queuedPromise;await eventually(async()=>modelCalls.length,x=>x>=3);pending.shift()!();await eventually(()=>b.client.getRun(queued.run_id),x=>x.status==="completed");expect(modelCalls.every(x=>x.authorization==="Bearer isolated-fixture-key")).toBe(true);
   const nativeViaTcp=await fetch(`${owner.status.http_address}/api/local/projects/register`,{method:"POST",headers:{authorization:`Bearer ${web.token}`,origin:"http://127.0.0.1:4310","content-type":"application/json"},body:JSON.stringify({selectedPath:root,access:"read_write"})});expect(nativeViaTcp.status).toBe(403);
   const discovery=JSON.parse(await readFile(join(root,"discovery.json"),"utf8")) as {socket_path:string;token:string};const bad=createLocalFetch(discovery.socket_path,"x".repeat(discovery.token.length));expect((await bad.fetch("http://outlive.local/health")).status).toBe(401);bad.close();
   expect(await b.client.listSessions({project_id:projectA.project_id})).toMatchObject({sessions:expect.any(Array)});
  }finally{for(const release of pending.splice(0))release();await a.close();await b.close();await owner.close();await new Promise<void>(resolve=>modelServer.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
 },30_000);
 it("concurrent detached launches discover one owner and reconnect without stopping it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-daemon-"));let a:Awaited<ReturnType<typeof ensureLocalHost>>|undefined,b:typeof a;
  try{[a,b]=await Promise.all([ensureLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"}),ensureLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"})]);expect(a.status.pid).toBe(b.status.pid);expect(a.status.boot_nonce).toBe(b.status.boot_nonce);expect(a.status.pid).not.toBe(process.pid);const nonce=a.status.boot_nonce;await a.close();await b.close();const reconnected=await connectLocalHost({profileRoot:root});expect(reconnected.status.boot_nonce).toBe(nonce);await reconnected.stop();await eventually(async()=>{try{await readFile(join(root,"discovery.json"));return false;}catch{return true;}},x=>x);}
  finally{await a?.close();await b?.close();try{const client=await connectLocalHost({profileRoot:root});await client.stop();}catch{}await rm(root,{recursive:true,force:true});}
 },30_000);
 it("refuses a second Runtime in a shared data root and preserves another owner's lease",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-data-owner-"));const owner=await startLocalHost({profileRoot:join(root,"a"),dataRoot:join(root,"data"),httpPort:0,credentialBackend:"private-file"});try{await expect(startLocalHost({profileRoot:join(root,"b"),dataRoot:join(root,"data"),httpPort:0,credentialBackend:"private-file"})).rejects.toThrow("already owns");const connected=await connectLocalHost({profileRoot:join(root,"a")});expect(connected.status.boot_nonce).toBe(owner.status.boot_nonce);await connected.close();}finally{await owner.close();await rm(root,{recursive:true,force:true});}
 });
 it("authenticates migration preview/commit, rejects busy resources and returns a durable receipt after owner restart",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-native-migrate-"));const profileRoot=join(root,"profile"),source=join(root,"legacy");await mkdir(source);await writeFile(join(source,"marker.txt"),"legacy evidence");
  const owner=await startLocalHost({profileRoot,httpPort:0,credentialBackend:"private-file"});let client=await connectLocalHost({profileRoot});
  try{const input={sources:[{id:"legacy",dataRoot:source}]};expect((await client.native.previewMigration(input)).files.some(x=>x.relative_path==="marker.txt")).toBe(true);
   await mkdir(join(root,"workspace"));const project=await client.native.registerProject({selectedPath:join(root,"workspace"),access:"read_write"});const workspace=await owner.composition.resolveWorkspace(project.project_id);const lease=await owner.composition.workspaceCoordinator.acquireWorkspace(workspace,{holderId:"terminal:busy",kind:"terminal"});await expect(client.native.commitMigration(input)).rejects.toMatchObject({statusCode:409});lease.release();
   const previous=client.status.boot_nonce;const result=await client.native.commitMigration(input);expect(result.selected_source_id).toBe("legacy");expect(await readFile(join(profileRoot,"data","marker.txt"),"utf8")).toBe("legacy evidence");expect(await readFile(join(source,"marker.txt"),"utf8")).toBe("legacy evidence");client=await connectLocalHost({profileRoot});expect(client.status.boot_nonce).not.toBe(previous);await client.stop();await eventually(async()=>{try{await readFile(join(profileRoot,"discovery.json"));return false;}catch{return true;}},x=>x);
  }finally{await client.close();try{const remaining=await connectLocalHost({profileRoot});await remaining.stop();}catch{}await owner.close();await rm(root,{recursive:true,force:true});}
 },30_000);

 it("explicit owner stop closes active TCP SSE and aborts a held provider before releasing writer authority",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-stop-streams-"));let contacted=false;
  const provider=createServer(async(request,_response)=>{for await(const _chunk of request){}contacted=true;});await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));const address=provider.address();if(!address||typeof address==="string")throw new Error("Provider missing");
  const owner=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});const client=await connectLocalHost({profileRoot:root});const web=new TraceGraphClient({baseUrl:owner.status.http_address});const controllers=[new AbortController(),new AbortController(),new AbortController()];
  try{await client.client.configureModel({provider:"custom",protocol:"openai-chat-completions",base_url:`http://127.0.0.1:${address.port}/v1`,model:"held-model",api_key:"isolated-stop-key"});const run=await client.client.startChat({command_id:"stop:chat",task:"Wait for provider"});await eventually(async()=>contacted,x=>x);await web.bootstrap();
   const streams=[web.streamEvents(run.run_id,{signal:controllers[0]!.signal}),web.streamLiveActivities(run.run_id,{signal:controllers[1]!.signal}),web.streamModelSurface(run.run_id,{signal:controllers[2]!.signal})];const reads=streams.map(async stream=>{try{for await(const _event of stream){}}catch{/* owner stop closes subscriptions */}});
   await new Promise(resolve=>setTimeout(resolve,100));const started=Date.now();await owner.close();expect(Date.now()-started).toBeLessThan(5_000);for(const controller of controllers)controller.abort();await Promise.all(reads);expect((await owner.composition.runtime.getProjection(run.run_id)).status).toBe("cancelled");
   const replacement=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});await replacement.close();
  }finally{for(const controller of controllers)controller.abort();await client.close();await owner.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
 },20_000);

 it("attempts all shutdown boundaries after browser cleanup fails and retains the writer lease",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-cleanup-failure-"));let contacted=false;
  const provider=createServer(async(request,_response)=>{for await(const _chunk of request){}contacted=true;});
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));const address=provider.address();if(!address||typeof address==="string")throw new Error("Missing held provider");
  const owner=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});const client=await connectLocalHost({profileRoot:root});
  const closeBrowser=owner.composition.browserControl.close.bind(owner.composition.browserControl);
  const browser=vi.spyOn(owner.composition.browserControl,"close").mockImplementation(async()=>{await closeBrowser();throw new Error("browser_cleanup_failed");});
  const computer=vi.spyOn(owner.composition.computerControl,"close");const mcp=vi.spyOn(owner.composition.mcp,"stop");const lsp=vi.spyOn(owner.composition.lsp,"stop");
  try{
   await client.client.configureModel({provider:"custom",protocol:"openai-chat-completions",base_url:`http://127.0.0.1:${address.port}/v1`,model:"held-model",api_key:"isolated-cleanup-key"});
   const run=await client.client.startChat({command_id:"cleanup:held",task:"Wait for the held provider"});await eventually(async()=>contacted,x=>x);
   await expect(owner.close()).rejects.toMatchObject({errors:[expect.objectContaining({message:"browser_cleanup_failed"})]});
   expect(browser).toHaveBeenCalledOnce();expect(computer).toHaveBeenCalledOnce();expect(mcp).toHaveBeenCalledOnce();expect(lsp).toHaveBeenCalledOnce();
   expect((await owner.composition.runtime.getProjection(run.run_id)).status).toBe("cancelled");
   await expect(fetch(`${owner.status.http_address}/health`)).rejects.toThrow();
   await expect(startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"})).rejects.toThrow("already owns");
  }finally{await client.close();await owner.close().catch(()=>undefined);await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
 },20_000);

 it("applies restart settings, keeps disabled extensions disabled on reload, and preserves cleared model drafts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-settings-restart-"));const extension="@tracegraph/builtin-artifact-tools";
  let owner=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});let connection=await connectLocalHost({profileRoot:root});
  try{
   const workspaceRoot=join(root,"workspace");await mkdir(join(workspaceRoot,".tracegraph","skills","review"),{recursive:true});await writeFile(join(workspaceRoot,".tracegraph","skills","review","SKILL.md"),["---","name: review","description: Fixture review","version: 1.0.0","allowed_tools: [read_file]","---","Read fixture files",""].join("\n"));const project=await connection.native.registerProject({selectedPath:workspaceRoot,access:"read_write"});
   expect((await connection.client.listSkills()).find(x=>x.project_id===project.project_id)?.registry.skills.map(x=>x.name)).toContain("review");expect((await connection.client.listExtensions()).find(x=>x.name===extension)?.state).toBe("active");
   const initial=await connection.client.getWorkbenchSettings();const updated=await connection.client.updateWorkbenchSettings({command_id:"settings:restart",expected_revision:initial.revision,patch:{tools:{...initial.settings.tools,disabled_skills:["review"],disabled_extensions:[extension]},telemetry:{enabled:false,endpoint:"",authorization_ref:"${secret:UNCONFIGURED_FIXTURE_TELEMETRY}"},model:{reasoning_effort:"high"}}});expect(updated.pending_restart).toEqual(expect.arrayContaining(["tools","telemetry"]));expect(updated.fields.find(x=>x.path==="model.reasoning_effort")?.effective).toBe("new-run");
   expect((await connection.client.listExtensions()).find(x=>x.name===extension)?.state).toBe("active");
   const config={provider:"custom" as const,protocol:"openai-chat-completions" as const,base_url:"http://127.0.0.1:9/v1",model:"preserved-fixture-model"};await connection.client.configureModel({...config,api_key:"isolated-draft-fixture-key"});await connection.client.workbenchCommand({type:"model.clear-key",command_id:"model:clear-fixture"});expect(await connection.client.getModelConfig()).toMatchObject({...config,configured:false,has_key:false});
   await connection.close();await owner.close();owner=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});connection=await connectLocalHost({profileRoot:root});expect((await connection.client.getWorkbenchSettings()).pending_restart).toEqual([]);
   expect((await connection.client.listExtensions()).find(x=>x.name===extension)?.state).toBe("inactive");expect((await connection.client.reloadExtension(extension,{command_id:"extension:cannot-bypass-setting"})).state).toBe("inactive");expect((await connection.client.listSkills()).find(x=>x.project_id===project.project_id)?.registry.skills.map(x=>x.name)).not.toContain("review");expect(await connection.client.getTelemetryStatus()).toMatchObject({sink:"noop",state:"disabled"});expect(await connection.client.getModelConfig()).toMatchObject({...config,configured:false,has_key:false});
   await connection.client.configureModel({...config,api_key:"isolated-restored-fixture-key"});expect(await connection.client.getModelConfig()).toMatchObject({...config,configured:true,has_key:true});
  }finally{await connection.close();await owner.close();await rm(root,{recursive:true,force:true});}
 },20_000);

 it("rolls back an initialized MCP child and writer leases when later model setup fails",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-startup-rollback-"));const marker=join(root,"mcp.pid"),script=join(root,"fixture-mcp.mjs");let owner:Awaited<ReturnType<typeof startLocalHost>>|undefined;
  try{
   const profile=await initializeLocalProfile({profileRoot:root});await writeFile(script,"import{writeFileSync}from'node:fs';import{createInterface}from'node:readline';writeFileSync(process.argv[2],String(process.pid));createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}:{tools:[]}})+'\\n');});");
   const settings=WorkbenchSettingsValuesSchema.parse({tools:{mcp:{config_version:"tracegraph.mcp.v1",servers:[{name:"fixture",command:process.execPath,args:[script,marker],required:true}]}}});await writeFile(join(root,"workbench-settings.json"),JSON.stringify({config_version:"outlive.workbench.v1",revision:1,profile_id:profile.profile_id,settings,fields:[],pending_restart:[]}));await mkdir(profile.data_root,{recursive:true});await writeFile(join(profile.data_root,"model-config.json"),"invalid JSON");
   await expect(startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"})).rejects.toThrow("invalid JSON");const childPid=Number(await readFile(marker,"utf8"));expect(Number.isSafeInteger(childPid)).toBe(true);await eventually(async()=>{try{process.kill(childPid,0);return false;}catch{return true;}},x=>x);
   await rm(join(profile.data_root,"model-config.json"));owner=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});const connected=await connectLocalHost({profileRoot:root});expect((await connected.client.getMcpStatus()).servers.find(x=>x.name==="fixture")?.state).toBe("ready");await connected.close();
  }finally{await owner?.close();await rm(root,{recursive:true,force:true});}
 },20_000);

 it("unregisters a removed worktree's metadata without deleting linked workspace files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-unregister-worktree-"));const owner=await startLocalHost({profileRoot:root,httpPort:0,credentialBackend:"private-file"});const connection=await connectLocalHost({profileRoot:root});
  try{const workspaceRoot=join(root,"workspace");await mkdir(workspaceRoot);await writeFile(join(workspaceRoot,"keep.txt"),"preserve local worktree files");const project=await connection.native.registerProject({selectedPath:workspaceRoot,access:"read_write"});await owner.composition.unregisterWorktree((await owner.composition.resolveWorkspace(project.project_id)).real_root);expect((await connection.client.listProjects()).some(x=>x.project_id===project.project_id)).toBe(false);expect(await readFile(join(workspaceRoot,"keep.txt"),"utf8")).toBe("preserve local worktree files");expect(await owner.composition.resolveWorkspace(project.project_id).catch(()=>undefined)).toBeUndefined();}
  finally{await connection.close();await owner.close();await rm(root,{recursive:true,force:true});}
 });

});
