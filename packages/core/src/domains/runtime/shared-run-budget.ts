import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {GoalBudgetLimitsSchema,GoalBudgetSnapshotSchema,ModelUsageReportSchema,DeliveryGoalRequirementsSchema,type DeliveryGoalRequirements,type GoalBudgetLimits,type GoalBudgetSnapshot,type ModelUsageReport} from "@tracegraph/contracts";

export interface ModelBudgetReservation {
 readonly id:string;
 readonly maxOutputTokens:number;
 readonly signal:AbortSignal;
 /** Missing usage is an uncertain charge, never zero. */
 settle(usage?:ModelUsageReport):Promise<void>;
 /** Only the trusted transport may prove no dispatch took place. */
 cancelBeforeDispatch():Promise<void>;
}
export interface ModelRequestBudget {
 readonly identity:string;
 readonly deliveryRequirements?:DeliveryGoalRequirements;
 readonly signal:AbortSignal;
 reserve(input:{runId:string;requestKind:"initial"|"repair"|"summary";inputTokens:number;maxOutputTokens:number}):Promise<ModelBudgetReservation>;
 assertDispatch():void;
}
export interface BudgetCheckpoint {
 phase:"reserved"|"settled"|"stopped";
 reservation_id?:string;
 run_id?:string;
 request_kind?:"initial"|"repair"|"summary";
 reserved_tokens?:number;
 actual_tokens?:number;
 outcome?:"reported"|"unknown"|"not_dispatched";
 snapshot:GoalBudgetSnapshot;
}
export class ModelBudgetError extends Error {
 constructor(readonly code:string,message:string){super(message);this.name="ModelBudgetError";}
}
/** One trusted lease shared by the whole Goal tree. Persistence precedes dispatch. */
export class SharedRunBudget implements ModelRequestBudget {
 readonly deliveryRequirements?:DeliveryGoalRequirements;
 readonly identity:string;readonly #abort=new AbortController();readonly #persist:(value:BudgetCheckpoint)=>Promise<void>;
 readonly #started=performance.now();readonly #initialElapsed:number;#state:GoalBudgetSnapshot;#queue:Promise<unknown>=Promise.resolve();#timer:ReturnType<typeof setTimeout>|undefined;#finalElapsed:number|undefined;
 constructor(input:{identity:string;limits:GoalBudgetLimits;previous?:GoalBudgetSnapshot;deliveryRequirements?:DeliveryGoalRequirements;checkpoint:(value:BudgetCheckpoint)=>Promise<void>}){
  if(input.deliveryRequirements){const requirements=DeliveryGoalRequirementsSchema.parse(input.deliveryRequirements);Object.freeze(requirements.done_conditions);this.deliveryRequirements=Object.freeze(requirements);}
  this.identity=input.identity;this.#persist=input.checkpoint;const limits=GoalBudgetLimitsSchema.parse(input.limits);
  this.#initialElapsed=input.previous?.elapsed_ms??0;
  this.#state=GoalBudgetSnapshotSchema.parse({...input.previous,limits,charged_tokens:input.previous?.charged_tokens??0,held_tokens:0,held_request_count:0,reported_input_tokens:input.previous?.reported_input_tokens??0,reported_output_tokens:input.previous?.reported_output_tokens??0,elapsed_ms:this.#initialElapsed,request_count:input.previous?.request_count??0,unknown_request_count:input.previous?.unknown_request_count??0,stop_reason:null});
  if((input.previous?.held_tokens??0)>0)throw new ModelBudgetError("budget_reconciliation_required","Outstanding reservations must be conserved before continuing");
  if(limits.max_time_ms!==undefined){const remaining=limits.max_time_ms-this.#initialElapsed;if(remaining<=0)this.#abort.abort(new ModelBudgetError("goal_time_limit","Goal time budget is exhausted"));else{this.#timer=setTimeout(()=>{void this.stop("time_limit").catch(()=>undefined);},remaining);this.#timer.unref();}}
 }
 get signal(){return this.#abort.signal;}
 snapshot():GoalBudgetSnapshot{return {...this.#state,limits:{...this.#state.limits},elapsed_ms:this.#finalElapsed??Math.floor(this.#initialElapsed+performance.now()-this.#started)};}
 #serial<T>(execute:()=>Promise<T>):Promise<T>{const result=this.#queue.then(execute,execute);this.#queue=result.catch(()=>undefined);return result;}
 assertDispatch(){const current=this.snapshot();if(this.signal.aborted)throw new ModelBudgetError("goal_budget_stopped","Goal budget is stopped");if(current.limits.max_time_ms!==undefined&&current.elapsed_ms>=current.limits.max_time_ms){this.#abort.abort(new ModelBudgetError("goal_time_limit","Goal time budget is exhausted"));throw new ModelBudgetError("goal_time_limit","Goal time budget is exhausted");}if(current.limits.max_tokens!==undefined&&current.charged_tokens+current.held_tokens>=current.limits.max_tokens)throw new ModelBudgetError("goal_token_limit","Goal token budget is exhausted");}
 async reserve(input:{runId:string;requestKind:"initial"|"repair"|"summary";inputTokens:number;maxOutputTokens:number}):Promise<ModelBudgetReservation>{return this.#serial(async()=>{
  this.assertDispatch();if(!Number.isSafeInteger(input.inputTokens)||input.inputTokens<0||!Number.isSafeInteger(input.maxOutputTokens)||input.maxOutputTokens<1)throw new ModelBudgetError("budget_request_invalid","Model request budget is invalid");
  const current=this.snapshot(),remaining=current.limits.max_tokens===undefined?Number.MAX_SAFE_INTEGER:current.limits.max_tokens-current.charged_tokens-current.held_tokens;
  const output=Math.min(input.maxOutputTokens,remaining-input.inputTokens);if(output<1){await this.#write({...current,stop_reason:"token_limit"},{phase:"stopped"});this.#abort.abort(new ModelBudgetError("goal_token_limit","Goal token budget cannot admit this request"));throw new ModelBudgetError("goal_token_limit","Goal token budget cannot admit this request");}
  const id=`budget:${randomUUID()}`,reserved=input.inputTokens+output;
  await this.#write({...current,held_tokens:current.held_tokens+reserved,held_request_count:current.held_request_count+1,request_count:current.request_count+1},{phase:"reserved",reservation_id:id,run_id:input.runId,request_kind:input.requestKind,reserved_tokens:reserved});
  // Time may expire while durable persistence is settling. Never dispatch after it.
  if(this.signal.aborted||current.limits.max_time_ms!==undefined&&this.snapshot().elapsed_ms>=current.limits.max_time_ms){await this.#write({...this.snapshot(),held_tokens:current.held_tokens,held_request_count:current.held_request_count,stop_reason:"time_limit"},{phase:"settled",reservation_id:id,run_id:input.runId,request_kind:input.requestKind,reserved_tokens:reserved,actual_tokens:0,outcome:"not_dispatched"});throw new ModelBudgetError("goal_time_limit","Goal time budget expired during reservation");}let settled=false;
  return {id,maxOutputTokens:output,signal:this.signal,cancelBeforeDispatch:()=>this.#serial(async()=>{if(settled)return;const state=this.snapshot();await this.#write({...state,held_tokens:Math.max(0,state.held_tokens-reserved),held_request_count:Math.max(0,state.held_request_count-1)},{phase:"settled",reservation_id:id,run_id:input.runId,request_kind:input.requestKind,reserved_tokens:reserved,actual_tokens:0,outcome:"not_dispatched"});settled=true;}),settle:async(usageValue)=>this.#serial(async()=>{
   if(settled)return;const parsed=ModelUsageReportSchema.safeParse(usageValue),usage=parsed.success?parsed.data:undefined;
   const state=this.snapshot(),actual=usage?.total_tokens??reserved,overrun=actual>reserved;
   const next={...state,held_tokens:Math.max(0,state.held_tokens-reserved),held_request_count:Math.max(0,state.held_request_count-1),charged_tokens:state.charged_tokens+actual,reported_input_tokens:state.reported_input_tokens+(usage?.input_tokens??0),reported_output_tokens:state.reported_output_tokens+(usage?.output_tokens??0),unknown_request_count:state.unknown_request_count+(usage?0:1),stop_reason:overrun?"usage_overrun" as const:usage?state.stop_reason:"usage_unknown" as const};
   await this.#write(next,{phase:"settled",reservation_id:id,run_id:input.runId,request_kind:input.requestKind,reserved_tokens:reserved,actual_tokens:actual,outcome:usage?"reported":"unknown"});settled=true;
   if(!usage||overrun)this.#abort.abort(new ModelBudgetError(overrun?"goal_usage_overrun":"goal_usage_unknown","Goal usage requires review before further requests"));
  })};
 });}
 async #write(next:GoalBudgetSnapshot,detail:Omit<BudgetCheckpoint,"snapshot">){const parsed=GoalBudgetSnapshotSchema.parse(next);try{await this.#persist({...detail,snapshot:parsed});this.#state=parsed;}catch{this.#abort.abort(new ModelBudgetError("goal_budget_persistence_failed","Budget reservation could not be persisted"));throw new ModelBudgetError("goal_budget_persistence_failed","Budget reservation could not be persisted");}}
 async stop(reason:NonNullable<GoalBudgetSnapshot["stop_reason"]>="paused"){this.#abort.abort(new ModelBudgetError("goal_budget_stopped","Goal budget is stopped"));if(this.#timer)clearTimeout(this.#timer);await this.#serial(async()=>this.#write({...this.snapshot(),stop_reason:reason},{phase:"stopped"}));}
 async drain(){await this.#queue;}
 dispose(){this.#finalElapsed=this.snapshot().elapsed_ms;if(this.#timer)clearTimeout(this.#timer);}
}
