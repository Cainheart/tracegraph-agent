import {readdir,lstat} from "node:fs/promises";
import {join} from "node:path";
import {z} from "zod";
import {IdentifierSchema,ModelCapabilityTestResultSchema,type SessionEvent} from "@tracegraph/contracts";
import {ActionWal,JsonlEventLedger,projectRun} from "@tracegraph/core";
import {WorkbenchJournal,workbenchError} from "./workbench-journal.js";

export const PrepareLocalUpgradeSchema=z.object({command_id:IdentifierSchema,profile_id:z.string().uuid(),owner_nonce:z.string().uuid(),source_build_id:z.string().regex(/^[a-f0-9]{64}$/u),target_build_id:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export type PrepareLocalUpgrade=z.infer<typeof PrepareLocalUpgradeSchema>;
export const LocalUpgradeReceiptSchema=PrepareLocalUpgradeSchema.extend({state:z.enum(["prepared","retired"])}).strict();
export type LocalUpgradeReceipt=z.infer<typeof LocalUpgradeReceiptSchema>;

/** Synchronous authority gate. A socket closing does not settle its handler. */
export class LocalOwnerAdmission {
  #state:"open"|"checking"|"sealed"="open";
  #mutations=0;
  get state(){return this.#state;}
  get activeMutations(){return this.#mutations;}
  assertOpen(){if(this.#state!=="open")throw workbenchError("host_upgrade_in_progress","The installed application is waiting for the current Host to retire. Read its connection status before sending new work.");}
  enter(explicitStop=false){if(!explicitStop)this.assertOpen();this.#mutations++;}
  leave(){this.#mutations=Math.max(0,this.#mutations-1);}
  begin(){this.assertOpen();this.#state="checking";}
  reopen(){if(this.#state==="checking")this.#state="open";}
  seal(){this.#state="sealed";}
}

/** Private canonical lifecycle receipts. No paths or executable authority cross this seam. */
export class LocalOwnerUpgrade {
  readonly journal:WorkbenchJournal;
  #prepared:PrepareLocalUpgrade|undefined;
  constructor(readonly profileRoot:string,readonly profileId:string,readonly ownerNonce:string,readonly sourceBuildId:string|undefined,readonly admission:LocalOwnerAdmission){this.journal=new WorkbenchJournal(join(profileRoot,"owner-upgrade-events"));}
  async initialize(){
    await this.journal.initialize();
    const prepared=new Map<string,LocalUpgradeReceipt>(),retired=new Set<string>();let streams=0;
    for await(const ids of this.journal.ledger.iterateRunIdBatches(32))for(const id of ids){
      if(++streams>1000)throw workbenchError("host_upgrade_inspection_limit","Upgrade history exceeds the bounded inspection limit.",413);
      const events=await this.journal.ledger.listBounded(id,{maxBytes:64*1024,maxEvents:10});
      if(events.some(event=>event.type==="workbench.command_requested")&&!events.some(event=>event.type==="workbench.command_completed"))throw workbenchError("host_upgrade_outcome_unknown","An earlier upgrade has no verified receipt. Preserve this profile and inspect its original command before starting another owner.",503);
      for(const event of events){
        if(event.type!=="workbench.command_completed")continue;
        const receipt=LocalUpgradeReceiptSchema.parse(event.data.result);
        if(receipt.profile_id!==this.profileId)throw workbenchError("host_upgrade_identity_changed","Upgrade history belongs to a different profile.");
        if(receipt.state==="prepared")prepared.set(receipt.command_id,receipt);else retired.add(receipt.command_id);
      }
    }
    for(const id of prepared.keys())if(!retired.has(id))throw workbenchError("host_upgrade_outcome_unknown","The previous owner did not verify complete resource retirement. No new Runtime was started; inspect the original upgrade receipt.",503);
  }
  async prepare(value:unknown,inspect:()=>Promise<void>,pause:()=>{busy:boolean;resume():void}):Promise<LocalUpgradeReceipt>{
    const input=PrepareLocalUpgradeSchema.parse(value);
    if(input.profile_id!==this.profileId||input.owner_nonce!==this.ownerNonce||input.source_build_id!==this.sourceBuildId||input.source_build_id===input.target_build_id)throw workbenchError("host_upgrade_identity_changed","The Host identity changed; inspect the current connection before upgrading.",409);
    this.admission.begin();let producer:{busy:boolean;resume():void}|undefined;let recording=false;
    try{
      producer=pause();
      if(this.admission.activeMutations>0)throw workbenchError("host_upgrade_busy","An admitted command is still settling. The old Host remains running; the application will wait for a safe idle point.");
      if(producer.busy)throw workbenchError("host_upgrade_busy","Background work or an owned resource is still settling. The old Host remains running; the application will wait for a safe idle point.");
      let prior=0;
      for await(const ids of this.journal.ledger.iterateRunIdBatches(32))for(const id of ids){
        if(++prior>1000)throw workbenchError("host_upgrade_inspection_limit","Upgrade history requires bounded maintenance before another automatic replacement.",413);
        const events=await this.journal.ledger.listBounded(id,{maxBytes:64*1024,maxEvents:10});
        for(const event of events){if(event.type!=="workbench.command_completed"||event.data.operation!=="host.upgrade.retired")continue;const retired=LocalUpgradeReceiptSchema.parse(event.data.result);if(retired.source_build_id===input.target_build_id)throw workbenchError("host_upgrade_rollback_blocked","This application build was already retired. Open the updated application; automatic downgrade is not allowed.");}
      }
      await inspect();
      // Nothing admitted after begin can pass the same synchronous gate.
      if(this.admission.activeMutations>0)throw workbenchError("host_upgrade_busy","An admitted command is still settling; the old Host remains running.");
      recording=true;
      const receipt=await this.journal.once(input.command_id,"host.upgrade.prepare",input,async()=>({...input,state:"prepared" as const}));
      this.#prepared=input;this.admission.seal();return LocalUpgradeReceiptSchema.parse(receipt);
    }catch(error){
      if(recording){this.admission.seal();throw workbenchError("host_upgrade_outcome_unknown","Upgrade preparation has no verified receipt. The old process is preserved; inspect its canonical receipt before further action.",503);}
      producer?.resume();this.admission.reopen();throw error;
    }
  }
  /** Called after all resources/discovery settle, before the exclusive owner leases retire. */
  async recordRetired(){if(!this.#prepared)return;const input=this.#prepared;await this.journal.once(`${input.command_id}:retired`,"host.upgrade.retired",input,async()=>({...input,state:"retired" as const}));}
  status(){return {state:this.admission.state,...(this.#prepared?{receipt:LocalUpgradeReceiptSchema.parse({...this.#prepared,state:"prepared"})}:{})};}
  async receipt(commandId:string){return this.journal.inspect(IdentifierSchema.parse(commandId));}
}

const unsafeResult=(value:unknown):boolean=>Boolean(value&&typeof value==="object"&&["unknown"].includes(String((value as {status?:unknown;state?:unknown}).status??(value as {state?:unknown}).state)));
const unknownCode=(value:unknown)=>typeof value==="string"&&/(?:unknown|unsettled|unquiescent|not_quiescent)/u.test(value);

/** All registered journals are bounded and inspected, never reconciled or executed. */
export async function assertSettledLocalFacts(profileRoot:string,dataRoot:string):Promise<void>{
  const directories=[join(dataRoot,"events"),...['workbench-events','conversation-events','goal-command-events','project-file-events','skill-management-events','computer-events','visual-evidence-events','personal-command-events','model-capability-events'].map(name=>join(profileRoot,name))];
  const walRoot=join(dataRoot,"wal");
  try{
    const entries=await readdir(walRoot,{withFileTypes:true});let walBytes=0;
    if(entries.length>10_000)throw workbenchError("host_upgrade_inspection_limit","Action WAL inventory exceeds the automatic inspection limit.",413);
    for(const entry of entries){if(entry.isSymbolicLink())throw workbenchError("host_upgrade_facts_unavailable","Action WAL contains an unsafe reference.",503);if(entry.isFile()){walBytes+=(await lstat(join(walRoot,entry.name))).size;if(walBytes>64*1024*1024)throw workbenchError("host_upgrade_inspection_limit","Action WAL requires bounded maintenance before an upgrade.",413);}}
    if((await new ActionWal(walRoot).pending()).length)throw workbenchError("host_upgrade_unknown_effect","An Action WAL boundary is not verified or aborted. Inspect it without executing the old action before upgrading.");
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"){if((error as {code?:string}).code?.startsWith("host_upgrade_"))throw error;throw workbenchError("host_upgrade_facts_unavailable","Action WAL state could not be authenticated. The old owner is preserved.",503);}}
  let streams=0,eventsRead=0,bytes=0;
  for(const directory of directories){
    const ledger=new JsonlEventLedger(directory);
    try{
      for await(const ids of ledger.iterateRunIdBatches(32))for(const id of ids){
        if(++streams>10_000)throw workbenchError("host_upgrade_inspection_limit","This profile needs bounded history maintenance before an automatic upgrade.",413);
        const events=await ledger.listBounded(id,{maxBytes:8*1024*1024,maxEvents:20_000});eventsRead+=events.length;bytes+=Buffer.byteLength(JSON.stringify(events));
        if(eventsRead>100_000||bytes>64*1024*1024)throw workbenchError("host_upgrade_inspection_limit","History exceeds the automatic upgrade inspection limit. The old Host is preserved.",413);
        assertSettledEventStream(events);
      }
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;if((error as {code?:string}).code?.startsWith("host_upgrade_"))throw error;throw workbenchError("host_upgrade_facts_unavailable","Saved task or command facts could not be fully verified. The old Host is preserved.",503);}
  }
}

export function assertSettledEventStream(events:readonly SessionEvent[]):void{
  if(events.some(event=>event.type==="run.created")){
    const projection=projectRun(events);
    if(!["completed","failed","cancelled","interrupted"].includes(projection.status))throw workbenchError("host_upgrade_run_active","A saved Run is active, resumed, or awaiting approval. Finish or explicitly stop its work before upgrading.");
  }
  const requests=new Map<string,SessionEvent>(),tools=new Map<string,SessionEvent>(),unknown=new Map<string,SessionEvent>();
  for(const event of events){
    const receipt=event.data.receipt as {business_status?:unknown;action_id?:unknown}|undefined;
    const action=event.action_id??(typeof receipt?.action_id==="string"?receipt.action_id:undefined)??(typeof event.data.action_id==="string"?event.data.action_id:undefined)??event.operation_id;
    const key=action?`action:${action}`:event.operation_id?`operation:${event.operation_id}`:`unscoped:${event.event_id}`;
    if(event.type==="action.reconciled"&&action&&["applied","not_applied"].includes(String(event.data.outcome))){unknown.delete(`action:${action}`);tools.delete(action);}
    if(event.data.reconciled===true&&event.type==="workbench.command_completed"&&!unsafeResult(event.data.result)&&event.operation_id)unknown.delete(`action:${event.operation_id}`);
    if(event.data.operation==="models.capabilities.test"&&event.type==="workbench.command_completed"){
      const result=ModelCapabilityTestResultSchema.safeParse(event.data.result);
      if(!result.success||result.data.command_id!==event.operation_id)throw workbenchError("host_upgrade_facts_unavailable","Saved model capability tests could not be verified.",503);
      // This closed operation does not invoke tools or mutate project files. Its
      // completed receipt means the network request and canonical append settled;
      // unknown capability/usage remains in that receipt, never a write lock.
      // Current request/projection work is separately held by controller.pending.
      requests.delete(event.operation_id);continue;
    }
    if(event.type==="tool.unknown"||receipt?.business_status==="unknown"||unsafeResult(event.data.result)||unknownCode(event.data.code)||unknownCode((event.data.result as {code?:unknown}|undefined)?.code))unknown.set(key,event);
    if(event.type==="workbench.command_requested")requests.set(event.operation_id??event.event_id,event);
    if(event.type==="workbench.command_completed"||event.type==="workbench.command_failed")requests.delete(event.operation_id??event.event_id);
    if(event.type==="tool.started")tools.set(action??`unscoped:${event.event_id}`,event);
    if(["tool.completed","tool.failed","tool.unknown"].includes(event.type)&&action)tools.delete(action);
  }
  if(unknown.size)throw workbenchError("host_upgrade_unknown_effect","An unresolved command or external effect requires inspection. The old Host is preserved.");
  if(requests.size||tools.size)throw workbenchError("host_upgrade_command_unsettled","A command or tool has no settled canonical receipt. The old Host is preserved.");
}
