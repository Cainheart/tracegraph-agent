import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {LocalHostConnectionSupervisor} from "./local-connection-supervisor.js";
import {supervisedLocalHost} from "./local-connection-client.js";
import type {ConnectedLocalHost} from "./local-host.js";

describe("CLI supervised typed client",()=>{
  it("routes reads and each explicit write to the current owner without replaying a lost command",async()=>{
    const profile=randomUUID();const first={status:{protocol_version:"outlive.local-host.v1",http_address:"http://127.0.0.1:49123",profile_id:profile,boot_nonce:randomUUID()},probe:vi.fn(async()=>undefined),close:vi.fn(async()=>undefined),client:{getPermissionConfig:vi.fn(async()=>"first"),configurePermissionPreset:vi.fn(async()=>{throw Object.assign(new Error("receipt lost"),{code:"ECONNRESET"});})}} as unknown as ConnectedLocalHost;
    const next={...first,status:{...first.status,boot_nonce:randomUUID()},client:{getPermissionConfig:vi.fn(async()=>"next"),configurePermissionPreset:vi.fn(async()=>"configured")}} as unknown as ConnectedLocalHost;let owner=first;
    const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/synthetic-cli-only",identity:async()=>owner.status,connect:async()=>owner,stopped:async()=>false});
    try{await supervisor.initialize();const consumer=await supervisedLocalHost(supervisor);expect(await consumer.client.getPermissionConfig()).toBe("first");await expect(consumer.client.configurePermissionPreset({preset_key:"read-only",command_id:"original-command"})).rejects.toMatchObject({code:"host_write_outcome_unknown"});expect(first.client.configurePermissionPreset).toHaveBeenCalledOnce();owner=next;await supervisor.refresh();expect(await consumer.client.getPermissionConfig()).toBe("next");expect(consumer.status.boot_nonce).toBe(next.status.boot_nonce);expect(next.client.configurePermissionPreset).not.toHaveBeenCalled();}
    finally{await supervisor.close();}
  });
  it("keeps durable stream sequence while resetting only the volatile activity cursor for a new owner",async()=>{
    const profile=randomUUID();let supervisor:LocalHostConnectionSupervisor;
    const nextEvents=vi.fn(async function*(_id:string,options:{afterSequence:number}){yield {sequence:options.afterSequence+1};});const nextActivities=vi.fn(async function*(_id:string,options:{afterSequence:number}){yield {sequence:options.afterSequence+1};});
    const first={status:{protocol_version:"outlive.local-host.v1",http_address:"http://127.0.0.1:49123",profile_id:profile,boot_nonce:randomUUID()},probe:vi.fn(async()=>undefined),close:vi.fn(async()=>undefined),client:{streamEvents:async function*(){yield {sequence:5};owner=next;await supervisor.refresh();},streamLiveActivities:async function*(){yield {sequence:77};owner=next;await supervisor.refresh();}}} as unknown as ConnectedLocalHost;
    const next={...first,status:{...first.status,boot_nonce:randomUUID()},client:{streamEvents:nextEvents,streamLiveActivities:nextActivities}} as unknown as ConnectedLocalHost;let owner=first;
    supervisor=new LocalHostConnectionSupervisor({profileRoot:"/synthetic-cli-only",identity:async()=>owner.status,connect:async()=>owner,stopped:async()=>false});
    try{await supervisor.initialize();const consumer=await supervisedLocalHost(supervisor);const events=[];for await(const event of consumer.client.streamEvents("fixture-run",{afterSequence:4}))events.push(event);expect(events).toEqual([{sequence:5},{sequence:6}]);expect(nextEvents).toHaveBeenCalledWith("fixture-run",expect.objectContaining({afterSequence:5,reconnect:false}));}
    finally{await supervisor.close();}
    owner=first;supervisor=new LocalHostConnectionSupervisor({profileRoot:"/synthetic-cli-only",identity:async()=>owner.status,connect:async()=>owner,stopped:async()=>false});
    try{await supervisor.initialize();const consumer=await supervisedLocalHost(supervisor);const events=[];for await(const event of consumer.client.streamLiveActivities("fixture-run",{afterSequence:76}))events.push(event);expect(events).toEqual([{sequence:77},{sequence:1}]);expect(nextActivities).toHaveBeenCalledWith("fixture-run",expect.objectContaining({afterSequence:0,reconnect:false}));}
    finally{await supervisor.close();}
  });
});
