import {createServer} from "node:http";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {describe,it,expect} from "vitest";
import {PrivateFileCredentialStore} from "@tracegraph/core";
import {WorkbenchSettingsValuesSchema} from "@tracegraph/contracts";
import {createHostComposition} from "./composition/host-composition.js";
import {createWorkbenchControl} from "./workbench-control.js";
import {registerWorkbenchRoutes} from "./workbench-routes.js";

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"outlive-cfg098-"));
 const calls:Array<{model:string;key:string;effort?:string}>=[];
 const server=createServer(async(req,res)=>{let body="";for await(const chunk of req)body+=chunk;const input=JSON.parse(body);calls.push({model:input.model,key:String(req.headers.authorization),...(input.reasoning_effort?{effort:input.reasoning_effort}:{})});res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({decision_id:"done",kind:"finish",public_reason:"Done",evidence_refs:[],risk:"none",final_answer:"Done"})}}]}));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const options={profileRoot:root,dataDir:join(root,"data"),sessionDir:join(root,"sessions"),permissionConfigPath:join(root,"permission.json"),credentialStore:new PrivateFileCredentialStore(join(root,"credentials.json")),environment:{TRACEGRAPH_PERMISSION_PRESET:"full-write"},useEnvironmentModel:false,nativePicker:false,admission:"workspace" as const,settings:WorkbenchSettingsValuesSchema.parse({model:{reasoning_effort:"high"},memory:{memory_recall:false,experience_recall:false}})};
 const composition=await createHostComposition(options);
 const context={...composition,profileRoot:root,profileId:"profile:fixture",startRun:input=>composition.host.runSessions.startRun(input),readSession:id=>composition.host.runSessions.getSession(id),onSettingsChanged:async settings=>composition.updateRunSettings(settings)} satisfies Parameters<typeof createWorkbenchControl>[0];
 const control=await createWorkbenchControl(context);
 registerWorkbenchRoutes(composition.host.app,control);
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
 const save=(model:string,key:string,revision?:number)=>composition.conversationControl.save({command_id:`model-${model}`,connection_id:"service",label:"Service",provider:"custom",protocol:"openai-chat-completions",base_url:url,model,models:[model],api_key:key,...(revision===undefined?{}:{expected_revision:revision})});
 await save("old-model","fixture-original-key");
 return {root,options,composition,context,control,calls,save,async close(){await control.close();await composition.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}};
}
async function finish(f:Awaited<ReturnType<typeof fixture>>,id:string){for(let index=0;index<200;index++){const run=await f.composition.runtime.getProjection(id);if(["completed","failed","cancelled"].includes(run.status))return run;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("Run did not finish");}

describe("CFG-098 real configuration ownership",()=>{
 it("inherits global permission/reasoning, project defaults and explicit session/request values without synthesized defaults",async()=>{
  const f=await fixture();try{
   const defaults=await f.composition.conversationControl.projectDefaults("chat:local");expect(defaults.options).toMatchObject({reasoning_effort:"high",permission_preset:"full-write"});
   await f.composition.conversationControl.updateProjectDefaults("chat:local",{command_id:"project-low",expected_revision:0,overrides:{reasoning_effort:"low",permission_preset:"read-only"}});
   const run=await f.composition.host.runSessions.startChat({command_id:"inherited-chat",task:"hello",run_options:{connection_id:"service"}});await finish(f,run.run_id);
   const initial=await f.composition.conversationControl.options(run.session_id!);expect(initial.options).toMatchObject({reasoning_effort:"low",permission_preset:"read-only"});expect(initial.overrides).toEqual({connection_id:"service",mode:"execute"});expect(initial.fields?.find(field=>field.path==="reasoning_effort")?.source).toBe("project");
   await f.composition.conversationControl.updateProjectDefaults("chat:local",{command_id:"project-medium",expected_revision:1,overrides:{reasoning_effort:"medium"}});
   expect((await f.composition.conversationControl.options(run.session_id!)).options).toMatchObject({reasoning_effort:"medium",permission_preset:"full-write"});
   const explicit=await f.composition.conversationControl.updateOptions(run.session_id!,{command_id:"session-high",expected_revision:0,options:{...initial.options,reasoning_effort:"high"}});expect(explicit.fields?.find(field=>field.path==="reasoning_effort")?.source).toBe("session");
   await f.composition.conversationControl.resetOptions(run.session_id!,{command_id:"inherit-effort",expected_revision:1,fields:["reasoning_effort"]});expect((await f.composition.conversationControl.options(run.session_id!)).options.reasoning_effort).toBe("medium");
   const next=await f.composition.host.runSessions.startChat({command_id:"request-low",session_id:run.session_id!,task:"again",reasoning_effort:"low"});const done=await finish(f,next.run_id);expect(done.timeline.find(event=>event.type==="run.created")?.data.reasoning_effort).toBe("low");
   expect((await f.composition.conversationControl.options(run.session_id!)).options.reasoning_effort).toBe("medium");
  }finally{await f.close();}
 });
 it("rejects stale project/session CAS and permission ceilings without changing saved values",async()=>{
  const f=await fixture();try{
   await f.composition.permissionConfig.setUserPreset("read-only");
   await f.composition.conversationControl.updateProjectDefaults("chat:local",{command_id:"p-one",expected_revision:0,overrides:{reasoning_effort:"low"}});
   await expect(f.composition.conversationControl.updateProjectDefaults("chat:local",{command_id:"p-stale",expected_revision:0,overrides:{reasoning_effort:"high"}})).rejects.toMatchObject({code:"project_options_conflict"});
   expect((await f.composition.conversationControl.projectDefaults("chat:local")).overrides.reasoning_effort).toBe("low");
   const run=await f.composition.host.runSessions.startChat({command_id:"session-cas",task:"hello"});await finish(f,run.run_id);
   const current=await f.composition.conversationControl.options(run.session_id!);await f.composition.conversationControl.updateOptions(run.session_id!,{command_id:"s-one",expected_revision:0,options:{...current.options,reasoning_effort:"high"}});
   await expect(f.composition.conversationControl.resetOptions(run.session_id!,{command_id:"s-stale",expected_revision:0})).rejects.toMatchObject({code:"session_options_conflict"});
   const restricted=await createHostComposition({...f.options,profileRoot:join(f.root,"restricted-profile"),dataDir:join(f.root,"restricted"),sessionDir:join(f.root,"restricted-sessions"),permissionConfigPath:join(f.root,"restricted-permission.json"),environment:{TRACEGRAPH_PERMISSION_PRESET:"read-only"}});
   try{await expect(restricted.conversationControl.updateProjectDefaults("chat:local",{command_id:"p-forged",expected_revision:0,overrides:{permission_preset:"full-write"}})).rejects.toMatchObject({code:"permission_ceiling"});}finally{await restricted.close();}
  }finally{await f.close();}
 });
 it("keeps admitted model/key/reasoning across project/global changes and registry rotation",async()=>{
  const f=await fixture();try{
   const workspace=await f.composition.resolveWorkspace("chat:local");
   const input={command_id:"immutable",project_id:"chat:local",task:"hello",mode:"execute" as const};
   const admitted=await f.composition.conversationControl.prepare(input,workspace);
   await f.control.updateSettings({command_id:"global-low",expected_revision:0,patch:{model:{reasoning_effort:"low"}}});
   await f.composition.conversationControl.updateProjectDefaults("chat:local",{command_id:"project-low",expected_revision:0,overrides:{reasoning_effort:"low"}});
   await f.save("new-model","fixture-new-key",0);
   const run=await admitted.start({...input,workspace});const done=await finish(f,run.run_id);
   expect(done.timeline.find(event=>event.type==="run.created")?.data).toMatchObject({reasoning_effort:"high",model_binding:{model:"old-model",revision:0}});expect(f.calls[0]).toMatchObject({model:"old-model",key:"Bearer fixture-original-key"});
  }finally{await f.close();}
 });
 it("enforces live authentication and read-only replay at actual settings routes",async()=>{
  const f=await fixture();try{
   const app=f.composition.host.app,bootstrap=(await app.inject({method:"GET",url:"/api/bootstrap",headers:{origin:"http://127.0.0.1:4310"}})).json();
   const auth={origin:"http://127.0.0.1:4310",authorization:`Bearer ${bootstrap.token}`,"x-tracegraph-command-id":"route-settings"};
   expect((await app.inject({method:"POST",url:"/api/workbench/settings/restore",payload:{command_id:"anonymous",expected_revision:0,target_revision:0}})).statusCode).toBe(401);
   const update=await app.inject({method:"POST",url:"/api/workbench/settings",headers:auth,payload:{command_id:"route-settings",expected_revision:0,patch:{general:{language:"en"}}}});expect(update.statusCode).toBe(200);expect(update.json().settings.general).toMatchObject({language:"en",notify_completed:true});
   const history=await app.inject({method:"GET",url:"/api/workbench/settings/history",headers:auth});expect(history.statusCode).toBe(200);expect(history.json().entries).toHaveLength(2);
   const run=await f.composition.host.runSessions.startChat({command_id:"route-replay-run",task:"hello"});const done=await finish(f,run.run_id);
   const replay=await app.inject({method:"POST",url:"/api/replay",headers:{...auth,"x-tracegraph-command-id":"make-replay"},payload:{session_id:run.session_id,run_id:run.run_id,until_sequence:done.last_sequence}});expect(replay.statusCode).toBe(200);
   const denied=await app.inject({method:"POST",url:"/api/workbench/settings/restore",headers:{authorization:`Bearer ${replay.json().replay_token}`,"x-tracegraph-command-id":"replay-restore"},payload:{command_id:"replay-restore",expected_revision:1,target_revision:0}});expect(denied.statusCode).toBe(403);expect((await f.control.settings()).revision).toBe(1);
   const restored=await app.inject({method:"POST",url:"/api/workbench/settings/restore",headers:{...auth,"x-tracegraph-command-id":"route-restore"},payload:{command_id:"route-restore",expected_revision:1,target_revision:0}});expect(restored.statusCode).toBe(200);expect(restored.json().snapshot).toMatchObject({revision:2,settings:{general:{language:"zh-CN"}}});
  }finally{await f.close();}
 });
 it("records redacted canonical history, restores with CAS as a new revision and preserves current private tool values",async()=>{
  const f=await fixture();try{
   await f.control.updateSettings({command_id:"settings-language",expected_revision:0,patch:{general:{language:"en"}}});
   const tools=WorkbenchSettingsValuesSchema.parse({tools:{mcp:{config_version:"tracegraph.mcp.v1",servers:[{name:"fixture",command:"node",args:["literal-history-private"],env:{CUSTOM:"literal-env-private",API_KEY:"${secret:FIXTURE_KEY}"},required:false,transport:"stdio"}]}}}).tools;
   await f.control.updateSettings({command_id:"settings-tools",expected_revision:1,patch:{tools}});
   await f.control.updateSettings({command_id:"settings-dark",expected_revision:2,patch:{appearance:{theme:"dark"}}});
   const history=await f.control.settingsHistory();expect(history.entries.map(entry=>entry.revision)).toEqual([3,2,1,0]);expect(JSON.stringify(history)).not.toMatch(/literal-history-private|literal-env-private|fixture-original-key/u);
   const restored=await f.control.restoreSettings({command_id:"restore-tools",expected_revision:3,target_revision:2});expect(restored).toMatchObject({snapshot:{revision:4,settings:{appearance:{theme:"system"},general:{language:"en"}}},preserved_sections:["tools"]});expect(restored.snapshot.settings.tools.mcp.servers[0]?.args).toEqual(["literal-history-private"]);
   await expect(f.control.restoreSettings({command_id:"stale-restore",expected_revision:3,target_revision:0})).rejects.toMatchObject({code:"settings_revision_conflict"});expect((await f.control.settings()).revision).toBe(4);
   expect((await f.control.restoreSettings({command_id:"restore-tools",expected_revision:3,target_revision:2})).snapshot.revision).toBe(4);
   const historyDir=join(f.root,"workbench-events");const {readdir}=await import("node:fs/promises");const files=await readdir(historyDir);for(const name of files){const bytes=await readFile(join(historyDir,name),"utf8");expect(bytes).not.toMatch(/literal-history-private|literal-env-private|fixture-original-key/u);}
   await f.control.close();const reopened=await createWorkbenchControl(f.context);try{expect((await reopened.settingsHistory()).entries[0]).toMatchObject({revision:4,operation:"restore",restored_from_revision:2});expect((await reopened.settings()).settings.general.language).toBe("en");}finally{await reopened.close();}
  }finally{await f.close();}
 });
});
