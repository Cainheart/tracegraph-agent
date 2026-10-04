import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
import {MAX_PROJECT_CONTEXT_FILE_BYTES,type StartRunRequest} from "@tracegraph/contracts";
import {JsonlEventLedger,type ModelAdapter,type ModelInput} from "@tracegraph/core";
import {createHostComposition} from "./composition/host-composition.js";
import {createWorkbenchControl} from "./workbench-control.js";

const hash=(value:string|Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}` as const;
const origin="http://127.0.0.1:4310";
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"outlive-host-context-")),directory=join(root,"project");await mkdir(directory);
 const content="const admittedMarker = 'host-selected-version';\n";await writeFile(join(directory,"context.txt"),content);
 const inputs:ModelInput[]=[];let released=0;const model:ModelAdapter={name:"context-host-fixture",releaseRun(){released++;},async decide(input){inputs.push(input);return {decision_id:`decision:context:${inputs.length}`,kind:"finish",public_reason:"Read the selected file context",risk:"none",evidence_refs:[],final_answer:"Selected file observed"};}};
 const composition=await createHostComposition({profileRoot:root,dataDir:join(root,"data"),sessionDir:join(root,"sessions"),permissionConfigPath:join(root,"permission.json"),args:["--permission-ceiling","full-write"],environment:{},useEnvironmentModel:false,nativePicker:false,runtimeModel:model,admission:"workspace"});
 const project=await composition.registerProject(directory,"read_write");project.workspace.capabilities.index=false;
 const bootstrap=await composition.host.app.inject({method:"GET",url:"/api/bootstrap",headers:{origin}});expect(bootstrap.statusCode).toBe(200);const token=bootstrap.json().token as string;
 const post=(url:string,input:Record<string,unknown>)=>composition.host.app.inject({method:"POST",url,headers:{origin,authorization:`Bearer ${token}`,"x-tracegraph-command-id":String(input.command_id)},payload:input});
 const request:StartRunRequest={command_id:"context:run",project_id:project.workspace.project_id,task:"Inspect the selected project file",mode:"execute",file_contexts:[{path:"context.txt",expected_sha256:hash(content)}]};
 const policy=await composition.permissionConfig.resolveProject(directory,"workspace-write");
 return {root,directory,content,project,composition,inputs,post,request,policy,get released(){return released;},async close(){try{await composition.close();}finally{await rm(root,{recursive:true,force:true});}}};
}
async function completed(f:Awaited<ReturnType<typeof fixture>>,runId:string){for(let i=0;i<1000;i++){const projection=await f.composition.runtime.getProjection(runId);if(["completed","failed","cancelled"].includes(projection.status))return projection;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Context fixture did not settle");}

describe("Host admission freezes bounded authorized project file context",()=>{
 it("advertises files.context only for a composition with its actual trusted reader",async()=>{const f=await fixture();try{
  const {fileContextAvailable,...generic}=f.composition;expect(fileContextAvailable).toBe(true);
  const shared={profileRoot:f.root,profileId:"profile:context-capability",startRun:(input:StartRunRequest)=>f.composition.host.runSessions.startRun(input),readSession:(id:string)=>f.composition.host.runSessions.getSession(id)};
  let control=await createWorkbenchControl({...generic,...shared});try{expect((await control.capabilities()).capabilities.find(item=>item.operation==="files.context")?.state).toBe("unavailable");}finally{await control.close();}
  control=await createWorkbenchControl({...f.composition,...shared});try{expect((await control.capabilities()).capabilities.find(item=>item.operation==="files.context")?.state).toBe("available");}finally{await control.close();}
 }finally{await f.close();}});
 it("runs the public typed request with real captured bytes, metadata provenance and a shared file reader",async()=>{const f=await fixture();try{
  const response=await f.post("/api/runs",f.request);expect(response.statusCode).toBe(200);const result=await completed(f,response.json().run_id);expect(result.status).toBe("completed");expect(f.inputs).toHaveLength(1);
  const observation=f.inputs[0]!.observations.find(item=>item.facts.kind==="project_file_context")!;expect(observation.facts).toMatchObject({path:"context.txt",source_sha256:hash(f.content),content_excerpt:f.content,trust:"untrusted"});
  const event=result.timeline.find(item=>item.type==="artifact.stored"&&item.artifact_refs.some(ref=>ref.kind==="project_file_context"))!;expect(observation.facts.source_event_id).toBe(event.event_id);expect(f.inputs[0]!.contextManifest.items).toContainEqual(expect.objectContaining({source:expect.objectContaining({source_id:event.event_id,source_type:"tool",trust:"untrusted",artifact_ref:event.artifact_refs[0]})}));
  expect(JSON.stringify(event)).not.toContain("host-selected-version");expect((await f.composition.projectFiles.read(f.project.workspace.project_id,{path:"context.txt"})).sha256).toBe(hash(f.content));
  expect((await f.post("/api/chat/runs",{command_id:"chat:illegal-context",task:"Plain chat",file_contexts:f.request.file_contexts})).statusCode).toBe(400);
 }finally{await f.close();}});
 it("rejects stale file selection before Run creation or provider dispatch",async()=>{const f=await fixture();try{
  await writeFile(join(f.directory,"context.txt"),"changed externally\n");const response=await f.post("/api/runs",f.request);expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:"file_context_revision_conflict"});expect(f.inputs).toEqual([]);expect(f.released).toBe(1);expect(await new JsonlEventLedger(join(f.root,"data","events")).listRunIds()).toEqual([]);
 }finally{await f.close();}});
 it("freezes the admitted file version and permission despite later edits, while new admission rechecks policy",async()=>{const f=await fixture();try{
  const dispatch=await f.composition.conversationControl.prepare(f.request,f.project.workspace);await writeFile(join(f.directory,"context.txt"),"new unselected contents\n");await mkdir(join(f.directory,".tracegraph"));await writeFile(join(f.directory,".tracegraph","policy.json"),JSON.stringify({policy_version:1,rules:[{rule_id:"deny-context",priority:1,when:{path_glob:"context.txt"},then:"deny",explanation:"Fixture changed after admission"}]}));
  const started=await dispatch.start({...f.request,workspace:f.project.workspace});expect((await completed(f,started.run_id)).status).toBe("completed");expect(f.inputs[0]!.observations.find(item=>item.facts.kind==="project_file_context")?.facts.content_excerpt).toBe(f.content);
  await expect(f.composition.conversationControl.prepare({...f.request,command_id:"context:denied"},f.project.workspace)).rejects.toMatchObject({code:"file_read_policy_denied"});
 }finally{await f.close();}});
 it("bounds the descriptor read at 64 KiB, keeps BOM bytes, and rejects binary/invalid UTF-8",async()=>{const f=await fixture();try{
  await writeFile(join(f.directory,"bom.txt"),"\ufeffUTF8 数据\r\n");const bom=await f.composition.projectFiles.readContext(f.request.project_id,"bom.txt",f.policy);expect(bom.content).toBe("\ufeffUTF8 数据\r\n");expect(bom.byte_length).toBe(Buffer.byteLength(bom.content));expect(bom.sha256).toBe(hash(bom.content));
  await writeFile(join(f.directory,"limit.txt"),Buffer.alloc(MAX_PROJECT_CONTEXT_FILE_BYTES,97));expect((await f.composition.projectFiles.readContext(f.request.project_id,"limit.txt",f.policy)).byte_length).toBe(MAX_PROJECT_CONTEXT_FILE_BYTES);
  await writeFile(join(f.directory,"large.txt"),Buffer.alloc(MAX_PROJECT_CONTEXT_FILE_BYTES+1,97));await expect(f.composition.projectFiles.readContext(f.request.project_id,"large.txt",f.policy)).rejects.toMatchObject({code:"file_too_large",statusCode:413});
  for(const [name,bytes] of [["nul.txt",Buffer.from([97,0,98])],["invalid.txt",Buffer.from([0xff,0xfe])]] as const){await writeFile(join(f.directory,name),bytes);await expect(f.composition.projectFiles.readContext(f.request.project_id,name,f.policy)).rejects.toMatchObject({code:"file_context_not_text"});}
 }finally{await f.close();}});
 it("excludes traversal, secrets, symlinks, multi-link files and unregistered projects",async()=>{const f=await fixture();try{
  await writeFile(join(f.root,"outside.txt"),"outside");await symlink(join(f.root,"outside.txt"),join(f.directory,"escape.txt"));await link(join(f.directory,"context.txt"),join(f.directory,"hard.txt"));await writeFile(join(f.directory,".env"),"synthetic private fixture");
  for(const path of ["../outside.txt","/tmp/outside.txt",".env","escape.txt","hard.txt"]){await expect(f.composition.projectFiles.readContext(f.request.project_id,path,f.policy)).rejects.toBeDefined();}
  await expect(f.composition.projectFiles.readContext("project:foreign","context.txt",f.policy)).rejects.toBeDefined();expect(await readFile(join(f.root,"outside.txt"),"utf8")).toBe("outside");
 }finally{await f.close();}});
 it("fails closed on policy ask/deny without opening an approval prompt",async()=>{const f=await fixture();try{
  await mkdir(join(f.directory,".tracegraph"));for(const then of ["ask","deny"]){await writeFile(join(f.directory,".tracegraph","policy.json"),JSON.stringify({policy_version:1,rules:[{rule_id:"context-read-policy",priority:1,when:{path_glob:"context.txt"},then,explanation:"Fixture requires explicit allowed read"}]}));const response=await f.post("/api/runs",{...f.request,command_id:`context:${then}`});expect(response.statusCode).toBe(403);expect(response.json().error).toBe(then==="ask"?"file_read_approval_required":"file_read_policy_denied");}
  expect(f.inputs).toEqual([]);expect(await new JsonlEventLedger(join(f.root,"data","events")).listRunIds()).toEqual([]);
 }finally{await f.close();}});
 it("rejects total context over 128 KiB and a session from another project",async()=>{const f=await fixture();try{
  const refs=[];for(let index=0;index<3;index++){const path=`large-${index}.txt`,bytes=Buffer.alloc(MAX_PROJECT_CONTEXT_FILE_BYTES,97+index);await writeFile(join(f.directory,path),bytes);refs.push({path,expected_sha256:hash(bytes)});}const response=await f.post("/api/runs",{...f.request,file_contexts:refs});expect(response.statusCode).toBe(413);expect(response.json().error).toBe("file_context_limit");expect(f.inputs).toEqual([]);
  const chat=await f.post("/api/chat/runs",{command_id:"chat:foreign-session",task:"Create a plain conversation"});expect(chat.statusCode).toBe(200);await completed(f,chat.json().run_id);
  await expect(f.composition.conversationControl.prepare({...f.request,session_id:chat.json().session_id},f.project.workspace)).rejects.toMatchObject({code:"session_project_mismatch"});
 }finally{await f.close();}});
});
