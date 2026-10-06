import {createHash} from "node:crypto";
import {JsonlEventLedger,redactSensitiveText} from "@tracegraph/core";
import type {SessionEventProposal} from "@tracegraph/contracts";

export function workbenchError(code:string,message:string,statusCode=409):Error & {code:string;statusCode:number} {
  return Object.assign(new Error(message),{code,statusCode});
}
/** Canonical SessionEvent ledger, not a second event protocol. Unknown effects never auto-replay. */
export class WorkbenchJournal {
  readonly ledger:JsonlEventLedger;
  readonly #pending=new Map<string,{digest:string;result:Promise<unknown>}>();
  constructor(root:string){this.ledger=new JsonlEventLedger(root);}
  async initialize(){await this.ledger.initialize();}
  /** Trusted, bounded verification of projection provenance; never executes it. */
  async verifyCompleted(commandId:string,operation:string,input:unknown):Promise<boolean>{
    const id=`workbench:${createHash("sha256").update(commandId).digest("hex")}`;
    const events=await this.ledger.listBounded(id,{maxBytes:1024*1024,maxEvents:10});
    return events[0]?.type==="workbench.command_requested"&&events[0].data.operation===operation&&events[0].data.digest===createHash("sha256").update(JSON.stringify(input)).digest("hex")&&events.some(event=>event.type==="workbench.command_completed"&&event.data.operation===operation);
  }
  /** Read a durable command receipt without invoking its executor or replaying effects. */
  async inspect(commandId:string):Promise<{command_id:string;state:"not_found"|"unknown"|"failed"|"completed";operation?:string;result?:unknown;code?:string}> {
    const runId=`workbench:${createHash("sha256").update(commandId).digest("hex")}`;
    const events=await this.ledger.list(runId);
    if(!events.length)return {command_id:commandId,state:"not_found"};
    const operation=String(events[0]!.data.operation),completed=events.find(event=>event.type==="workbench.command_completed");
    if(completed)return {command_id:commandId,state:"completed",operation,result:completed.data.result};
    const failed=events.find(event=>event.type==="workbench.command_failed");
    if(failed){const code=String(failed.data.code);return {command_id:commandId,state:code.includes("effect_unknown")||code.includes("launch_unknown")?"unknown":"failed",operation,code};}
    return {command_id:commandId,state:"unknown",operation,code:"effect_unknown"};
  }
  async once<T>(commandId:string,operation:string,input:unknown,execute:()=>Promise<T>):Promise<T> {
    const digest=createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const pending=this.#pending.get(commandId);
    if(pending){if(pending.digest!==digest)throw workbenchError("command_id_conflict","Command identifier was reused with different input");return pending.result as Promise<T>;}
    const result=this.#perform(commandId,operation,digest,execute);
    this.#pending.set(commandId,{digest,result});
    try{return await result;}finally{this.#pending.delete(commandId);}
  }
  async #perform<T>(commandId:string,operation:string,digest:string,execute:()=>Promise<T>):Promise<T> {
    const runId=`workbench:${createHash("sha256").update(commandId).digest("hex")}`;
    const scope={run_id:runId,project_id:"workbench:profile",operation_id:commandId,attempt:0,artifact_refs:[]};
    const existing=await this.ledger.list(runId);
    if(existing.length){
      if(existing[0]?.data.digest!==digest)throw workbenchError("command_id_conflict","Command identifier was reused with different input");
      const receipt=existing.find(event=>event.type==="workbench.command_completed");
      if(receipt)return receipt.data.result as T;
      const failed=existing.find(event=>event.type==="workbench.command_failed");
      if(failed)throw workbenchError(String(failed.data.code),failed.summary);
      throw workbenchError("effect_unknown","The previous Host stopped before recording a receipt. Inspect external state before issuing a new command");
    }
    await this.ledger.append({...scope,type:"workbench.command_requested",summary:`Requested ${operation}`,data:{operation,digest},idempotency_key:`${commandId}:requested`});
    try{
      const result=await execute();
      await this.ledger.append({...scope,type:"workbench.command_completed",summary:`Completed ${operation}`,data:{operation,result},idempotency_key:`${commandId}:completed`});
      return result;
    }catch(error){
      const code=typeof(error as {code?:unknown})?.code==="string"?String((error as {code:string}).code):"workbench_failed";
      await this.ledger.append({...scope,type:"workbench.command_failed",summary:redactSensitiveText(error instanceof Error?error.message:"Operation failed").slice(0,2000),data:{operation,code},idempotency_key:`${commandId}:failed`});
      throw error;
    }
  }
  async trigger(input:{scheduleId:string;occurrenceId:string;scheduledAt:string;status:string;runId?:string}){
    const proposal:SessionEventProposal={type:"schedule.trigger_recorded",project_id:"workbench:profile",run_id:`schedule:${input.scheduleId}`,summary:`Schedule trigger ${input.status}`,operation_id:input.occurrenceId,idempotency_key:`${input.occurrenceId}:${input.status}:${input.runId??"claim"}`,attempt:0,artifact_refs:[],data:{schedule_id:input.scheduleId,scheduled_at:input.scheduledAt,status:input.status,...(input.runId?{run_id:input.runId}:{})}};
    await this.ledger.append(proposal);
  }
}
