import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {createManagedWorkspaceHandle,ConfigurableModelAdapter,JsonlEventLedger,probeNativeSandbox,projectRun,type AgentRuntime} from "@tracegraph/core";
import {WorkbenchSettingsValuesSchema,type RunProjection} from "@tracegraph/contracts";
import {createWorkbenchControl,type WorkbenchControlContext} from "./workbench-control.js";
import {WorkbenchJournal} from "./workbench-journal.js";
import {WorkspaceCoordinator} from "./workspace-coordinator.js";
import {WorkbenchScheduler,nextScheduleTime} from "./scheduler.js";
import {DevWorkbench} from "../dist/dev-workbench.js";
import type {PermissionConfigController} from "./composition/permission-config.js";
import {LeasedModelAdapter} from "./composition/leased-model.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"outlive-workbench-"));roots.push(root);const workspaceRoot=join(root,"repository");await mkdir(workspaceRoot);const workspace=await createManagedWorkspaceHandle({projectId:"project:test",root:workspaceRoot});
  const runtime={inspectSkills:vi.fn(async()=>[]),getProjection:vi.fn(async()=>({run_id:"run:test",project_id:"project:test",task:"task",status:"completed",pending_approval:null})),getTelemetryStatus:vi.fn(()=>({}))} as unknown as AgentRuntime;
  const model=new ConfigurableModelAdapter();const workspaceCoordinator=new WorkspaceCoordinator();
  const context:WorkbenchControlContext={profileRoot:root,profileId:"profile:test",runtime,model,workspaceCoordinator,permissionConfig:{snapshot:()=>({selected_preset:{sandbox_mode:"danger-full-access"}})} as unknown as PermissionConfigController,resolveWorkspace:async()=>workspace,listProjects:()=>[{workspace}],getModelConfig:()=>({provider:"openai",protocol:"openai",configured:false,base_url:"https://api.openai.com/v1",model:"",has_key:false}),readSession:async()=>{throw new Error("unavailable");},startRun:vi.fn(async()=>({run_id:"run:test",status:"running"}) as RunProjection)};
  return {root,workspaceRoot,workspace,context};
}
describe("shared workbench settings and business receipts",()=>{
  it("advertises capability tests only when the real probe controller is assembled",async()=>{const {context}=await fixture();const control=await createWorkbenchControl(context);try{for(const operation of ["models.capabilities.test","models.capabilities.read"])expect((await control.capabilities()).capabilities.find(item=>item.operation===operation)?.state).toBe("unavailable");context.modelCapabilities={pending:0};for(const operation of ["models.capabilities.test","models.capabilities.read"])expect((await control.capabilities()).capabilities.find(item=>item.operation===operation)?.state).toBe("available");}finally{await control.close();}});
  it("advertises managed project creation only when the composition supplies it",async()=>{
    const {context}=await fixture();const control=await createWorkbenchControl(context);try{
      expect((await control.capabilities()).capabilities.find(x=>x.operation==="projects.create")?.state).toBe("unavailable");
      context.projectCreationAvailable=true;
      expect((await control.capabilities()).capabilities.find(x=>x.operation==="projects.create")?.state).toBe("available");
    }finally{await control.close();}
  });
  it("reports a restart request honestly and never repeats it for a duplicate command",async()=>{
    const {context}=await fixture();const control=await createWorkbenchControl(context);try{
      expect((await control.capabilities()).capabilities.find(x=>x.operation==="host.restart")?.state).toBe("unavailable");
      await expect(control.command({type:"host.restart",command_id:"command:unsupported-restart"})).rejects.toMatchObject({code:"host_restart_unavailable"});
      const restart=vi.fn(async()=>undefined);context.requestRestart=restart;
      const input={type:"host.restart" as const,command_id:"command:restart-once"};
      const receipt=await control.command(input);
      expect(receipt).toMatchObject({code:"restart_requested"});
      expect(receipt.message).toContain("confirm");
      expect(await control.command(input)).toEqual(receipt);
      expect(restart).toHaveBeenCalledTimes(1);
    }finally{await control.close();}
  });
  it("projects stable recent notifications from real canonical events, survives reconnect and honors all notification switches",async()=>{
    const {context,root,workspace}=await fixture();context.dataRoot=join(root,"data");let now=new Date("2026-10-03T00:00:00Z");const ledger=new JsonlEventLedger(join(context.dataRoot,"events"),{now:()=>now});context.runtime.getProjection=async id=>projectRun(await ledger.list(id));context.resolveWorkspace=async projectId=>{if(projectId!==workspace.project_id)throw new Error("Unregistered project");return workspace;};
    const cases=[{id:"done",type:"run.completed",data:{outcome:"done"}},{id:"failed",type:"run.failed",data:{code:"fixture_failed"}},{id:"interrupted",type:"run.interrupted",data:{}},{id:"plan",type:"plan.ready",data:{todo_ids:["todo:fixture"],todo_count:1}},{id:"approval",type:"approval.requested",data:{pending_approval:{approval_id:"approval:fixture",action_id:"action:fixture",risk:"high",preview:{preview_id:"preview:fixture",action_id:"action:fixture",path:"file.txt",diff:"+change",base_hash:`sha256:${"a".repeat(64)}`,patch_hash:`sha256:${"b".repeat(64)}`,scope:["file.txt"],expires_at:"2026-10-03T01:00:00Z"}}}},{id:"cancelled",type:"run.cancelled",data:{}},{id:"orphan",type:"run.completed",data:{outcome:"hidden"}}] as const;
    const receipts=new Map<string,string>();for(const [index,item]of cases.entries()){const project_id=item.id==="orphan"?"project:removed":workspace.project_id;const run_id=`run:${item.id}`,session_id=`session:${item.id}`;await ledger.append({type:"run.created",project_id,run_id,session_id,attempt:0,summary:"Fixture created",artifact_refs:[],data:{task:`Public ${item.id}`,mode:"execute",workspace_kind:"managed_local"}});now=new Date(`2026-10-03T00:00:0${index+1}Z`);const event=await ledger.append({type:item.type,project_id,run_id,session_id,attempt:0,summary:"Synthetic public event",artifact_refs:[],data:{...item.data,reasoning_content:"synthetic-private-marker"}});receipts.set(item.id,event.event_id);}
    let control=await createWorkbenchControl(context);try{const first=await control.resources();expect(first.notifications).toHaveLength(5);expect(first.notifications?.map(x=>x.status)).toEqual(["awaiting_approval","awaiting_plan_approval","interrupted","failed","completed"]);for(const notification of first.notifications??[])expect(notification.notification_id).toBe(receipts.get(notification.run_id.slice(4)));expect(JSON.stringify(first.notifications)).not.toContain("synthetic-private-marker");expect(first.runs.some(x=>x.status==="completed"||x.status==="failed")).toBe(false);await control.close();control=await createWorkbenchControl(context);expect((await control.resources()).notifications).toEqual(first.notifications);
      const settings=await control.settings();await control.updateSettings({command_id:"notifications:disabled",expected_revision:settings.revision,patch:{general:{notify_completed:false,notify_failed:false,notify_approval:false}}});expect((await control.resources()).notifications).toEqual([]);await control.close();control=await createWorkbenchControl(context);expect((await control.resources()).notifications).toEqual([]);
    }finally{await control.close();}
  });
  // 260 real fsync-backed fixture events exercise retention, not a latency budget.
  // Keep all persisted facts instead of replacing the ledger with a mock under CI load.
  it("bounds notifications to the 128 latest real event timestamps and does not synthesize missing receipts",async()=>{
    const {context,root,workspace}=await fixture();context.dataRoot=join(root,"data");let now=new Date("2026-10-03T00:00:00Z");const ledger=new JsonlEventLedger(join(context.dataRoot,"events"),{now:()=>now});context.runtime.getProjection=async id=>projectRun(await ledger.list(id));
    for(let index=0;index<130;index++){const run_id=`run:bounded-${String(index).padStart(3,"0")}`;now=new Date(Date.parse("2026-10-03T00:00:00Z")+index*1000);await ledger.append({type:"run.created",project_id:workspace.project_id,run_id,attempt:0,summary:"Created",artifact_refs:[],data:{task:`Public ${index}`,mode:"plan",workspace_kind:"managed_local"}});await ledger.append({type:"run.completed",project_id:workspace.project_id,run_id,attempt:0,summary:"Completed",artifact_refs:[],data:{outcome:"done"}});}
    const control=await createWorkbenchControl(context);try{const notifications=(await control.resources()).notifications;expect(notifications).toHaveLength(128);expect(notifications?.[0]?.task).toBe("Public 129");expect(notifications?.at(-1)?.task).toBe("Public 2");const completed=await context.runtime.getProjection("run:bounded-129");context.runtime.getProjection=async()=>({...completed,timeline:completed.timeline.filter(event=>event.type!=="run.completed")});expect((await control.resources()).notifications).toEqual([]);}finally{await control.close();}
  },20_000);
  it("projects read-only developer policy without disabling resource reads or cleanup",async()=>{
    const {context}=await fixture();context.permissionConfig={snapshot:()=>({selected_preset:{sandbox_mode:"read-only"}})} as unknown as PermissionConfigController;const control=await createWorkbenchControl(context);try{const capabilities=(await control.capabilities()).capabilities;for(const operation of ["git.stage","git.unstage","git.discard","git.commit","git.branch.create","git.worktree.create","git.worktree.remove","terminal.create"])expect(capabilities.find(x=>x.operation===operation)).toMatchObject({state:"policy-denied",reason:expect.stringContaining("permission preset")});for(const operation of ["settings.read","resources.read","terminal.close","preview.start","preview.register","preview.stop","host.stop"])expect(capabilities.find(x=>x.operation===operation)?.state).toBe("available");}finally{await control.close();}
  });
  it("uses the actual native probe for missing backends, shares concurrent probes, and permits explicit sandbox-disabled execution",async()=>{
    const {context,root}=await fixture();let mode:"workspace-write"|"danger-full-access"="workspace-write";context.permissionConfig={snapshot:()=>({selected_preset:{sandbox_mode:mode}})} as unknown as PermissionConfigController;context.sandboxProbe=vi.fn(request=>probeNativeSandbox(request,{platform:"darwin",seatbeltExecutable:join(root,"missing-seatbelt")}));const control=await createWorkbenchControl(context);try{const results=await Promise.all([control.capabilities(),control.capabilities()]);for(const result of results){for(const operation of ["git.stage","git.status","git.diff","terminal.create","preview.start"])expect(result.capabilities.find(x=>x.operation===operation)).toMatchObject({state:"unavailable",reason:expect.stringContaining("seatbelt_backend_unavailable")});expect(result.capabilities.find(x=>x.operation==="terminal.close")?.state).toBe("available");}expect(context.sandboxProbe).toHaveBeenCalledTimes(2);mode="danger-full-access";const full=(await control.capabilities()).capabilities;for(const operation of ["git.stage","terminal.create"])expect(full.find(x=>x.operation===operation)?.state).toBe("available");expect(full.find(x=>x.operation==="preview.start")?.state).toBe("unavailable");}finally{await control.close();}
  });
  it("describes developer settings by their actual consumers and retains existing resource configuration",async()=>{
    const {context}=await fixture();const control=await createWorkbenchControl(context);try{const fields=(await control.settings()).fields;for(const key of ["editor","preview_open","review_scope"])expect(fields.find(x=>x.path===`developer.${key}`)?.effective).toBe("immediate");for(const key of ["shell","worktree_directory"])expect(fields.find(x=>x.path===`developer.${key}`)).toMatchObject({effective:"new-run",reason:expect.stringContaining("existing resources retain")});expect(fields.find(x=>x.path==="developer.max_parallel_runs")?.effective).toBe("new-run");}finally{await control.close();}
  });
  it("filters real canonical usage by project, session and timestamp without inventing costs",async()=>{
    const {context,root}=await fixture();context.dataRoot=join(root,"data");
    let now=new Date("2026-10-03T00:00:00Z");const ledger=new JsonlEventLedger(join(context.dataRoot,"events"),{now:()=>now});
    for(const [run,project,session] of [["run:one","project:test","session:one"],["run:two","project:test","session:two"],["run:outside","project:unregistered","session:outside"]]){
      now=new Date("2026-10-03T00:00:00Z");await ledger.append({type:"run.created",project_id:project!,run_id:run!,session_id:session!,attempt:0,summary:"Synthetic usage fixture",artifact_refs:[],data:{}});
      now=new Date("2026-10-03T01:00:00Z");await ledger.append({type:"model.usage_reported",project_id:project!,run_id:run!,session_id:session!,attempt:0,summary:"Synthetic provider-reported usage",artifact_refs:[],data:{provider:"openai",model:"synthetic",input_tokens:10,output_tokens:5,total_tokens:15,request_kind:"initial",request_sequence:1}});
    }
    context.readSession=vi.fn(async id=>{if(id!=="session:one")throw new Error("Session unavailable");return {header:{session_id:id}} as never;});
    const control=await createWorkbenchControl(context);try{
      const all=await control.command({type:"usage.query",command_id:"usage:all"});expect(all.usage).toMatchObject({source:"ledger",run_count:2,total_tokens:30,costs:[]});
      const selected=await control.command({type:"usage.query",command_id:"usage:session",project_id:"project:test",session_id:"session:one",from:"2026-10-03T08:30:00+08:00",to:"2026-10-03T09:30:00+08:00"});expect(selected.usage).toMatchObject({run_count:1,input_tokens:10,output_tokens:5,total_tokens:15,costs:[]});
      await expect(control.command({type:"usage.query",command_id:"usage:denied",session_id:"session:outside"})).rejects.toThrow("Session unavailable");
      await expect(control.command({type:"usage.query",command_id:"usage:invalid",from:"2026-10-03T01:00:00Z",to:"2026-10-03T00:00:00Z"})).rejects.toMatchObject({code:"usage_range_invalid"});
    }finally{await control.close();}
  });
  it("persists revision, keeps omitted sections and rejects concurrent stale writes",async()=>{
    const {context}=await fixture();const control=await createWorkbenchControl(context);try{
      const initial=await control.settings();expect(initial.settings.memory.memory_recall).toBe(false);
      const next=await control.updateSettings({command_id:"settings:one",expected_revision:0,patch:{appearance:{theme:"dark",ui_font_size:16,code_font_size:15,output_density:"compact"}}});expect(next.settings.appearance.theme).toBe("dark");expect(next.settings.general.language).toBe("zh-CN");
      const duplicate=await control.updateSettings({command_id:"settings:one",expected_revision:0,patch:{appearance:{theme:"dark",ui_font_size:16,code_font_size:15,output_density:"compact"}}});expect(duplicate.revision).toBe(1);
      await expect(control.updateSettings({command_id:"settings:stale",expected_revision:0,patch:{}})).rejects.toMatchObject({code:"settings_revision_conflict"});
      expect(JSON.parse(await readFile(join(context.profileRoot,"workbench-settings.json"),"utf8")).settings.appearance.theme).toBe("dark");
    }finally{await control.close();}
  });
  it("returns unconfigured connection result without contacting a provider",async()=>{const {context}=await fixture();const control=await createWorkbenchControl(context);try{expect(await control.testModel("test:one")).toMatchObject({status:"failed",code:"model_unconfigured"});expect((await control.capabilities()).capabilities.find(x=>x.operation==="model.test")?.state).toBe("unconfigured");}finally{await control.close();}});
  it("tests the captured model and key across rotation without marking the replacement as tested",async()=>{
    const {context}=await fixture();const retired=vi.fn(async()=>undefined);
    const model=new LeasedModelAdapter({resolveCredential:async()=>"old-key-value"});context.model=model;
    const config={provider:"custom" as const,protocol:"openai-chat-completions" as const,baseUrl:"https://test.example/v1",model:"old-model",credentialRef:"${secret:OLD_KEY}"};
    model.configure(config);
    let publicValue={...model.publicConfig(),has_key:true,credential:{name:"OLD_KEY",backend:"private_file" as const,writable:true}};
    context.getModelConfig=()=>publicValue;
    const requests:Array<{model:string;key:string|null}>=[];
    vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{requests.push({model:JSON.parse(String(init.body)).model,key:new Headers(init.headers).get("authorization")});return Response.json({choices:[{message:{content:"OK"}}]});}));
    const control=await createWorkbenchControl(context);
    try{
      const pending=control.testModel("test:immutable");
      model.configure({...config,model:"new-model",credentialRef:"${secret:NEW_KEY}"});
      publicValue={...model.publicConfig(),has_key:true,credential:{name:"NEW_KEY",backend:"private_file",writable:true}};
      model.retireCredential(config.credentialRef,retired);
      expect(retired).not.toHaveBeenCalled();
      expect(await pending).toMatchObject({status:"passed",model:"old-model"});
      expect(requests).toEqual([{model:"old-model",key:"Bearer old-key-value"}]);
      expect((await control.settings()).model_test).toBeUndefined();
      expect(retired).toHaveBeenCalledTimes(1);
    }finally{await control.close();vi.unstubAllGlobals();}
  });
  it("replays receipts across restart and never retries an unknown side effect",async()=>{const {root}=await fixture();const journal=new WorkbenchJournal(join(root,"journal"));await journal.initialize();let writes=0;const input={path:"x"};expect(await journal.once("cmd:test","git.stage",input,async()=>++writes)).toBe(1);const reopened=new WorkbenchJournal(join(root,"journal"));expect(await reopened.once("cmd:test","git.stage",input,async()=>++writes)).toBe(1);expect(writes).toBe(1);await expect(reopened.once("cmd:test","git.stage",{path:"y"},async()=>2)).rejects.toMatchObject({code:"command_id_conflict"});});
});
describe("durable schedules",()=>{
  it("uses timezone wall clock and claims an occurrence before dispatch; restart does not duplicate",async()=>{
    const {context,root}=await fixture();let now=new Date("2026-10-03T00:00:00Z");const journal=new WorkbenchJournal(join(root,"journal"));await journal.initialize();
    const scheduler=new WorkbenchScheduler({...context,journal,now:()=>now,automaticTimer:false});await scheduler.initialize();
    const input={title:"daily",project_id:"project:test",task:"test",mode:"execute" as const,timezone:"Asia/Shanghai",enabled:true,timing:{kind:"once" as const,at:"2026-10-03T00:01:00Z"}};
    const created=await scheduler.command({type:"schedule.create",command_id:"schedule:create",input});expect(created.schedule?.next_at).toBe(input.timing.at);now=new Date(input.timing.at);await scheduler.tick();await vi.waitFor(()=>expect(context.startRun).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(scheduler.list()[0]?.running_run_id).toBe("run:test"));await scheduler.close();
    const reopened=new WorkbenchScheduler({...context,journal,now:()=>now,automaticTimer:false});await reopened.initialize();await reopened.tick();expect(context.startRun).toHaveBeenCalledTimes(1);expect(reopened.history(created.schedule!.schedule_id)).toHaveLength(1);await reopened.close();
    expect(nextScheduleTime({...input,timing:{kind:"daily",time:"09:15"}},new Date("2026-10-03T00:00:00Z"))).toBe("2026-10-03T01:15:00.000Z");
  });
  it("records missed triggers and does not run them on boot",async()=>{const {context,root}=await fixture();const journal=new WorkbenchJournal(join(root,"journal"));await journal.initialize();let now=new Date("2026-10-03T00:00:00Z");const scheduler=new WorkbenchScheduler({...context,journal,now:()=>now,automaticTimer:false});await scheduler.initialize();const created=await scheduler.command({type:"schedule.create",command_id:"create",input:{title:"missed",project_id:"project:test",task:"task",mode:"plan",timezone:"UTC",enabled:true,timing:{kind:"once",at:"2026-10-03T00:01:00Z"}}});await scheduler.close();now=new Date("2026-10-03T00:05:00Z");const next=new WorkbenchScheduler({...context,journal,now:()=>now,automaticTimer:false});await next.initialize();await next.tick();expect(context.startRun).not.toHaveBeenCalled();expect(next.history(created.schedule!.schedule_id)[0]?.status).toBe("missed");await next.close();});
});
describe("actual developer resources",()=>{
  it("Git stage/unstage/commit use real repository receipts; discard requires preview HEAD",async()=>{const {context,workspaceRoot}=await fixture();execFileSync("git",["init","-q"],{cwd:workspaceRoot});execFileSync("git",["config","user.name","Test"],{cwd:workspaceRoot});execFileSync("git",["config","user.email","test@invalid.example"],{cwd:workspaceRoot});await writeFile(join(workspaceRoot,"file.txt"),"one\n");const dev=new DevWorkbench({...context,getSettings:()=>WorkbenchSettingsValuesSchema.parse({})});await dev.initialize();try{
    await dev.command({type:"git.stage",command_id:"stage",project_id:"project:test",paths:["file.txt"]});const committed=await dev.command({type:"git.commit",command_id:"commit",project_id:"project:test",message:"initial"});expect(committed.git?.files).toEqual([]);await writeFile(join(workspaceRoot,"file.txt"),"two\n");await expect(dev.command({type:"git.discard",command_id:"discard",project_id:"project:test",paths:["file.txt"]})).rejects.toMatchObject({code:"discard_preview_required"});expect(await readFile(join(workspaceRoot,"file.txt"),"utf8")).toBe("two\n");
  }finally{await dev.close();}});
  it("real PTY output survives view detach; explicit close releases the workspace",async()=>{if(process.platform==="win32")return;const {context}=await fixture();const dev=new DevWorkbench({...context,getSettings:()=>WorkbenchSettingsValuesSchema.parse({})});await dev.initialize();try{const created=await dev.command({type:"terminal.create",command_id:"terminal:create",project_id:"project:test",cols:100,rows:30});await dev.command({type:"terminal.input",command_id:"terminal:input",terminal_id:created.terminal!.terminal_id,text:"printf 'OUTLIVE_'; printf 'PTY_RESULT\\n'; printf verified > pty-proof.txt\r"});await vi.waitFor(()=>expect(dev.terminals()[0]?.transcript).toContain("OUTLIVE_PTY_RESULT"));expect(await readFile(join(context.listProjects()[0]!.workspace.real_root,"pty-proof.txt"),"utf8")).toBe("verified");expect(context.workspaceCoordinator.list()).toHaveLength(1);await dev.command({type:"terminal.close",command_id:"terminal:close",terminal_id:created.terminal!.terminal_id});expect(context.workspaceCoordinator.list()).toHaveLength(0);}finally{await dev.close();}});
});


