import {createServer, type ServerResponse} from "node:http";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";
import {SharedRunBudget,type CredentialStore,type RunProjection} from "@tracegraph/core";
import {WorkbenchSettingsValuesSchema} from "@tracegraph/contracts";
import {createHostComposition} from "./composition/host-composition.js";

const finish=(id:string)=>({decision_id:id,kind:"finish",public_reason:"The controlled task is complete",risk:"none",evidence_refs:[],final_answer:"Controlled task complete"});
const spawn=(id:string)=>({action_id:`spawn:${id}`,tool_name:"spawn_subagent",arguments:{profile_name:"readonly",context_scope:"isolated",task_packet:{task:`Lease child ${id}`}}});
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function until(predicate:()=>boolean|Promise<boolean>){const end=Date.now()+8_000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Controlled lease oracle did not settle");}
function respond(res:ServerResponse,decision:unknown){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(decision)}}],usage:{prompt_tokens:500,completion_tokens:5,total_tokens:505}}));}

describe("Actual parent/child model snapshot credential lifetime",()=>{
 it("keeps independent immutable leases through two real children and rotation until the parent also settles",async()=>{
  const childA=gate(),childB=gate(),parent=gate();
  const secrets=new Map<string,string>(),deleted:string[]=[],setNames:string[]=[];
  const oldKey="local-lease-fixture-old-key",newKey="local-lease-fixture-new-key";
  const store:CredentialStore={get:async name=>secrets.get(name)??null,set:async(name,value)=>{secrets.set(name,value);setNames.push(name);},delete:async name=>{deleted.push(name);secrets.delete(name);},list:async()=>[...secrets.keys()].map(name=>({name,backend:"private_file" as const,writable:true}))};
  let parentCalls=0;const childCalls=new Map<string,number>(),wire:Array<{oldCredential:boolean;model:string;child:string|null}>=[],providerErrors:string[]=[];
  const server=createServer(async(req,res)=>{try{
   let raw="";for await(const chunk of req)raw+=chunk;
   const input=JSON.parse(raw) as {model:string;messages:Array<{content:string}>};
   const isChild=input.messages[0]!.content.includes("Trusted delegated role (frozen by the Host)");
   const id=isChild?/Lease child ([AB])/.exec(JSON.parse(input.messages[1]!.content).context)?.[1]??null:null;
   wire.push({oldCredential:req.headers.authorization===`Bearer ${oldKey}`,model:input.model,child:id});
   if(isChild&&!id)throw new Error("The actual controlled child task was not present");
   if(id){const count=(childCalls.get(id)??0)+1;childCalls.set(id,count);if(count===1)await(id==="A"?childA.promise:childB.promise);
    respond(res,id==="B"&&count===1?{decision_id:"child:B:read",kind:"tool_call",public_reason:"Read the authorized fixture",risk:"low",evidence_refs:[],tool_call:{action_id:"child:B:read",tool_name:"read_file",arguments:{path:"value.txt"}}}:finish(`child:${id}:done`));
   }else{parentCalls++;if(parentCalls===1)respond(res,{decision_id:"parent:spawn",kind:"tool_call",public_reason:"Delegate two controlled children",risk:"low",evidence_refs:[],tool_calls:[spawn("A"),spawn("B")]});else{await parent.promise;respond(res,finish("parent:done"));}}
  }catch(error){providerErrors.push(error instanceof Error?error.message:"Controlled provider error");res.writeHead(500);res.end("Controlled provider error");}});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("Controlled provider failed to bind");
  const root=await mkdtemp(join(tmpdir(),"outlive-team-model-leases-")),source=join(root,"source");await mkdir(source);await writeFile(join(source,"value.txt"),"Authorized fixture\n");
  const composition=await createHostComposition({profileRoot:root,dataDir:join(root,"data"),sessionDir:join(root,"sessions"),credentialStore:store,permissionConfigPath:join(root,"permission.json"),environment:{TRACEGRAPH_PERMISSION_PRESET:"full-write"},useEnvironmentModel:false,nativePicker:false,nativePermissionPrompts:false,admission:"workspace",settings:WorkbenchSettingsValuesSchema.parse({memory:{memory_recall:false,experience_recall:false}})});
  const budget=new SharedRunBudget({identity:"goal:immutable-child-lease",limits:{max_tokens:200_000,max_time_ms:15_000},checkpoint:async()=>undefined});
  try{
   const project=await composition.registerProject(source,"read_write");project.workspace.capabilities.index=false;
   const base={label:"Controlled local provider",provider:"custom" as const,protocol:"openai-chat-completions" as const,base_url:`http://127.0.0.1:${address.port}/v1`,model:"admitted-old-model"};
   const saved=await composition.conversationControl.save({...base,command_id:"models:lease-old",api_key:oldKey});const connection=saved.connections[0]!,oldName=setNames[0]!;
   const input={command_id:"run:lease-tree",project_id:project.workspace.project_id,task:"Delegate two credential lifetime checks",mode:"execute" as const,run_options:{connection_id:connection.connection_id,model:base.model,permission_preset:"full-write" as const}};
   const admission=await composition.conversationControl.prepare(input,project.workspace,{requestBudget:budget,backgroundModelDerivation:false});const started=await admission.start({...input,workspace:project.workspace});
   await until(()=>childCalls.get("A")===1&&childCalls.get("B")===1);
   await composition.conversationControl.save({...base,command_id:"models:lease-rotate",connection_id:connection.connection_id,expected_revision:connection.revision,model:"saved-new-model",api_key:newKey});
   expect(deleted).not.toContain(oldName);
   childA.release();let projection:RunProjection|undefined;const childStates:Array<{task:string;status:string}>=[];
   await until(async()=>{projection=await composition.runtime.getProjection(started.run_id);for(const item of projection.subagents.items){const child=await composition.runtime.getProjection(item.link.child_run_id);childStates.push({task:child.task,status:child.status});if(child.task.includes("Lease child A")&&["completed","failed","cancelled"].includes(child.status)){expect(child.status).toBe("completed");return true;}}return false;}).catch(error=>{throw new Error((error instanceof Error?error.message:"Lease oracle failed")+JSON.stringify({rootStatus:projection?.status,childStates:childStates.slice(-4),wire,providerErrors,deletedCount:deleted.length}));});
   // The first child terminal must not release the credential still held by the sibling and parent.
   expect(secrets.has(oldName)).toBe(true);expect(deleted).not.toContain(oldName);
   childB.release();await until(async()=>{const rootProjection=await composition.runtime.getProjection(started.run_id);if(["failed","cancelled"].includes(rootProjection.status))throw new Error("Parent lost admitted model credential: "+JSON.stringify({status:rootProjection.status,failure:rootProjection.failure_code,wire,deletedCount:deleted.length}));for(const item of rootProjection.subagents.items){const child=await composition.runtime.getProjection(item.link.child_run_id);if(child.task.includes("Lease child B")&&child.status==="failed")throw new Error("Sibling lost admitted model credential: "+JSON.stringify({failure:child.failure_code,wire,deletedCount:deleted.length}));}return parentCalls===2;});
   expect(childCalls.get("B")).toBe(2);expect(secrets.has(oldName)).toBe(true);expect(deleted).not.toContain(oldName);
   expect(wire).toHaveLength(5);expect(wire.every(request=>request.oldCredential&&request.model===base.model)).toBe(true);expect(providerErrors).toEqual([]);
   parent.release();await until(async()=>(await composition.runtime.getProjection(started.run_id)).status==="completed");await until(()=>!secrets.has(oldName));
   expect(deleted.filter(name=>name===oldName)).toHaveLength(1);expect(secrets.has(setNames[1]!)).toBe(true);
   const result=await composition.runtime.getProjection(started.run_id);expect(result.subagents.items).toHaveLength(2);for(const item of result.subagents.items)expect((await composition.runtime.getProjection(item.link.child_run_id)).status).toBe("completed");
  }finally{childA.release();childB.release();parent.release();await composition.close();budget.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
 },15_000);
});
