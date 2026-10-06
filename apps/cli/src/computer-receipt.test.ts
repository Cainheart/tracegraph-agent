import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";
import {ComputerControl,type ConnectedLocalHost,type NativeComputerBackend} from "@tracegraph/host";
import type {ComputerTarget} from "@tracegraph/contracts";
import {maybeRunWorkbenchCommand} from "./workbench-command.js";

describe("CLI inspection of a real interrupted command receipt",()=>{
 it("keeps a completed journal with unknown native input unresolved and never repeats its actual fixture disk effect",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-cli-computer-receipt-")),effect=join(root,"external-effect.txt");
  const target:ComputerTarget={application_id:"fixture.owned-app",pid:123,title:"Controlled fixture",identity:"sha256:"+"a".repeat(64),window_id:"window:one"};
  let calls=0,started!:()=>void;const begun=new Promise<void>(resolve=>started=resolve);
  // The native boundary is deterministic; controller, Ledger and external bytes are real.
  // This does not claim that an operating-system mouse or key action was validated.
  const backend:NativeComputerBackend={
   status:async()=>({platform:"darwin",backend_available:true,accessibility:true,screen_capture:true,input_monitoring:true,locked:false}),
   targets:async()=>[target],validateTarget:async()=>undefined,focusTarget:async()=>undefined,
   inspect:async()=>({elements:[],truncated:false}),capture:async()=>new Uint8Array(),watch:async()=>({close:async()=>undefined}),close:async()=>undefined,
   act:async(_target,_action,signal)=>{calls++;await writeFile(effect,"Posted before uncertain handback\n");await new Promise<void>((_,reject)=>{signal.addEventListener("abort",()=>reject(new Error("Interrupted after effect")),{once:true});started();});},
  };
  const control=await ComputerControl.create({profileRoot:root,backend,answerGrant:async()=>"allow",confirmInputLease:async()=>true});
  try{
   const grant=await control.requestGrant({command_id:"grant:fixture",target,duration:"always"}),lease=await control.acquireLease({command_id:"lease:fixture",grant_id:grant.grant_id,target,seconds:300});
   const input={command_id:"input:uncertain",lease_id:lease.lease_id,expected_generation:0,action:{kind:"type" as const,text:"Controlled test"}};
   const operation=control.act(input);await begun;await control.revokeGrant({command_id:"revoke:fixture",grant_id:grant.grant_id});expect(await operation).toMatchObject({status:"unknown"});
   expect(await control.reconcile(input.command_id)).toMatchObject({state:"completed",result:{command_id:input.command_id,status:"unknown"}});
   const before=await readFile(effect,"utf8"),writes:string[]=[];
   const connection={client:{getComputerCommandReceipt:(id:string)=>control.reconcile(id),getGoalCommandReceipt:async()=>({goal_id:"goal:intentional",command_id:"pause:explicit",state:"completed",result:{status:"paused"}})},close:async()=>undefined} as unknown as ConnectedLocalHost;
   const exit=await maybeRunWorkbenchCommand(["computer","receipt",input.command_id],{connect:async()=>connection,write:value=>writes.push(value),writeError:()=>undefined});
   expect(exit).toBe(3);expect(JSON.parse(writes[0]!)).toMatchObject({state:"completed",result:{status:"unknown"}});expect(await readFile(effect,"utf8")).toBe(before);expect(calls).toBe(1);
   expect(await maybeRunWorkbenchCommand(["goal","receipt","goal:intentional","pause:explicit"],{connect:async()=>connection,write:()=>undefined,writeError:()=>undefined})).toBe(0);
  }finally{await control.close();await rm(root,{recursive:true,force:true});}
 });
});
