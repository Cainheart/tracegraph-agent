import {createServer} from "node:http";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect} from "vitest";
import {PrivateFileCredentialStore} from "@tracegraph/core";
import {createHostComposition} from "./composition/host-composition.js";
import {PermissionConfigController} from "./composition/permission-config.js";

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"outlive-model-menu-"));
 const calls:Array<{model:string;key:string}>=[];
 const server=createServer(async(req,res)=>{let body="";for await(const bytes of req)body+=bytes;const input=JSON.parse(body);calls.push({model:input.model,key:String(req.headers.authorization)});res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({decision_id:"fixture-finish",kind:"finish",public_reason:"Done",evidence_refs:[],risk:"none",final_answer:`Result from ${input.model}`})}}]}));});
 await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address() as {port:number};
 const options={profileRoot:root,dataDir:join(root,"data"),sessionDir:join(root,"sessions"),permissionConfigPath:join(root,"permission.json"),credentialStore:new PrivateFileCredentialStore(join(root,"credentials.json")),environment:{},useEnvironmentModel:false,nativePicker:false,admission:"workspace" as const};
 const host=await createHostComposition(options);
 return {root,host,options,calls,url:`http://127.0.0.1:${address.port}/v1`,async close(){await host.close();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});}};
}
const save=(url:string,id:string,model:string,key:string,revision?:number)=>({command_id:`save-${id}-${revision??"new"}`,connection_id:id,label:id,provider:"custom" as const,protocol:"openai-chat-completions" as const,base_url:url,model,models:[model],api_key:key,...(revision===undefined?{}:{expected_revision:revision})});
async function completed(host:Awaited<ReturnType<typeof fixture>>["host"],id:string){for(let count=0;count<200;count++){const p=await host.runtime.getProjection(id);if(["completed","failed","cancelled"].includes(p.status))return p;await new Promise(done=>setTimeout(done,10));}throw new Error("Fixture task did not finish");}