describe("developer lifecycle and scope negative oracles",()=>{
 it("creates and removes a real worktree but refuses an active worktree",async()=>{const {context,workspaceRoot}=await fixture();execFileSync("git",["init","-q"],{cwd:workspaceRoot});execFileSync("git",["config","user.name","Test"],{cwd:workspaceRoot});execFileSync("git",["config","user.email","test@invalid.example"],{cwd:workspaceRoot});await writeFile(join(workspaceRoot,"file.txt"),"one");execFileSync("git",["add","."],{cwd:workspaceRoot});execFileSync("git",["commit","-qm","base"],{cwd:workspaceRoot});let tree:Awaited<ReturnType<typeof createManagedWorkspaceHandle>>|undefined;context.registerWorktree=async root=>{tree=await createManagedWorkspaceHandle({projectId:"project:tree",root});return {workspace:tree};};const dev=new DevWorkbench({...context,getSettings:()=>WorkbenchSettingsValuesSchema.parse({})});await dev.initialize();try{const result=await dev.command({type:"git.worktree.create",command_id:"tree:create",project_id:"project:test",name:"feature",branch:"feature-test"});expect(result.git?.worktrees).toHaveLength(2);expect(await readFile(join(tree!.real_root,"file.txt"),"utf8")).toBe("one");const lease=await context.workspaceCoordinator.acquireWorkspace(tree!,{holderId:"busy",kind:"run"});await expect(dev.command({type:"git.worktree.remove",command_id:"tree:busy",project_id:"project:test",worktree_path:tree!.real_root})).rejects.toMatchObject({code:"worktree_active"});lease.release();await dev.command({type:"git.worktree.remove",command_id:"tree:remove",project_id:"project:test",worktree_path:tree!.real_root});await expect(readFile(join(tree!.real_root,"file.txt"))).rejects.toMatchObject({code:"ENOENT"});}finally{await dev.close();}});
 it("registered preview reports real HTTP health; disconnect leaves an external service running",async()=>{const {createServer}=await import("node:http");const server=createServer((_request,response)=>response.end("preview-oracle"));await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address() as {port:number};const {context}=await fixture();const dev=new DevWorkbench({...context,getSettings:()=>WorkbenchSettingsValuesSchema.parse({})});await dev.initialize();try{const result=await dev.command({type:"preview.register",command_id:"preview:register",project_id:"project:test",port:address.port});expect(result.preview?.state).toBe("ready");await dev.command({type:"preview.stop",command_id:"preview:stop",preview_id:result.preview!.preview_id});expect(await(await fetch(result.preview!.url)).text()).toBe("preview-oracle");}finally{await dev.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}});
 it("read-only project and metadata escape cannot obtain a developer write grant",async()=>{const {context,workspace,root,workspaceRoot}=await fixture();const readonly={...workspace,capabilities:{...workspace.capabilities,commit_patch:false,run_command:false}};const dev=new DevWorkbench({...context,resolveWorkspace:async()=>readonly,getSettings:()=>WorkbenchSettingsValuesSchema.parse({})});await dev.initialize();try{await expect(dev.command({type:"terminal.create",command_id:"deny",project_id:"project:test",cols:100,rows:30})).rejects.toMatchObject({code:"workspace_read_only"});const {symlink}=await import("node:fs/promises");await symlink(root,join(workspaceRoot,".git"));await expect(dev.command({type:"git.status",command_id:"escape",project_id:"project:test"})).rejects.toMatchObject({code:"git_metadata_scope_denied"});}finally{await dev.close();}});
});


