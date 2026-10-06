import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it,vi} from "vitest";
import type {AgentRuntime} from "@tracegraph/core";
import {createTraceGraphHost} from "./webserver/index.js";
import {createLocalFetch} from "./local-fetch.js";
import {LocalOwnerAdmission} from "./local-host-upgrade.js";

describe("disconnected private HTTP admission",()=>{
 it("retains a real dispatched handler after socket abort until its business promise settles",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-held-admission-")),socketPath=join(root,"private.sock"),gate=new LocalOwnerAdmission();
  const host=await createTraceGraphHost({runtime:{} as AgentRuntime,projects:[],capabilityToken:"fixture-capability",logger:false,isPrivateLocalRequest:()=>true,mutationLifecycle:{enter(){gate.enter();},leave(){gate.leave();}}});
  let release!:()=>void,completed=false;
  host.app.post("/api/fixture-held",async()=>{await new Promise<void>(done=>{release=done;});completed=true;return {settled:true};});await host.app.ready();
  const server=createServer((request,response)=>host.app.routing(request,response));await new Promise<void>(resolve=>server.listen(socketPath,resolve));const transport=createLocalFetch(socketPath,"fixture-private-token"),abort=new AbortController();
  try{const pending=transport.fetch("http://outlive.local/api/fixture-held",{method:"POST",headers:{authorization:"Bearer fixture-capability",origin:"http://127.0.0.1:4310"},signal:abort.signal}).catch(error=>error);await vi.waitFor(()=>expect(release).toBeTypeOf("function"));expect(gate.activeMutations).toBe(1);abort.abort();await pending;await new Promise(resolve=>setTimeout(resolve,50));expect(completed).toBe(false);expect(gate.activeMutations,"Closing a socket must not grant upgrade quiescence").toBe(1);release();await vi.waitFor(()=>expect(completed).toBe(true));await vi.waitFor(()=>expect(gate.activeMutations).toBe(0));}
  finally{release?.();transport.close();await host.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
 });
});