describe("saved model connections and per-conversation dispatch",()=>{
 it("uses different actual models in simultaneous conversations and persists each choice without keys",async()=>{
  const f=await fixture();try{
   await f.host.conversationControl.save(save(f.url,"service-a","model-a","fixture-key-a"));
   expect(JSON.parse(await readFile(join(f.root,"data","model-config.json"),"utf8")).model).toBe("model-a");
   await f.host.conversationControl.save(save(f.url,"service-b","model-b","fixture-key-b"));
   const [a,b]=await Promise.all([f.host.host.runSessions.startChat({command_id:"chat-a",task:"hello",run_options:{connection_id:"service-a",model:"model-a",mode:"execute",reasoning_effort:"default",permission_preset:"workspace-write"}}),f.host.host.runSessions.startChat({command_id:"chat-b",task:"hello",run_options:{connection_id:"service-b",model:"model-b",mode:"execute",reasoning_effort:"default",permission_preset:"workspace-write"}})]);
   const [pa,pb]=await Promise.all([completed(f.host,a.run_id),completed(f.host,b.run_id)]);expect(pa.status).toBe("completed");expect(pb.status).toBe("completed");
   expect(f.calls).toEqual(expect.arrayContaining([{model:"model-a",key:"Bearer fixture-key-a"},{model:"model-b",key:"Bearer fixture-key-b"}]));
   expect((await f.host.conversationControl.options(a.session_id!)).options.connection_id).toBe("service-a");expect((await f.host.conversationControl.options(b.session_id!)).options.connection_id).toBe("service-b");
   expect(pa.timeline.find(e=>e.type==="run.created")?.data.model_binding).toMatchObject({connection_id:"service-a",model:"model-a"});
   expect(JSON.stringify(f.host.conversationControl.snapshot())).not.toContain("fixture-key");expect(await readFile(join(f.root,"model-connections","service-a.json"),"utf8")).not.toContain("fixture-key");
   await f.host.close();const restarted=await createHostComposition(f.options);try{expect(restarted.conversationControl.snapshot().connections.map(c=>c.connection_id)).toContain("service-b");expect((await restarted.conversationControl.options(a.session_id!)).options.connection_id).toBe("service-a");}finally{await restarted.close();}
  }finally{await f.close();}
 },20_000);
 it("freezes a credential at admission across replacement/removal and keeps plan mode in plain chat",async()=>{
  const f=await fixture();try{
   await f.host.conversationControl.save(save(f.url,"service-a","old-model","fixture-old-key"));
   const workspace=(await f.host.resolveWorkspace("chat:local"));
   const prepared=await f.host.conversationControl.prepare({command_id:"frozen-run",project_id:workspace.project_id,task:"hello",mode:"execute",run_options:{connection_id:"service-a",mode:"execute",reasoning_effort:"default",permission_preset:"workspace-write"}},workspace);
   await f.host.conversationControl.save(save(f.url,"service-a","new-model","fixture-new-key",0));
   await f.host.conversationControl.remove("service-a",{command_id:"remove-service",expected_revision:1});
   const started=await prepared.start({command_id:"frozen-run",project_id:workspace.project_id,task:"hello",mode:"execute",workspace});
   const result=await completed(f.host,started.run_id);expect(result.status).toBe("completed");expect(f.calls[0]).toEqual({model:"old-model",key:"Bearer fixture-old-key"});
   await f.host.conversationControl.save(save(f.url,"service-b","plan-model","fixture-plan-key"));
   const planned=await f.host.host.runSessions.startChat({command_id:"plain-plan",task:"plan a task",mode:"plan",run_options:{connection_id:"service-b",mode:"plan",reasoning_effort:"default",permission_preset:"workspace-write"}});expect(planned.timeline.find(e=>e.type==="run.created")?.data.mode).toBe("plan");
   await expect(f.host.conversationControl.prepare({command_id:"invalid-full",project_id:workspace.project_id,task:"hello",mode:"execute",run_options:{connection_id:"service-b",mode:"execute",reasoning_effort:"default",permission_preset:"full-write"}},workspace)).rejects.toMatchObject({code:"permission_ceiling"});
  }finally{await f.close();}
 },20_000);
 it("clears a saved key without invalidating an admitted task, then blocks new tasks",async()=>{
  const f=await fixture();try{
   await f.host.conversationControl.save(save(f.url,"service-a","model-a","fixture-before-clear"));
   const workspace=await f.host.resolveWorkspace("chat:local");
   const input={command_id:"before-clear",project_id:workspace.project_id,task:"hello",mode:"execute" as const};
   const admitted=await f.host.conversationControl.prepare(input,workspace);
   await f.host.conversationControl.save({...save(f.url,"service-a","model-a","unused",0),api_key:undefined,clear_key:true,command_id:"clear-service"});
   expect(f.host.conversationControl.snapshot().connections[0]).toMatchObject({connection_id:"service-a",has_key:false,revision:1});
   await expect(f.host.conversationControl.prepare({...input,command_id:"after-clear"},workspace)).rejects.toMatchObject({code:"credential_required"});
   const started=await admitted.start({...input,workspace});expect((await completed(f.host,started.run_id)).status).toBe("completed");expect(f.calls[0]?.key).toBe("Bearer fixture-before-clear");
   await f.host.close();const restarted=await createHostComposition(f.options);try{expect(restarted.conversationControl.snapshot().connections[0]?.has_key).toBe(false);}finally{await restarted.close();}
  }finally{await f.close();}
 });
 it("returns real model test outcomes and rejects stale edits",async()=>{
  const f=await fixture();try{await f.host.conversationControl.save(save(f.url,"service-a","model-a","fixture-test-key"));expect((await f.host.conversationControl.test("service-a","test-a")).status).toBe("passed");await expect(f.host.conversationControl.save(save(f.url,"service-a","model-b","fixture-key-b",99))).rejects.toMatchObject({code:"model_revision_conflict"});expect(f.calls[0]?.model).toBe("model-a");}finally{await f.close();}
 });
});
describe("local full access eligibility",()=>{
 it("keeps workspace default, applies consent on a new owner, and obeys administrator ceilings",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-full-consent-"));const path=join(root,"config","harness-config.json");try{
   const current=await PermissionConfigController.open({userConfigPath:path,environment:{}});expect((await current.setLocalFullGrant(true)).pending_restart).toBe(true);expect(current.snapshot().ceiling_preset_key).toBe("workspace-write");
   const replacement=await PermissionConfigController.open({userConfigPath:path,environment:{}});expect(replacement.snapshot()).toMatchObject({ceiling_preset_key:"full-write",ceiling_source:"user-consent",selected_preset_key:"workspace-write"});expect((await replacement.localGrant()).pending_restart).toBe(false);
   await replacement.setLocalFullGrant(false);const revoked=await PermissionConfigController.open({userConfigPath:path,environment:{}});expect(revoked.snapshot().ceiling_preset_key).toBe("workspace-write");
   const admin=await PermissionConfigController.open({userConfigPath:path,environment:{TRACEGRAPH_PERMISSION_PRESET:"read-only"}});await expect(admin.setLocalFullGrant(true)).rejects.toMatchObject({code:"permission_admin_ceiling"});
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
