import {describe,expect,it,vi} from "vitest";
import type {ConnectedLocalHost} from "@tracegraph/host";
import {previewLegacyMigration,commitLegacyMigration} from "@tracegraph/host";
import {HostConnectionError,type HostConnectionSnapshot} from "@tracegraph/contracts";
import {maybeRunWorkbenchCommand} from "./workbench-command.js";

vi.mock("@tracegraph/host",()=>({ensureLocalHost:vi.fn(),connectLocalHost:vi.fn(),previewLegacyMigration:vi.fn(),commitLegacyMigration:vi.fn()}));
function harness(methods:Record<string,unknown>={}) {
  const writes:string[]=[],errors:string[]=[];
  const close=vi.fn(async()=>undefined),stop=vi.fn(async()=>undefined);
  const client={bootstrap:vi.fn(async()=>undefined),...methods};
  const connection={status:{profile_id:"profile:test",boot_nonce:"boot:test",pid:123,http_address:"http://127.0.0.1:12345"},client,native:{registerProject:vi.fn(async()=>({project_id:"project:test"}))},close,stop} as unknown as ConnectedLocalHost;
  const connect=vi.fn(async()=>connection);
  return {writes,errors,close,stop,connect,connection,options:{connect,write:(value:string)=>writes.push(value),writeError:(value:string)=>errors.push(value)}};
}