describe("schedule overlap and approval",()=>{
 it("skips overlap and associates completion with the original occurrence",async()=>{const {context,root}=await fixture();let now=new Date("2026-10-03T00:00:00Z"),status="running";context.runtime.getProjection=vi.fn(async()=>({status,pending_approval:null})) as unknown as AgentRuntime["getProjection"];const journal=new WorkbenchJournal(join(root,"journal"));await journal.initialize();const scheduler=new WorkbenchScheduler({...context,journal,now:()=>now,automaticTimer:false});await scheduler.initialize();const created=await scheduler.command({type:"schedule.create",command_id:"overlap-create",input:{title:"repeat",project_id:"project:test",task:"task",mode:"execute",timezone:"UTC",enabled:true,timing:{kind:"interval",seconds:60}}});now=new Date("2026-10-03T00:01:00Z");await scheduler.tick();await vi.waitFor(()=>expect(scheduler.list()[0]?.running_run_id).toBe("run:test"));now=new Date("2026-10-03T00:02:00Z");await scheduler.tick();await vi.waitFor(()=>expect(scheduler.history(created.schedule!.schedule_id)).toHaveLength(2));expect(context.startRun).toHaveBeenCalledTimes(1);status="completed";await scheduler.tick();expect(scheduler.history(created.schedule!.schedule_id).map(x=>x.status)).toEqual(["completed","overlap-skipped"]);await scheduler.close();});
 it("pauses a recurring schedule when the Run requires approval",async()=>{const {context,root}=await fixture();let now=new Date("2026-10-03T00:00:00Z");context.runtime.getProjection=vi.fn(async()=>({status:"awaiting_plan_approval",pending_approval:null})) as unknown as AgentRuntime["getProjection"];const journal=new WorkbenchJournal(join(root,"journal"));await journal.initialize();const scheduler=new WorkbenchScheduler({...context,journal,now:()=>now,automaticTimer:false});await scheduler.initialize();await scheduler.command({type:"schedule.create",command_id:"approval-create",input:{title:"approval",project_id:"project:test",task:"task",mode:"plan",timezone:"UTC",enabled:true,timing:{kind:"interval",seconds:60}}});now=new Date("2026-10-03T00:01:00Z");await scheduler.tick();await vi.waitFor(()=>expect(scheduler.list()[0]?.running_run_id).toBe("run:test"));await scheduler.tick();expect(scheduler.list()[0]).toMatchObject({enabled:false,last_status:"awaiting-approval"});now=new Date("2026-10-03T00:03:00Z");await scheduler.tick();expect(context.startRun).toHaveBeenCalledTimes(1);await scheduler.close();});
});
