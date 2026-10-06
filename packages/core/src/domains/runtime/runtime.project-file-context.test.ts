import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {DISPOSABLE_FIXTURE_CAPABILITIES,WorkspaceHandleSchema,type RunProjection,type ProjectFileContextSnapshot} from "@tracegraph/contracts";
import {createAgentRuntime,type AgentRuntime} from "./runtime.js";
import {JsonlEventLedger,ArtifactStore} from "../evidence/runtime-service.js";
import {JsonlSessionStore} from "../session/session-store.js";
import {sha256} from "../../kernel/crypto.js";
import type {ModelAdapter,ModelInput} from "../../kernel/types.js";
import {restoreProjectFileContext} from "./project-file-context.js";

const roots:string[]=[],runtimes:AgentRuntime[]=[];
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(runtime=>runtime.shutdownBackgroundWork?.()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const finish=(id:string)=>({decision_id:id,kind:"finish",public_reason:"Selected context was inspected",evidence_refs:[],risk:"none",final_answer:"done"});
const tool=(id:string,name:string,args:Record<string,unknown>)=>({decision_id:`decision:${id}`,kind:"tool_call",public_reason:"Read the admitted context",evidence_refs:[],risk:"low",expected_effect:"Read bounded context",tool_call:{action_id:`action:${id}`,tool_name:name,arguments:args}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"outlive-core-file-context-"));roots.push(root);const directory=join(root,"project");await mkdir(directory);const workspace=WorkspaceHandleSchema.parse({handle_id:"workspace:context",project_id:"project:context",real_root:directory,workspace_kind:"disposable_fixture",capabilities:{...DISPOSABLE_FIXTURE_CAPABILITIES,index:false},created_at:new Date().toISOString()});const content="const marker = 'admitted-context';\n"+"bounded UTF8 数据\n".repeat(500)+"API_KEY=fixture-private-key\n";await writeFile(join(directory,"context.txt"),content);const snapshot:ProjectFileContextSnapshot={project_id:workspace.project_id,path:"context.txt",sha256:sha256(content),byte_length:Buffer.byteLength(content),content};const input={command_id:"start:context",project_id:workspace.project_id,task:"Inspect the selected file",mode:"execute" as const,workspace,file_contexts:[{path:snapshot.path,expected_sha256:snapshot.sha256}]};const dataDir=join(root,"data");const create=async(options:Partial<Parameters<typeof createAgentRuntime>[0]>={})=>{const runtime=await createAgentRuntime({dataDir,...options});runtimes.push(runtime);return runtime;};return {root,directory,workspace,snapshot,input,dataDir,create};}
async function status(runtime:AgentRuntime,id:string,wanted:RunProjection["status"]){for(let step=0;step<1000;step++){const result=await runtime.getProjection(id);if(result.status===wanted)return result;if(result.status==="failed")throw new Error(JSON.stringify({status:result.status,failure:result.failure_code,outcome:result.outcome}));await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Run did not reach ${wanted}`);}

describe("trusted project file context admission and provenance",()=>{
 it("rejects missing, forged, foreign and altered snapshots before creating any Run facts",async()=>{const f=await fixture(),runtime=await f.create();const model:ModelAdapter={name:"reject",decide:async()=>finish("never")};
  await expect(runtime.startRun(f.input)).rejects.toMatchObject({code:"file_context_untrusted"});
  for(const snapshot of [{...f.snapshot,project_id:"project:foreign"},{...f.snapshot,path:"other.txt"},{...f.snapshot,content:f.snapshot.content+"changed",byte_length:f.snapshot.byte_length+7},{...f.snapshot,sha256:sha256("forged")}]){
   await expect(runtime.startRun(f.input,{model,projectFileContexts:[snapshot]})).rejects.toMatchObject({code:"file_context_snapshot_mismatch"});
  }
  await expect(runtime.startRun({...f.input,file_contexts:[]},{model,projectFileContexts:[f.snapshot]})).rejects.toMatchObject({code:"file_context_untrusted"});
  expect(await new JsonlEventLedger(join(f.dataDir,"events")).listRunIds()).toEqual([]);
 });
 it("stores redacted scoped bytes, publishes metadata only and supplies an untrusted locator/manifest to the actual model",async()=>{const f=await fixture(),inputs:ModelInput[]=[];let page="";
  const model:ModelAdapter={name:"file-context-reader",async decide(input){inputs.push(input);if(inputs.length===1){const locator=input.observations.find(item=>item.facts.kind==="project_file_context")?.facts.locator;expect(typeof locator).toBe("string");return tool("context-page","read_artifact",{locator,offset:0,limit:4000});}page=String(input.observations.find(item=>item.facts.tool_name==="read_artifact")?.facts.content_excerpt??"");return finish("decision:context-done");}};
  const runtime=await f.create({model});const started=await runtime.startRun(f.input,{model,projectFileContexts:[f.snapshot]});const completed=await status(runtime,started.run_id,"completed");
  const event=completed.timeline.find(item=>item.type==="artifact.stored"&&item.artifact_refs.some(ref=>ref.kind==="project_file_context"))!;
  expect(event.data).toMatchObject({operation:"host-selected-file",path:"context.txt",source_sha256:f.snapshot.sha256,trust:"untrusted"});
  const ref=event.artifact_refs[0]!;const stored=await runtime.getArtifact({artifactId:ref.artifact_id,runId:started.run_id,projectId:f.workspace.project_id});expect(stored.status).toBe("available");if(stored.status!=="available")throw new Error();
  expect(sha256(stored.content)).toBe(ref.content_hash);expect(ref.content_hash).not.toBe(f.snapshot.sha256);expect(stored.content).not.toContain("fixture-private-key");
  const raw=JSON.stringify(await new JsonlEventLedger(join(f.dataDir,"events")).list(started.run_id));expect(JSON.stringify(event)).not.toContain("admitted-context");expect(raw).not.toContain("fixture-private-key");expect(raw).not.toContain(f.directory);
  const selected=inputs[0]!.observations.find(item=>item.facts.kind==="project_file_context")!;expect(selected.facts).toMatchObject({locator:`artifact:${ref.artifact_id}`,content_sha256:ref.content_hash,trust:"untrusted",truncated:true});expect(String(selected.facts.content_excerpt).length).toBeLessThanOrEqual(2000);
  expect(inputs[0]!.contextManifest.items).toContainEqual(expect.objectContaining({source:expect.objectContaining({source_type:"tool",trust:"untrusted",artifact_ref:ref})}));
  expect(inputs[0]!.context).toContain("untrusted");expect(page).toContain("admitted-context");expect(completed.timeline.filter(item=>item.type==="context.spill_refetched")).toEqual([]);
  expect(await runtime.getArtifact({artifactId:ref.artifact_id,runId:started.run_id,projectId:"project:foreign"})).toMatchObject({status:"unavailable",reason:"out_of_scope"});
 });
 it("serializes Artifact pages, corrects UTF-8 cursor drift, and recovers a far cursor from successful receipts",async()=>{
  const f=await fixture(),inputs:ModelInput[]=[];let stage=0;
  const model:ModelAdapter={name:"artifact-cursor-recovery",async decide(input){
   inputs.push(input);
   const context=input.observations.find(item=>item.facts.kind==="project_file_context");
   const locator=String(context?.facts.locator??"");
   const readPages=input.observations.filter(item=>item.facts.tool_name==="read_artifact"&&item.status==="success");
   const last=readPages.at(-1);
   const cursor=last?.facts.truncated===true?Number(last.facts.next_offset):Number(last?.facts.total_bytes??0);
   if(stage===0){
    stage=1;
    return {decision_id:"decision:cursor-pages",kind:"tool_call",public_reason:"Read the selected context in ordered pages",risk:"low",expected_effect:"Read bounded Artifact pages",tool_calls:[
     {action_id:"action:cursor-page-1",tool_name:"read_artifact",arguments:{locator,offset:0,limit:4000}},
     // This deliberately assumes a full 4000-byte first page. Chinese and
     // emoji at its boundary require the Ledger's actual next_offset instead.
     {action_id:"action:cursor-page-2",tool_name:"read_artifact",arguments:{locator,offset:4000,limit:4000}},
    ]};
   }
   if(stage===1){stage=2;return tool("cursor-far-jump","read_artifact",{locator,offset:cursor+128,limit:4000});}
   if(stage===2){
    stage=3;
    const mismatch=input.observations.find(item=>item.facts.code==="artifact_cursor_mismatch");
    expect(mismatch?.facts).toMatchObject({recoverable:true,expected_offset:cursor});
    return tool("cursor-resume","read_artifact",{locator,offset:Number(mismatch!.facts.expected_offset),limit:4000});
   }
   if(last?.facts.truncated===true)return tool(`cursor-page-${stage}`,"read_artifact",{locator,offset:cursor,limit:4000});
   return finish(`decision:cursor-finished:${inputs.length}`);
  }};
  const runtime=await f.create({model});
  const started=await runtime.startRun(f.input,{model,projectFileContexts:[f.snapshot]});
  const completed=await status(runtime,started.run_id,"completed");
  const ledger=await new JsonlEventLedger(join(f.dataDir,"events")).list(started.run_id);
  const reads=ledger.filter(event=>event.type==="tool.completed"&&(event.data.receipt as {tool_name?:unknown}|undefined)?.tool_name==="read_artifact").map(event=>(event.data.observation as {facts:Record<string,unknown>}).facts);
  expect(reads.length).toBeGreaterThan(2);
  expect(reads[1]).toMatchObject({offset:reads[0]!.next_offset});
  for(let index=1;index<reads.length;index++)expect(reads[index]!.offset).toBe(reads[index-1]!.next_offset);
  const mismatch=ledger.find(event=>event.type==="tool.failed"&&(event.data.observation as {facts:Record<string,unknown>}|undefined)?.facts.code==="artifact_cursor_mismatch");
  expect(mismatch?.data).toMatchObject({business_code:"artifact_cursor_mismatch"});
  expect(ledger.some(event=>event.type==="workbench.command_completed"&&event.data.operation==="artifact.read_cursor_recovery")).toBe(true);
  expect(completed.status).toBe("completed");
 });
 it("restores a pending plan from immutable redacted artifacts after the original file changes, without automatic dispatch",async()=>{const f=await fixture(),inputs:ModelInput[]=[];let plans=0;const model:ModelAdapter={name:"context-plan",async decide(input){inputs.push(input);if(input.mode==="plan"&&plans++===0)return tool("context-plan-todo","todo_write",{operation:"create",todo_id:"todo:context",title:"Inspect the selected context"});return {...finish(`decision:context:${inputs.length}`),...(input.mode==="plan"?{finish_intent:"submit_plan"}:{})};}};
  const sessions=join(f.root,"sessions");const first=await f.create({model,sessionStore:new JsonlSessionStore(sessions,{pid:2147483646})});const created=await first.startRun({...f.input,mode:"plan"},{model,projectFileContexts:[f.snapshot]});const waiting=await status(first,created.run_id,"awaiting_plan_approval");
  await writeFile(join(f.directory,"context.txt"),"external changed workspace; never reread\n");
  const recovered=await f.create({model,sessionStore:new JsonlSessionStore(sessions)});const locator={sessionId:waiting.session_id!,runId:waiting.run_id,projectId:waiting.project_id};const count=inputs.length;
  await recovered.markRunInterrupted(locator);expect(inputs.length).toBe(count);
  const resumed=await recovered.resumeRun({...locator,commandId:"resume:context",workspace:f.workspace});expect(resumed.status).toBe("awaiting_plan_approval");expect(inputs.length).toBe(count);
  await recovered.approvePlan({type:"approve_plan",command_id:"approve:context",project_id:resumed.project_id,run_id:resumed.run_id,plan_event_id:resumed.pending_plan!.plan_event_id});await status(recovered,resumed.run_id,"completed");
  const observation=inputs.at(-1)!.observations.find(item=>item.facts.kind==="project_file_context")!;expect(observation.facts.source_sha256).toBe(f.snapshot.sha256);expect(observation.facts.content_excerpt).toContain("admitted-context");expect(JSON.stringify(inputs.at(-1))).not.toContain("external changed workspace");
 }, 15_000);
 it("fails closed on missing/corrupt persisted context instead of rereading workspace contents",async()=>{const f=await fixture(),model:ModelAdapter={name:"finish",decide:async()=>finish("decision:context")};const runtime=await f.create({model});const started=await runtime.startRun(f.input,{model,projectFileContexts:[f.snapshot]});const completed=await status(runtime,started.run_id,"completed");const event=(await new JsonlEventLedger(join(f.dataDir,"events")).list(completed.run_id)).find(item=>item.type==="artifact.stored"&&item.artifact_refs.some(ref=>ref.kind==="project_file_context"))!;
  const artifacts=new ArtifactStore(join(f.dataDir,"artifacts"));const ref=event.artifact_refs[0]!;const files=await import("node:fs/promises").then(fs=>fs.readdir(join(f.dataDir,"artifacts")));
  // ArtifactStore uses a hash-derived filename; locate its exact content through its private scoped metadata.
  const candidate=await Promise.all(files.filter(file=>!file.endsWith(".json")).map(async file=>({file,content:await readFile(join(f.dataDir,"artifacts",file),"utf8")})));const target=candidate.find(item=>sha256(item.content)===ref.content_hash);expect(target).toBeDefined();await writeFile(join(f.dataDir,"artifacts",target!.file),"tampered");
  await expect(restoreProjectFileContext(event,artifacts)).rejects.toMatchObject({code:"file_context_recovery_unavailable"});
 });
});