describe("Unified local Workbench CLI",()=>{
  it("selects project context through real scoped reads and sends versions without file contents",async()=>{
    const sha="sha256:"+"a".repeat(64);
    const readProjectFile=vi.fn(async(projectId:string,input:{path:string})=>({project_id:projectId,path:input.path,sha256:sha,byte_length:19,kind:"text",content:"private source text"}));
    const startRun=vi.fn(async()=>({run_id:"run:context",status:"running"}));const state=harness({readProjectFile,startRun});
    expect(await maybeRunWorkbenchCommand(["run","start","--project-id","project:test","--task","Explain selected sources","--context","src/main.ts","--context","README.md","--command-id","command:context"],state.options)).toBe(0);
    expect(readProjectFile.mock.calls).toEqual([["project:test",{path:"src/main.ts"}],["project:test",{path:"README.md"}]]);
    expect(startRun).toHaveBeenCalledOnce();expect(startRun).toHaveBeenCalledWith(expect.objectContaining({command_id:"command:context",task:"Explain selected sources",file_contexts:[{path:"src/main.ts",expected_sha256:sha},{path:"README.md",expected_sha256:sha}]}));
    expect(JSON.stringify(startRun.mock.calls)).not.toContain("private source text");
  });
  it("refuses invalid, binary, duplicate and oversized project context before starting a task",async()=>{
    const sha="sha256:"+"a".repeat(64);
    for(const snapshot of [{kind:"binary",byte_length:1},{kind:"text",byte_length:65537,content:"oversized"}]){
      const startRun=vi.fn(),state=harness({startRun,readProjectFile:vi.fn(async()=>({project_id:"project:test",path:"src/main.ts",sha256:sha,...snapshot}))});
      expect(await maybeRunWorkbenchCommand(["run","start","--project-id","project:test","--task","Explain","--context","src/main.ts"],state.options)).toBe(2);expect(startRun).not.toHaveBeenCalled();
    }
    for(const paths of [["src/main.ts","src/main.ts"],["../outside.ts"],Array.from({length:6},(_,i)=>`file${i}.ts`)]){
      const startRun=vi.fn(),readProjectFile=vi.fn(),state=harness({startRun,readProjectFile});
      const exit=await maybeRunWorkbenchCommand(["run","start","--project-id","project:test","--task","Explain",...paths.flatMap(path=>["--context",path])],state.options);
      expect(exit).not.toBe(0);expect(readProjectFile).not.toHaveBeenCalled();expect(startRun).not.toHaveBeenCalled();
    }
    const startChat=vi.fn(),readProjectFile=vi.fn(),state=harness({startChat,readProjectFile});
    expect(await maybeRunWorkbenchCommand(["chat","start","--task","Explain","--context","src/main.ts"],state.options)).toBe(2);expect(readProjectFile).not.toHaveBeenCalled();expect(startChat).not.toHaveBeenCalled();
  });
  it("preserves explicit offline migration for a never-bound absent owner",async()=>{
    for(const operation of ["preview","commit"]){
      const state=harness();state.connect.mockRejectedValue(new HostConnectionError({state:"offline",generation:0,code:"host_recovery_exhausted"}));
      const request={sources:[{id:"fixture-source",root:"/synthetic-legacy"}]};
      vi.mocked(previewLegacyMigration).mockResolvedValue({files:[],warnings:[]} as never);vi.mocked(commitLegacyMigration).mockResolvedValue({copied_files:[],backup_created:true} as never);
      expect(await maybeRunWorkbenchCommand(["host","migration",operation,"--profile-root","/synthetic-profile","--input-json",JSON.stringify(request)],state.options)).toBe(0);
      expect(operation==="preview"?previewLegacyMigration:commitLegacyMigration).toHaveBeenCalledWith({...request,profileRoot:"/synthetic-profile"});
      expect(state.connect).toHaveBeenCalledWith({profileRoot:"/synthetic-profile"},false);
    }
  });
  it("never reinterprets stop, replay, profile/build errors or a previously-bound owner as offline migration",async()=>{
    vi.mocked(previewLegacyMigration).mockClear();vi.mocked(commitLegacyMigration).mockClear();
    for(const snapshot of [
      {state:"stopped",generation:0,code:"host_stopped"},
      {state:"offline",generation:1,code:"host_replay_stale"},
      {state:"upgrade-required",generation:0,code:"host_upgrade_required"},
      {state:"offline",generation:0,code:"host_profile_invalid"},
      {state:"offline",generation:2,code:"host_recovery_exhausted"},
    ] satisfies HostConnectionSnapshot[]){
      const state=harness();state.connect.mockRejectedValue(new HostConnectionError(snapshot));
      expect(await maybeRunWorkbenchCommand(["host","migration","preview","--input-json",JSON.stringify({sources:[]})],state.options)).toBe(1);
      expect(JSON.parse(state.errors[0]!).error.code).toBe(snapshot.code);
    }
    const denied=harness();denied.connect.mockRejectedValue(Object.assign(new Error("Synthetic permission restriction"),{status:403,code:"permission_ceiling"}));
    expect(await maybeRunWorkbenchCommand(["host","migration","commit","--input-json",JSON.stringify({sources:[]})],denied.options)).toBe(1);
    expect(previewLegacyMigration).not.toHaveBeenCalled();expect(commitLegacyMigration).not.toHaveBeenCalled();
  });
  it("returns nonzero for a file CAS conflict and keeps the original save command for reconciliation",async()=>{
    const expected="sha256:"+"a".repeat(64),actual="sha256:"+"b".repeat(64);const commandId="cmd:file-conflict";
    const receipt={status:"conflict",code:"file_revision_conflict",command_id:commandId,project_id:"project:test",path:"src/example.ts",expected_sha256:expected,actual_sha256:actual,receipt_event_id:"event:file-conflict"};
    const saveProjectFile=vi.fn(async()=>receipt);const state=harness({saveProjectFile});
    expect(await maybeRunWorkbenchCommand(["files","save","--project-id","project:test","--path","src/example.ts","--expected-sha256",expected,"--stdin","--command-id",commandId],{...state.options,readStdin:async()=>"const value = 1;\n"})).toBe(1);
    expect(saveProjectFile).toHaveBeenCalledExactlyOnceWith("project:test",{command_id:commandId,path:"src/example.ts",expected_sha256:expected,content:"const value = 1;\n"});
    expect(JSON.parse(state.writes[0]!)).toEqual(receipt);expect(state.errors).toEqual([]);
  });
  it("configures the dedicated image provider using stdin only and rejects unsupported generated formats before dispatch",async()=>{
    const configureImageProvider=vi.fn(async()=>({configured:true,has_key:true}));const startMediaRun=vi.fn();const state=harness({configureImageProvider,startMediaRun});
    expect(await maybeRunWorkbenchCommand(["image","configure","--protocol","openai-images","--base-url","http://127.0.0.1:18081/v1","--model","fixture-image","--key-stdin"],{...state.options,readStdin:async()=>"fixture-private-image-key\n"})).toBe(0);
    expect(configureImageProvider).toHaveBeenCalledWith({protocol:"openai-images",base_url:"http://127.0.0.1:18081/v1",model:"fixture-image",api_key:"fixture-private-image-key"});expect(state.writes.join("")).not.toContain("fixture-private-image-key");
    expect(await maybeRunWorkbenchCommand(["media","generate","--prompt","Fixture","--format","jpeg"],state.options)).toBe(1);expect(startMediaRun).not.toHaveBeenCalled();
  });
  it("requires canonical successful media refs and treats unknown outcomes as unresolved, without exporting prose",async()=>{
    const startMediaRun=vi.fn(async()=>({run_id:"run:media"}));const getArtifactContent=vi.fn();
    const noOutput=harness({startMediaRun,getRun:vi.fn(async()=>({run_id:"run:media",status:"completed",timeline:[],artifact_refs:[]})),getArtifactContent});
    expect(await maybeRunWorkbenchCommand(["media","generate","--prompt","Fixture"],noOutput.options)).toBe(1);expect(noOutput.writes[0]).toContain("media_output_missing");expect(getArtifactContent).not.toHaveBeenCalled();
    const receipt={receipt_id:"receipt:unknown",action_id:"action:unknown",tool_name:"generate_image",status:"unknown",transport_status:"unknown",business_status:"unknown",code:"image_outcome_unknown",summary:"Unknown image outcome",started_at:"2026-10-03T00:00:00Z",completed_at:"2026-10-03T00:00:01Z",duration_ms:1000,artifact_refs:[],metadata:{}};
    const unknown=harness({startMediaRun,getRun:vi.fn(async()=>({run_id:"run:media",status:"needs_manual_review",timeline:[{type:"tool.unknown",data:{receipt}}],artifact_refs:[]})),getArtifactContent});
    expect(await maybeRunWorkbenchCommand(["media","generate","--prompt","Fixture","--command-id","cmd:media-exact"],unknown.options)).toBe(3);expect(startMediaRun).toHaveBeenCalledWith(expect.objectContaining({command_id:"cmd:media-exact"}));expect(unknown.writes[0]).toContain("image_outcome_unknown");expect(getArtifactContent).not.toHaveBeenCalled();
  });

  it("keeps unowned legacy serve commands available and prints help without opening a profile",async()=>{
    const state=harness();
    expect(await maybeRunWorkbenchCommand(["serve"],state.options)).toBeUndefined();
    expect(await maybeRunWorkbenchCommand(["run","--help"],state.options)).toBe(0);
    expect(state.connect).not.toHaveBeenCalled();expect(state.writes.join("")).toContain("--key-stdin");
  });
  it("selects one explicit private profile and distinguishes status from starting an owner",async()=>{
    const state=harness();
    expect(await maybeRunWorkbenchCommand(["host","status","--profile-root","/synthetic-profile"],state.options)).toBe(0);
    expect(state.connect).toHaveBeenCalledWith({profileRoot:"/synthetic-profile"},false);
    expect(state.close).toHaveBeenCalledOnce();expect(state.stop).not.toHaveBeenCalled();
    expect(await maybeRunWorkbenchCommand(["host","stop"],state.options)).toBe(0);expect(state.stop).toHaveBeenCalledOnce();
  });
  it("rejects command-line credentials before connecting and only reads model keys from stdin",async()=>{
    const configureModel=vi.fn(async()=>({model:"synthetic",has_key:true,credential:{name:"safe-reference"},api_key:"synthetic-secret-key"}));
    const state=harness({configureModel});
    expect(await maybeRunWorkbenchCommand(["model","configure","--api-key","synthetic-secret-key"],state.options)).toBe(2);
    expect(state.connect).not.toHaveBeenCalled();expect(state.errors.join("")).not.toContain("synthetic-secret-key");
    const exit=await maybeRunWorkbenchCommand(["model","configure","--provider","openai","--protocol","openai-chat-completions","--base-url","http://127.0.0.1:12345/v1","--model","synthetic","--key-stdin"],{...state.options,readStdin:async()=>"synthetic-secret-key\n"});
    expect(exit).toBe(0);expect(configureModel).toHaveBeenCalledWith(expect.objectContaining({api_key:"synthetic-secret-key"}));
    expect(state.writes.join("")).not.toContain("synthetic-secret-key");
  });
  it("keeps saved configuration and a failed connection test as different outcomes",async()=>{
    const state=harness({testModel:vi.fn(async()=>({status:"failed",code:"connection_failed",message:"Synthetic provider refused the test"}))});
    expect(await maybeRunWorkbenchCommand(["model","test","--command-id","cmd:test"],state.options)).toBe(1);
    expect(state.writes.join("")).toContain('"connection_failed"');
  });
  it("rejects incompatible flags and invalid inputs before a business mutation",async()=>{
    const startRun=vi.fn();const workbenchCommand=vi.fn();const state=harness({startRun,workbenchCommand});
    expect(await maybeRunWorkbenchCommand(["run","start","--project-id","project:test","--task","Inspect","--global-preset","full-write"],state.options)).toBe(2);
    expect(startRun).not.toHaveBeenCalled();
    expect(await maybeRunWorkbenchCommand(["git","stage","--project-id","project:test","--path","../outside"],state.options)).toBe(1);
    expect(workbenchCommand).not.toHaveBeenCalled();
    expect(await maybeRunWorkbenchCommand(["terminal","close","terminal:one","ignored"],state.options)).toBe(2);
    expect(workbenchCommand).not.toHaveBeenCalled();
  });
  it("carries exact Run, approval, steering and Todo command identities",async()=>{
    const getRun=vi.fn(async()=>({project_id:"project:test",run_id:"run:test"}));const approve=vi.fn(async()=>({status:"running"}));
    const submitUserInput=vi.fn(async()=>({accepted:true}));const writeTodo=vi.fn(async()=>({receipt:{business_status:"success"}}));
    const state=harness({getRun,approve,submitUserInput,writeTodo});
    expect(await maybeRunWorkbenchCommand(["approval","approve","run:test","--approval-id","approval:one","--action-id","action:one","--command-id","cmd:approve"],state.options)).toBe(0);
    expect(approve).toHaveBeenCalledWith("run:test",{type:"approve",command_id:"cmd:approve",run_id:"run:test",project_id:"project:test",approval_id:"approval:one",action_id:"action:one"});
    expect(await maybeRunWorkbenchCommand(["run","input","run:test","--body","Keep the scope","--input-id","input:one","--command-id","cmd:input"],state.options)).toBe(0);
    expect(submitUserInput).toHaveBeenCalledWith("run:test",{command_id:"cmd:input",input_id:"input:one",kind:"message",body:"Keep the scope"});
    expect(await maybeRunWorkbenchCommand(["todo","create","run:test","--todo-id","todo:one","--title","Inspect tests","--command-id","cmd:todo"],state.options)).toBe(0);
    expect(writeTodo).toHaveBeenCalledWith("run:test",{command_id:"cmd:todo",input:{operation:"create",todo_id:"todo:one",title:"Inspect tests"}});
  });
  it("returns the actual business failure instead of promoting a transport reply to success",async()=>{
    const state=harness({writeTodo:vi.fn(async()=>({receipt:{business_status:"failure",code:"todo_conflict"}}))});
    expect(await maybeRunWorkbenchCommand(["todo","update","run:test","--todo-id","todo:one","--state","done"],state.options)).toBe(1);
    expect(state.writes.join("")).toContain("todo_conflict");
  });
  it("cancels a queued holder through the shared queue without inventing a Core Run",async()=>{
    const workbenchCommand=vi.fn(async()=>({status:"succeeded",code:"queue_cancelled"}));const getRun=vi.fn();const stop=vi.fn();
    const state=harness({workbenchCommand,getRun,stop});
    expect(await maybeRunWorkbenchCommand(["run","cancel","queued:cmd:waiting","--command-id","cmd:cancel"],state.options)).toBe(0);
    expect(workbenchCommand).toHaveBeenCalledWith({type:"queue.cancel",command_id:"cmd:cancel",holder_id:"cmd:waiting"});
    expect(getRun).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();
  });
  it("returns zero for an explicit cancellation only after canonical cancelled, while reads preserve task failure",async()=>{
    const getRun=vi.fn(async()=>({project_id:"project:one",run_id:"run:one",status:"cancelled"}));
    for(const [status,exit] of [["cancelled",0],["running",3],["failed",1],["needs_manual_review",1]] as const) {
      const state=harness({getRun,stop:vi.fn(async()=>({run_id:"run:one",status}))});
      expect(await maybeRunWorkbenchCommand(["run","cancel","run:one","--command-id","cmd:cancel"],state.options)).toBe(exit);
      expect(JSON.parse(state.writes[0]!).status).toBe(status);
    }
    const read=harness({getRun});expect(await maybeRunWorkbenchCommand(["run","get","run:one"],read.options)).toBe(1);
  });
  it("preserves only a bounded safe migration operation ID and queries the durable result without starting an owner",async()=>{
    const state=harness({});
    state.connect.mockResolvedValueOnce({status:{},client:{},native:{migrationResult:vi.fn(async()=>({state:"queued"}))},close:state.close});
    expect(await maybeRunWorkbenchCommand(["host","migration","result","migration:one"],state.options)).toBe(3);
    expect(state.connect).toHaveBeenCalledWith({},false);
    const failed=harness({getUsage:vi.fn(async()=>{throw Object.assign(new Error("Synthetic unknown result"),{code:"migration_outcome_unknown",operation_id:"migration:one",private_path:"/private"});})});
    expect(await maybeRunWorkbenchCommand(["usage"],failed.options)).toBe(1);
    expect(JSON.parse(failed.errors[0]!).error).toMatchObject({code:"migration_outcome_unknown",operation_id:"migration:one"});
    expect(failed.errors[0]).not.toContain("/private");
  });
  it("streams real JSONL and detaches on abort without sending a Run stop",async()=>{
    const abort=new AbortController();const stop=vi.fn();
    const streamEvents=vi.fn(async function*(_id:string,options:{signal:AbortSignal;afterSequence:number}){yield {sequence:7,type:"tool.completed"};await new Promise<void>(resolve=>options.signal.addEventListener("abort",()=>resolve(),{once:true}));});
    const state=harness({streamEvents,stop});
    const writes:string[]=[];
    const exit=await maybeRunWorkbenchCommand(["run","events","run:test","--after-sequence","6","--jsonl"],{...state.options,signal:abort.signal,write:text=>{writes.push(text);abort.abort();}});
    expect(exit).toBe(130);expect(writes).toEqual(['{"sequence":7,"type":"tool.completed"}\n']);
    expect(streamEvents).toHaveBeenCalledWith("run:test",expect.objectContaining({afterSequence:6,reconnect:false}));
    expect(stop).not.toHaveBeenCalled();expect(state.close).toHaveBeenCalledOnce();
  });
  it("finishes a canonical terminal ledger stream without cancelling the Run or awaiting transport EOF",async()=>{
    const stop=vi.fn();let detached=false;
    const streamEvents=vi.fn(async function*(){try{yield {sequence:9,type:"run.completed"};await new Promise(()=>{});}finally{detached=true;}});
    const state=harness({streamEvents,stop});
    expect(await maybeRunWorkbenchCommand(["run","events","run:terminal","--jsonl"],state.options)).toBe(0);
    expect(state.writes).toEqual(['{"sequence":9,"type":"run.completed"}\n']);expect(detached).toBe(true);expect(stop).not.toHaveBeenCalled();
  });
  it("retains existing Team/Memory/MCP/extension commands through the same private client",async()=>{
    for(const [argv,method,result] of [
      [["team","show","run:test"],"getTeam",{team_id:"team:test"}],
      [["memory","list"],"listMemoryControl",{items:[],conflicts:[]}],
      [["mcp","list"],"getMcpStatus",{servers:[]}],
      [["extensions","list"],"listExtensions",[]],
    ] as const){const action=vi.fn(async()=>result);const state=harness({[method]:action});expect(await maybeRunWorkbenchCommand(argv,state.options)).toBe(0);expect(action).toHaveBeenCalledOnce();expect(state.close).toHaveBeenCalledOnce();}
  });
  it("dispatches scoped resource commands and source/revision settings through closed contracts",async()=>{
    const workbenchCommand=vi.fn(async()=>({status:"succeeded",code:"synthetic_ok"}));const updateWorkbenchSettings=vi.fn(async()=>({revision:2}));
    const state=harness({workbenchCommand,updateWorkbenchSettings});
    expect(await maybeRunWorkbenchCommand(["terminal","create","--project-id","project:test","--command-id","cmd:terminal"],state.options)).toBe(0);
    expect(workbenchCommand).toHaveBeenCalledWith({type:"terminal.create",project_id:"project:test",command_id:"cmd:terminal",cols:100,rows:30});
    expect(await maybeRunWorkbenchCommand(["config","set","--input-json",JSON.stringify({command_id:"cmd:settings",expected_revision:1,patch:{model:{reasoning_effort:"low"}}})],state.options)).toBe(0);
    expect(updateWorkbenchSettings).toHaveBeenCalledWith({command_id:"cmd:settings",expected_revision:1,patch:{model:{reasoning_effort:"low"}}});
  });
});
