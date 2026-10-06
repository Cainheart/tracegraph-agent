import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it,vi} from "vitest";
import {ActionWal,sha256,JsonlEventLedger} from "@tracegraph/core";
import {LocalOwnerAdmission,LocalOwnerUpgrade,assertSettledEventStream,assertSettledLocalFacts} from "./local-host-upgrade.js";
import {WorkbenchJournal} from "./workbench-journal.js";

const a="a".repeat(64),b="b".repeat(64);
async function fixture(){const root=await mkdtemp(join(tmpdir(),"outlive-upgrade-facts-"));const gate=new LocalOwnerAdmission(),profile=randomUUID(),nonce=randomUUID();const upgrade=new LocalOwnerUpgrade(root,profile,nonce,a,gate);await upgrade.initialize();return {root,gate,upgrade,input:{command_id:`upgrade:${randomUUID()}`,profile_id:profile,owner_nonce:nonce,source_build_id:a,target_build_id:b}};}
describe("private atomic owner upgrade",()=>{
 it("seals admission before asynchronous inspection, rejects a second first-launch client, and records real retirement",async()=>{
  const f=await fixture();let release!:()=>void;const paused=vi.fn(),resume=vi.fn();
  try{const operation=f.upgrade.prepare(f.input,()=>new Promise<void>(done=>{release=done;}),()=>{paused();return {busy:false,resume};});await vi.waitFor(()=>expect(release).toBeTypeOf("function"));expect(()=>f.gate.enter()).toThrow();await expect(f.upgrade.prepare({...f.input,command_id:"upgrade:second"},async()=>{},()=>({busy:false,resume}))).rejects.toMatchObject({code:"host_upgrade_in_progress"});release();expect(await operation).toMatchObject({state:"prepared"});expect(f.gate.state).toBe("sealed");expect(resume).not.toHaveBeenCalled();expect(paused).toHaveBeenCalledOnce();expect((await f.upgrade.receipt(f.input.command_id)).state).toBe("completed");await f.upgrade.recordRetired();expect(await f.upgrade.receipt(`${f.input.command_id}:retired`)).toMatchObject({state:"completed",result:{state:"retired",owner_nonce:f.input.owner_nonce}});}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("keeps admitted or producer work running and reopens the same gate after a busy refusal",async()=>{
  const f=await fixture(),resume=vi.fn(),inspect=vi.fn();
  try{f.gate.enter();await expect(f.upgrade.prepare(f.input,inspect,()=>({busy:false,resume}))).rejects.toMatchObject({code:"host_upgrade_busy"});expect(f.gate.state).toBe("open");expect(f.gate.activeMutations).toBe(1);expect(inspect).not.toHaveBeenCalled();f.gate.leave();await expect(f.upgrade.prepare(f.input,inspect,()=>({busy:true,resume}))).rejects.toMatchObject({code:"host_upgrade_busy"});expect(f.gate.state).toBe("open");expect(resume).toHaveBeenCalledTimes(2);expect((await f.upgrade.receipt(f.input.command_id)).state).toBe("not_found");}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("never starts a replacement from a prepared-only receipt and blocks a retired build downgrade",async()=>{
  const f=await fixture();
  try{await f.upgrade.prepare(f.input,async()=>{},()=>({busy:false,resume(){}}));const replacement=new LocalOwnerUpgrade(f.root,f.input.profile_id,randomUUID(),b,new LocalOwnerAdmission());await expect(replacement.initialize()).rejects.toMatchObject({code:"host_upgrade_outcome_unknown"});await f.upgrade.recordRetired();await replacement.initialize();await expect(replacement.prepare({...f.input,command_id:"upgrade:reverse",owner_nonce:replacement.ownerNonce,source_build_id:b,target_build_id:a},async()=>{},()=>({busy:false,resume(){}}))).rejects.toMatchObject({code:"host_upgrade_rollback_blocked"});expect(replacement.admission.state).toBe("open");}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("keeps a failed canonical commit sealed instead of manufacturing idle or replaying effects",async()=>{
  const f=await fixture(),resume=vi.fn();
  try{vi.spyOn(f.upgrade.journal,"once").mockRejectedValue(new Error("fixture durable append failure"));await expect(f.upgrade.prepare(f.input,async()=>{},()=>({busy:false,resume}))).rejects.toMatchObject({code:"host_upgrade_outcome_unknown"});expect(f.gate.state).toBe("sealed");expect(resume).not.toHaveBeenCalled();expect(()=>f.gate.enter()).toThrow();expect(()=>f.gate.enter(true)).not.toThrow();f.gate.leave();}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("inspects actual terminal/tool events and unsettled command journals without invoking reconciliation",async()=>{
  const f=await fixture();const dataRoot=join(f.root,"data"),ledger=new JsonlEventLedger(join(dataRoot,"events"));await ledger.initialize();const scope={project_id:"project:fixture",run_id:"run:fixture",operation_id:"action:fixture",attempt:0,artifact_refs:[]};
  try{await ledger.append({...scope,type:"run.created",summary:"Created fixture",data:{}});await ledger.append({...scope,type:"tool.started",summary:"Started fixture",data:{}});await ledger.append({...scope,type:"run.interrupted",summary:"Interrupted fixture",data:{}});await expect(assertSettledLocalFacts(f.root,dataRoot)).rejects.toMatchObject({code:"host_upgrade_command_unsettled"});await ledger.append({...scope,type:"tool.completed",summary:"Settled fixture",data:{receipt:{business_status:"success"}}});await assertSettledLocalFacts(f.root,dataRoot);const journal=new WorkbenchJournal(join(f.root,"project-file-events"));await journal.initialize();let release!:()=>void;const effect=journal.once("file:held","file.save",{},()=>new Promise<void>(done=>{release=done;}));await vi.waitFor(()=>expect(release).toBeTypeOf("function"));await expect(assertSettledLocalFacts(f.root,dataRoot)).rejects.toMatchObject({code:"host_upgrade_command_unsettled"});release();await effect;await assertSettledLocalFacts(f.root,dataRoot);await ledger.append({...scope,type:"tool.failed",summary:"Unknown external effect",data:{receipt:{business_status:"unknown"}}});expect(()=>assertSettledEventStream([])).not.toThrow();await expect(assertSettledLocalFacts(f.root,dataRoot)).rejects.toMatchObject({code:"host_upgrade_unknown_effect"});}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("keeps parallel canonical action IDs distinct and accepts only exact later reconciliation",async()=>{
  const f=await fixture(),ledger=new JsonlEventLedger(join(f.root,"parallel"));await ledger.initialize();const scope={project_id:"fixture:parallel",run_id:"run:parallel",attempt:0,artifact_refs:[]};
  try{await ledger.append({...scope,type:"run.created",summary:"Parallel fixture",data:{task:"Inspect two tools",mode:"execute"}});for(const action_id of ["action:first","action:second"])await ledger.append({...scope,type:"tool.started",action_id,summary:"Start tool",data:{}});await ledger.append({...scope,type:"tool.completed",action_id:"action:first",summary:"First settled",data:{}});await ledger.append({...scope,type:"run.interrupted",summary:"Pause fixture",data:{}});let events=await ledger.list(scope.run_id);expect(()=>assertSettledEventStream(events)).toThrowError(expect.objectContaining({code:"host_upgrade_command_unsettled"}));await ledger.append({...scope,type:"tool.unknown",action_id:"action:second",summary:"Second outcome unknown",data:{}});await ledger.append({...scope,type:"action.reconciled",action_id:"action:first",summary:"Wrong action reconciled",data:{outcome:"not_applied"}});events=await ledger.list(scope.run_id);expect(()=>assertSettledEventStream(events)).toThrowError(expect.objectContaining({code:"host_upgrade_unknown_effect"}));await ledger.append({...scope,type:"action.reconciled",action_id:"action:second",summary:"Exact second action reconciled",data:{outcome:"not_applied"}});assertSettledEventStream(await ledger.list(scope.run_id));await ledger.append({...scope,type:"run.resumed",summary:"Resumed after old terminal",data:{restored_status:"running"}});events=await ledger.list(scope.run_id);expect(()=>assertSettledEventStream(events)).toThrowError(expect.objectContaining({code:"host_upgrade_run_active"}));}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("retains original unknown commands until their own explicit reconciled receipt, and authenticates pending WAL",async()=>{
  const f=await fixture(),data=join(f.root,"data"),ledger=new JsonlEventLedger(join(f.root,"commands"));await ledger.initialize();const scope={project_id:"fixture:commands",run_id:"command:original",operation_id:"save:original",attempt:0,artifact_refs:[]};
  try{await ledger.append({...scope,type:"workbench.command_requested",summary:"Requested original",data:{}});await ledger.append({...scope,type:"workbench.command_completed",summary:"Unknown original",data:{result:{status:"unknown"}}});await ledger.append({...scope,operation_id:"save:other",type:"workbench.command_completed",summary:"Different command reconciled",data:{reconciled:true,result:{status:"failed"}}});let events=await ledger.list(scope.run_id);expect(()=>assertSettledEventStream(events)).toThrowError(expect.objectContaining({code:"host_upgrade_unknown_effect"}));await ledger.append({...scope,type:"workbench.command_completed",summary:"Original inspected without replay",data:{reconciled:true,result:{status:"failed",code:"reconciled_not_applied"}}});assertSettledEventStream(await ledger.list(scope.run_id));const wal=new ActionWal(join(data,"wal"));await wal.prepareAction({projectId:"fixture:wal",runId:"run:orphan",actionId:"action:wal",workspaceHandleId:"workspace:wal",workspaceRootHash:sha256("root"),workspaceKind:"disposable_fixture",patchHash:sha256("after"),targets:[{targetPath:"file.txt",existed:false,afterHash:sha256("after")} ]});await expect(assertSettledLocalFacts(f.root,data)).rejects.toMatchObject({code:"host_upgrade_unknown_effect"});await wal.advance({runId:"run:orphan",actionId:"action:wal",phase:"aborted",reason:"Actual before image was retained"});await assertSettledLocalFacts(f.root,data);}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("rejects forged identity and executable/path vocabulary before pausing any producer",async()=>{
  const f=await fixture(),pause=vi.fn(()=>({busy:false,resume(){}}));
  try{await expect(f.upgrade.prepare({...f.input,profile_id:randomUUID()},async()=>{},pause)).rejects.toMatchObject({code:"host_upgrade_identity_changed"});await expect(f.upgrade.prepare({...f.input,executable:"/arbitrary/program"},async()=>{},pause)).rejects.toThrow();expect(pause).not.toHaveBeenCalled();expect(f.gate.state).toBe("open");}
  finally{await rm(f.root,{recursive:true,force:true});}
 });
});
