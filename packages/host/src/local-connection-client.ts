import type {TraceGraphClient} from "@tracegraph/sdk";
import {HostConnectionError} from "@tracegraph/contracts";
import {LocalHostConnectionSupervisor} from "./local-connection-supervisor.js";
import type {ConnectedLocalHost} from "./local-host.js";

const readMethods=new Set(["getModelCapabilityTestReceipt","bootstrap","listProjects","getImageConfig","listProjectFiles","readProjectFile","reconcileProjectFileSave","getAnswerFeedback","getModelConfig","getWorkbenchSettings","getCapabilities","getWorkbenchResources","getPermissionConfig","getTelemetryStatus","getUsage","listExtensions","listSkills","getMcpStatus","getLspStatus","listMemoryControl","listExperienceCases","listSessions","getSession","getReplayDiff","getModelConnections","getSessionRunOptions","getPermissionGrant","getTodos","getRun","getSubagent","getTeam","getArtifact","getAttachmentContent","getArtifactContent"]);
const streams=new Set(["streamEvents","streamLiveActivities","streamModelSurface"]);
/** CLI receives a typed SDK facade. Every mutation is submitted exactly once. */
export async function supervisedLocalHost(supervisor:LocalHostConnectionSupervisor):Promise<ConnectedLocalHost> {
  const initial=await supervisor.connection();
  const client=new Proxy(initial.client,{get(_target,key){
    const current=supervisor.retainedConnection?.client??initial.client;
    const value=Reflect.get(current,key,current);
    if(key==="exitReplay")return ()=>{current.exitReplay();void supervisor.refresh();};
    if(typeof key!=="string"||typeof value!=="function")return value;
    if(streams.has(key))return (...args:unknown[])=>stream(supervisor,key,args);
    return (...args:unknown[])=>{
      const call=(connection:ConnectedLocalHost)=>(Reflect.get(connection.client,key,connection.client) as (...args:unknown[])=>Promise<unknown>).apply(connection.client,args);
      return readMethods.has(key)?supervisor.read(call):supervisor.mutate(call);
    };
  }}) as TraceGraphClient;
  return {client,get status(){return supervisor.retainedConnection?.status??initial.status;},native:{
    previewMigration:input=>supervisor.read(x=>x.native.previewMigration(input)),
    commitMigration:async input=>{const current=await supervisor.connection();const release=await supervisor.pause();try{return await current.native.commitMigration(input);}finally{release();}},
    migrationResult:id=>supervisor.read(x=>x.native.migrationResult(id)),
    registerProject:input=>supervisor.mutate(x=>x.native.registerProject(input)),
    resolveProjectRoot:id=>supervisor.read(x=>x.native.resolveProjectRoot(id)),
  },close:()=>supervisor.close(),stop:()=>supervisor.mutate(x=>x.stop()),probe:()=>supervisor.read(x=>x.probe())};
}
async function* stream(supervisor:LocalHostConnectionSupervisor,key:string,args:unknown[]):AsyncGenerator<unknown> {
  const supplied=(args[1]??{}) as {signal?:AbortSignal;reconnect?:boolean;afterSequence?:number;afterCursor?:number};
  let cursor=key==="streamModelSurface"?supplied.afterCursor??0:supplied.afterSequence??0;
  let generation:number|undefined;
  while(!supplied.signal?.aborted){
    let connection:ConnectedLocalHost;
    try{connection=await supervisor.connection();}catch(error){if(supplied.reconnect===false||["stopped","upgrade-required"].includes(supervisor.getSnapshot().state)||["host_profile_invalid","host_replay_stale","host_recovery_exhausted"].includes(supervisor.getSnapshot().code??""))throw error;await new Promise(resolve=>setTimeout(resolve,100));continue;}
    const active=supervisor.getSnapshot().generation;
    if(generation!==undefined&&generation!==active&&key!=="streamEvents")cursor=0;
    generation=active;
    const input={...supplied,reconnect:false,...(key==="streamModelSurface"?{afterCursor:cursor}:{afterSequence:cursor})};
    const method=Reflect.get(connection.client,key,connection.client) as (...args:unknown[])=>AsyncIterable<unknown>;
    try {
      for await(const event of method.call(connection.client,args[0],input)){
        if(supplied.signal?.aborted)return;
        if(active!==supervisor.getSnapshot().generation)break;
        const record=event as {sequence?:number;cursor?:number};const next=key==="streamModelSurface"?record.cursor:record.sequence;if(typeof next==="number")cursor=Math.max(cursor,next);
        yield event;
      }
      await supervisor.refresh();
      if(active===supervisor.getSnapshot().generation&&supervisor.getSnapshot().state==="connected")return;
    }catch(error){
      if(supplied.signal?.aborted)return;
      if(supplied.reconnect===false)throw error;
      const code=(error as {code?:string}).code,status=(error as {status?:number}).status;
      if(!["ENOENT","ECONNREFUSED","ECONNRESET","EPIPE","ETIMEDOUT"].includes(code??"")&&status!==401&&!(error instanceof HostConnectionError))throw error;
      await supervisor.refresh();
    }
    if(supplied.reconnect===false)return;
  }
}
