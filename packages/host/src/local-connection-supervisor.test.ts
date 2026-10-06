import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {LocalHostConnectionSupervisor} from "./local-connection-supervisor.js";
import type {ConnectedLocalHost,LocalHostStatus} from "./local-host.js";
import {HostConnectionSnapshotSchema} from "@tracegraph/contracts";
import {TraceGraphHttpError,TraceGraphMutationPreflightError} from "@tracegraph/sdk";

function fixture(profileId=randomUUID(),nonce=randomUUID(),pid=12345) {
  const status:LocalHostStatus={protocol_version:"outlive.local-host.v1",profile_id:profileId,profile_root:"/isolated-supervisor",data_root:"/isolated-supervisor/data",session_root:"/isolated-supervisor/sessions",pid,boot_nonce:nonce,http_address:"http://127.0.0.1:49123"};
  const value={status,client:{replayActive:false,bootstrap:vi.fn(async()=>({token:"synthetic-private-fixture"}))},probe:vi.fn(async()=>undefined),close:vi.fn(async()=>undefined),stop:vi.fn(async()=>undefined),native:{}} as unknown as ConnectedLocalHost;
  return value;
}
const absent=()=>Object.assign(new Error("isolated missing owner"),{code:"ENOENT"});
describe("local owner connection authority",()=>{
  it("preserves an authoritative admission rejection without upgrading it to an unknown write or retry",async()=>{
    const owner=fixture();const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",identity:async()=>owner.status,connect:async()=>owner,stopped:async()=>false});
    try{await supervisor.initialize();for(const error of [new TraceGraphHttpError(401,"Auth rejected",{error:"capability_invalid"}),new TraceGraphMutationPreflightError()]){const command=vi.fn(async()=>{throw error;});await expect(supervisor.mutate(command)).rejects.toBe(error);expect(command).toHaveBeenCalledOnce();}expect(owner.client.bootstrap).not.toHaveBeenCalled();}
    finally{await supervisor.close();}
  });
  it("rebinds an external owner replacement once and drops a late old-owner read",async()=>{
    let owner=fixture();const first=owner;const bind=vi.fn();const detach=vi.fn();
    const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",identity:async()=>owner.status,connect:async()=>owner,stopped:async()=>false,onRebind:bind,onDisconnect:detach,pollIntervalMs:60_000});
    try {
      await supervisor.initialize();let release!:(value:string)=>void;
      const pending=supervisor.read(()=>new Promise<string>(done=>{release=done;}));
      await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
      owner=fixture(first.status.profile_id);await supervisor.refresh();release("obsolete data");
      await expect(pending).rejects.toMatchObject({code:"host_read_stale"});
      expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:2,owner_nonce:owner.status.boot_nonce});
      expect(first.close).toHaveBeenCalledOnce();expect(bind).toHaveBeenCalledTimes(2);expect(detach).toHaveBeenCalledTimes(2);
      await supervisor.refresh();expect(bind).toHaveBeenCalledTimes(2);
    }finally{await supervisor.close();}
  });
  it("reports a lost mutation result without resubmitting the write",async()=>{
    const owner=fixture();const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",identity:async()=>owner.status,connect:async()=>owner,stopped:async()=>false});
    try{await supervisor.initialize();const write=vi.fn(async()=>{throw Object.assign(new Error("lost receipt"),{code:"ECONNRESET"});});await expect(supervisor.mutate(write)).rejects.toMatchObject({code:"host_write_outcome_unknown"});expect(write).toHaveBeenCalledOnce();}
    finally{await supervisor.close();}
  });
  it("retains replay authority after replacement until an explicit replay exit",async()=>{
    let owner=fixture();const initial=owner;const ensure=vi.fn();const connect=vi.fn(async()=>owner);const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",identity:async()=>owner.status,connect,ensure,stopped:async()=>false});
    try{await supervisor.initialize();Object.defineProperty(initial.client,"replayActive",{value:true,writable:true});owner=fixture(initial.status.profile_id);await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"offline",code:"host_replay_stale",generation:1});expect(supervisor.retainedConnection).toBe(initial);expect(connect).toHaveBeenCalledOnce();expect(ensure).not.toHaveBeenCalled();await expect(supervisor.mutate(async()=>"write")).rejects.toMatchObject({code:"host_replay_stale"});Object.defineProperty(initial.client,"replayActive",{value:false});await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:2});}
    finally{await supervisor.close();}
  });
  it("keeps an explicit stop stopped, including a fresh client, until repair is explicit",async()=>{
    const owner=fixture();const ensure=vi.fn(async()=>owner);const connect=vi.fn(async()=>owner);let stopped=true;const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",identity:async()=>{throw absent();},connect,ensure,stopped:async()=>stopped});
    try{await supervisor.initialize();await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"stopped",generation:0});expect(connect).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();ensure.mockImplementationOnce(async options=>{expect(options.recoveryMode).toBe(false);stopped=false;return owner;});await supervisor.repair();expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:1});}
    finally{await supervisor.close();}
  });
  it("does not race automatic recovery with a profile migration transaction",async()=>{
    const owner=fixture();const ensure=vi.fn(async()=>owner);const connect=vi.fn(async()=>owner);const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",identity:async()=>owner.status,connect,ensure,stopped:async()=>false});
    try{await supervisor.initialize();const release=await supervisor.pause();(owner.probe as ReturnType<typeof vi.fn>).mockRejectedValue(absent());await supervisor.refresh();expect(connect).toHaveBeenCalledOnce();expect(ensure).not.toHaveBeenCalled();release();}
    finally{await supervisor.close();}
  });
  it("fails closed for another profile or installed build",async()=>{
    const build="a".repeat(64);const owner=fixture();Object.assign(owner.status,{product_build_id:"b".repeat(64)});const ensure=vi.fn();const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",productBuildId:build,identity:async()=>owner.status,connect:async()=>owner,ensure,stopped:async()=>false});
    try{await supervisor.initialize();expect(supervisor.getSnapshot()).toMatchObject({state:"upgrade-required",code:"host_upgrade_required",generation:0});expect(ensure).not.toHaveBeenCalled();expect(owner.close).toHaveBeenCalledOnce();}
    finally{await supervisor.close();}
  });
  it("does not reverse-upgrade a previously bound client, even if the foreign owner rotates its nonce",async()=>{
    const build="a".repeat(64);let owner=fixture();Object.assign(owner.status,{product_build_id:build});const first=owner,ensure=vi.fn();
    const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",productBuildId:build,identity:async()=>owner.status,connect:async()=>owner,ensure,stopped:async()=>false});
    try{await supervisor.initialize();expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:1});owner=fixture(first.status.profile_id);Object.assign(owner.status,{product_build_id:"b".repeat(64)});await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"upgrade-required",generation:1});expect(ensure).not.toHaveBeenCalled();expect(supervisor.retainedConnection).toBe(first);Object.defineProperty(first.client,"replayActive",{value:true});await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"offline",code:"host_replay_stale",generation:1});expect(ensure).not.toHaveBeenCalled();}
    finally{await supervisor.close();}
  });
  it("public connection schema rejects bearer, socket and filesystem fields",()=>{
    expect(HostConnectionSnapshotSchema.safeParse({state:"connected",generation:1,token:"forbidden"}).success).toBe(false);
    expect(HostConnectionSnapshotSchema.safeParse({state:"connected",generation:1,socket_path:"forbidden"}).success).toBe(false);
    expect(HostConnectionSnapshotSchema.safeParse({state:"connected",generation:1,profile_root:"forbidden"}).success).toBe(false);
  });
  it("does not spend the crash budget on successful first startup or authenticated planned socket gaps",async()=>{
    const clock=vi.spyOn(Date,"now");let now=10_000;clock.mockImplementation(()=>now);
    let owner=fixture(),nextOwner=owner,gap=true;const initial=owner;
    const ensure=vi.fn(async()=>{owner=nextOwner;gap=false;return owner;});
    const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",pollIntervalMs:60_000,recoveryAttempts:2,stopped:async()=>false,identity:async()=>{if(gap)throw absent();return owner.status;},connect:async()=>{if(gap)throw absent();return owner;},ensure});
    const replace=async(pid:number)=>{(owner.probe as ReturnType<typeof vi.fn>).mockRejectedValue(absent());nextOwner=fixture(initial.status.profile_id,randomUUID(),pid);gap=true;now+=5_000;await supervisor.refresh();};
    try{
      await supervisor.initialize();expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:1});
      // A previous real crash remains charged even when planned replacements succeed.
      await replace(initial.status.pid+1);expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:2});
      for(let cycle=0;cycle<3;cycle++){await replace(initial.status.pid+1);expect(supervisor.getSnapshot(),`planned replacement ${cycle} must refund only its own successful ensure`).toMatchObject({state:"connected",generation:3+cycle});}
      await replace(initial.status.pid+2);expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:6});
      await replace(initial.status.pid+3);expect(supervisor.getSnapshot()).toMatchObject({state:"offline",code:"host_recovery_exhausted",generation:6});
      expect(ensure).toHaveBeenCalledTimes(6);
    }finally{await supervisor.close();clock.mockRestore();}
  });
  it("keeps failed initial startup attempts bounded instead of refunding unvalidated owners",async()=>{
    const clock=vi.spyOn(Date,"now");let now=10_000;clock.mockImplementation(()=>now);
    const ensure=vi.fn(async()=>{throw absent();});
    const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",pollIntervalMs:60_000,recoveryAttempts:2,stopped:async()=>false,identity:async()=>{throw absent();},connect:async()=>{throw absent();},ensure});
    try{
      await supervisor.initialize();expect(supervisor.getSnapshot()).toMatchObject({state:"offline",generation:0,code:"host_offline"});
      now+=5_000;await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"offline",generation:0,code:"host_offline"});
      now+=5_000;await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"offline",generation:0,code:"host_recovery_exhausted"});expect(ensure).toHaveBeenCalledTimes(2);
    }finally{await supervisor.close();clock.mockRestore();}
  });
  it("does not spend the remaining crash budget when the authenticated live owner is unchanged",async()=>{
    const clock=vi.spyOn(Date,"now");let now=10_000;clock.mockImplementation(()=>now);
    let owner=fixture(),nextOwner=owner,gap=false;const initial=owner,bind=vi.fn();
    const ensure=vi.fn(async()=>{owner=nextOwner;gap=false;return owner;});
    const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",pollIntervalMs:60_000,recoveryAttempts:2,stopped:async()=>false,identity:async()=>{if(gap)throw absent();return owner.status;},connect:async()=>{if(gap)throw absent();return owner;},ensure,onRebind:bind});
    const handshake=async(pid:number,nonce=randomUUID())=>{nextOwner=fixture(initial.status.profile_id,nonce,pid);gap=true;now+=5_000;await supervisor.refresh();};
    try{
      await supervisor.initialize();await handshake(initial.status.pid+1);expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:2});
      for(let cycle=0;cycle<3;cycle++){const nonce=owner.status.boot_nonce;await handshake(initial.status.pid+1,nonce);expect(supervisor.getSnapshot(),`unchanged authenticated handshake ${cycle} must refund only its charge`).toMatchObject({state:"connected",generation:2,owner_nonce:nonce});expect(nextOwner.close).toHaveBeenCalledOnce();}
      await handshake(initial.status.pid+2);expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:3});
      await handshake(initial.status.pid+3);expect(supervisor.getSnapshot()).toMatchObject({state:"offline",code:"host_recovery_exhausted",generation:3});expect(ensure).toHaveBeenCalledTimes(5);expect(bind).toHaveBeenCalledTimes(3);
    }finally{await supervisor.close();clock.mockRestore();}
  });
  it("does not refund a same-process replacement with another profile or product build",async()=>{
    const clock=vi.spyOn(Date,"now");let now=10_000;clock.mockImplementation(()=>now);
    try{
      for(const invalid of ["profile","build"]){
        const build="a".repeat(64),owner=fixture();Object.assign(owner.status,{product_build_id:build});
        const replacement=fixture(invalid==="profile"?randomUUID():owner.status.profile_id);Object.assign(replacement.status,{product_build_id:invalid==="build"?"b".repeat(64):build});
        let gap=false;const ensure=vi.fn(async()=>replacement);
        const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",productBuildId:build,pollIntervalMs:60_000,recoveryAttempts:1,stopped:async()=>false,identity:async()=>{if(gap)throw absent();return owner.status;},connect:async()=>{if(gap)throw absent();return owner;},ensure});
        try{
          await supervisor.initialize();gap=true;now+=5_000;await supervisor.refresh();
          expect(supervisor.getSnapshot()).toMatchObject({state:invalid==="build"?"upgrade-required":"offline",generation:1,code:invalid==="build"?"host_upgrade_required":"host_profile_invalid"});
          now+=5_000;await supervisor.refresh();expect(supervisor.getSnapshot()).toMatchObject({state:"offline",generation:1,code:"host_recovery_exhausted"});expect(ensure).toHaveBeenCalledOnce();expect(replacement.close).toHaveBeenCalledOnce();
        }finally{await supervisor.close();}
      }
    }finally{clock.mockRestore();}
  });
  it("bounds repeated crash recovery and preserves the authenticated gateway for explicit repair",async()=>{
    const clock=vi.spyOn(Date,"now");let now=10_000;clock.mockImplementation(()=>now);
    let owner=fixture();let crashed=false;const initial=owner;
    const ensure=vi.fn(async()=>{owner=fixture(initial.status.profile_id,randomUUID(),owner.status.pid+1);crashed=false;return owner;});
    const supervisor=new LocalHostConnectionSupervisor({profileRoot:"/isolated-supervisor",pollIntervalMs:60_000,recoveryAttempts:2,stopped:async()=>false,identity:async()=>{if(crashed)throw absent();return owner.status;},connect:async()=>{if(crashed)throw absent();return owner;},ensure});
    try{
      await supervisor.initialize();
      for(let cycle=0;cycle<2;cycle++){crashed=true;(owner.probe as ReturnType<typeof vi.fn>).mockRejectedValue(absent());now+=5_000;await supervisor.refresh();expect(supervisor.getSnapshot().state).toBe("connected");}
      crashed=true;(owner.probe as ReturnType<typeof vi.fn>).mockRejectedValue(absent());now+=5_000;await supervisor.refresh();
      expect(supervisor.getSnapshot()).toMatchObject({state:"offline",code:"host_recovery_exhausted",generation:3});expect(ensure).toHaveBeenCalledTimes(2);
      await supervisor.repair();expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:4});
      expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({httpPort:49123,recoveryMode:false}));
    }finally{await supervisor.close();clock.mockRestore();}
  });
});
