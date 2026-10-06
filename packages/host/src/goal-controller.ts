import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {GoalCreateRequestSchema,GoalCommandRequestSchema,GoalSnapshotSchema,GoalCommandReceiptSchema,GoalCreationReceiptSchema,IdentifierSchema,isTerminalEventType,type GoalCreateRequest,type GoalCommandRequest,type GoalSnapshot,type GoalBudgetSnapshot,type GoalListResponse,type GoalCommandReceipt,type GoalCreationReceipt,type StartRunRequest,type RunProjection,type ConversationMessage} from "@tracegraph/contracts";
import {JsonlEventLedger,SharedRunBudget,redactSensitiveText,type AgentRuntime,type ModelRequestBudget,type BudgetCheckpoint} from "@tracegraph/core";
import {WorkbenchJournal,workbenchError} from "./workbench-journal.js";

export interface GoalControllerContext {
 profileRoot:string;
 runtime:Pick<AgentRuntime,"getProjection"|"stop"|"subscribe">;
 /** Reuse registered project/session validation before storing a proposal. */
 assertScope(projectId:string,sessionId?:string):Promise<void>;
 /** Trusted admission must reuse ConversationControl.prepare + RunSessionController.startRun. */
 startRun(input:StartRunRequest,budget:ModelRequestBudget):Promise<RunProjection>;
}
/** Snapshot projections are reconstructed from canonical SessionEvent streams. */
export class GoalController {
 readonly ledger:JsonlEventLedger;readonly #ctx:GoalControllerContext;readonly #commands:WorkbenchJournal;readonly #queues=new Map<string,Promise<unknown>>();readonly #writes=new Map<string,Promise<unknown>>();readonly #leases=new Map<string,SharedRunBudget>();readonly #subscriptions=new Map<string,()=>void>();
 private constructor(ctx:GoalControllerContext){this.#ctx=ctx;this.ledger=new JsonlEventLedger(join(ctx.profileRoot,"goal-events"));this.#commands=new WorkbenchJournal(join(ctx.profileRoot,"goal-command-events"));}
 static async open(ctx:GoalControllerContext){const self=new GoalController(ctx);await self.ledger.initialize();await self.#commands.initialize();for(const id of await self.ledger.listRunIds()){if(id.startsWith("goal-"))await self.#recover(id);}return self;}
 #serial<T>(id:string,execute:()=>Promise<T>):Promise<T>{const result=(this.#queues.get(id)??Promise.resolve()).then(execute,execute);this.#queues.set(id,result.catch(()=>undefined));return result;}
 async #raw(id:string):Promise<GoalSnapshot>{IdentifierSchema.parse(id);const events=await this.ledger.list(id);const snapshot=[...events].reverse().find(event=>event.data.snapshot!==undefined);if(!snapshot)throw workbenchError("goal_not_found","Goal was not found",404);return GoalSnapshotSchema.parse({...snapshot.data.snapshot as object,receipt_event_id:snapshot.event_id});}
 async #write(previous:GoalSnapshot|undefined,value:Omit<GoalSnapshot,"receipt_event_id">,operation:string,commandId?:string,extra:Record<string,unknown>={}):Promise<GoalSnapshot>{
  const execute=async()=>{
   const latest=previous?await this.#raw(value.goal_id):undefined;
   let candidate={...value};
   if(latest){
    if(operation.startsWith("budget_"))candidate={...latest,budget:value.budget,updated_at:value.updated_at};
    else if(operation==="revised")candidate.budget={...latest.budget,limits:value.proposal.budget};
    else if(!["launch_requested","run_settled","recovery_required","launch_failed"].includes(operation))candidate.budget=latest.budget;
   }
   const snapshot=GoalSnapshotSchema.parse({...candidate,receipt_event_id:"receipt:pending"});const event=await this.ledger.append({type:"workbench.command_completed",run_id:snapshot.goal_id,project_id:snapshot.proposal.project_id,operation_id:commandId??`goal-event:${randomUUID()}`,attempt:0,artifact_refs:[],summary:`Goal ${operation}`,data:{operation:`goal.${operation}`,snapshot,...extra},...(commandId?{idempotency_key:`${commandId}:${operation}`}:{})});
   return GoalSnapshotSchema.parse({...snapshot,receipt_event_id:event.event_id});
  };
  const result=(this.#writes.get(value.goal_id)??Promise.resolve()).then(execute,execute);this.#writes.set(value.goal_id,result.catch(()=>undefined));return result;
 }

 async create(value:GoalCreateRequest):Promise<GoalSnapshot>{const input=GoalCreateRequestSchema.parse(value);return this.#commands.once(input.command_id,"goal.create",input,async()=>{
  await this.#ctx.assertScope(input.project_id,input.session_id);const {command_id,...proposal}=input,id=`goal-${randomUUID()}`,now=new Date().toISOString();
  return this.#write(undefined,{schema_version:"outlive.goal.v1",goal_id:id,revision:1,proposal_revision:1,approved_proposal_revision:null,proposal,execution_session_id:proposal.session_id??null,status:"awaiting_approval",created_at:now,updated_at:now,run_ids:[],active_run_id:null,budget:{limits:proposal.budget,charged_tokens:0,held_tokens:0,held_request_count:0,reported_input_tokens:0,reported_output_tokens:0,elapsed_ms:0,request_count:0,unknown_request_count:0,stop_reason:null},last_run_status:null,final_accepted_at:null},"created",command_id);
 });}
 async list():Promise<GoalListResponse>{const goals=[];for(const id of await this.ledger.listRunIds()){if(id.startsWith("goal-"))goals.push(await this.read(id));if(goals.length>=1_000)break;}return {goals:goals.sort((a,b)=>b.updated_at.localeCompare(a.updated_at))};}
 async read(id:string):Promise<GoalSnapshot>{return this.#serial(id,async()=>{let current=await this.#raw(id);await this.#ctx.assertScope(current.proposal.project_id,current.execution_session_id??current.proposal.session_id);current=await this.#sync(current);return current;});}
 async budget(id:string):Promise<GoalBudgetSnapshot>{return (await this.read(id)).budget;}
 async reconcileCreation(commandId:string):Promise<GoalCreationReceipt>{IdentifierSchema.parse(commandId);const inspected=await this.#commands.inspect(commandId);if(inspected.operation!=="goal.create")return {command_id:commandId,state:"not_found"};const result=GoalSnapshotSchema.safeParse(inspected.result);if(inspected.state==="completed"){if(!result.success)throw workbenchError("goal_creation_receipt_invalid","Goal creation receipt could not be verified",503);await this.#ctx.assertScope(result.data.proposal.project_id,result.data.proposal.session_id);return GoalCreationReceiptSchema.parse({command_id:commandId,state:"completed",goal_id:result.data.goal_id,result:result.data});}return GoalCreationReceiptSchema.parse({command_id:commandId,state:inspected.state,...(inspected.code&&/^[a-z][a-z0-9_]{0,100}$/u.test(inspected.code)?{code:inspected.code}:{})});}
 /** Exact scoped command inspection. No synchronization, recovery, or executor dispatch. */
 async reconcile(id:string,commandId:string):Promise<GoalCommandReceipt>{IdentifierSchema.parse(id);IdentifierSchema.parse(commandId);const current=await this.#raw(id);await this.#ctx.assertScope(current.proposal.project_id,current.execution_session_id??current.proposal.session_id);const events=await this.ledger.list(id),bound=events.some(event=>event.operation_id===commandId);const inspected=await this.#commands.inspect(commandId);const result=GoalSnapshotSchema.safeParse(inspected.result);if(!bound||!inspected.operation?.startsWith("goal.")||result.success&&result.data.goal_id!==id)return {goal_id:id,command_id:commandId,state:"not_found"};if(events.some(event=>event.operation_id===commandId&&event.data.operation==="goal.launch_failed"&&event.data.outcome==="unknown"))return GoalCommandReceiptSchema.parse({goal_id:id,command_id:commandId,state:"unknown",operation:inspected.operation.slice("goal.".length),code:"goal_launch_unknown"});const operation=inspected.operation.slice("goal.".length),code=inspected.code&&/^[a-z][a-z0-9_]{0,100}$/u.test(inspected.code)?inspected.code:undefined;return GoalCommandReceiptSchema.parse({goal_id:id,command_id:commandId,state:inspected.state,operation,...(code?{code}:{}),...(inspected.state==="completed"&&result.success?{result:result.data}:{})});}
 async command(id:string,value:GoalCommandRequest):Promise<GoalSnapshot>{const input=GoalCommandRequestSchema.parse(value);IdentifierSchema.parse(id);return this.#serial(id,()=>this.#commands.once(input.command_id,`goal.${input.operation}`,{id,...input},async()=>{
  let current=await this.#sync(await this.#raw(id));await this.#ctx.assertScope(current.proposal.project_id,current.execution_session_id??current.proposal.session_id);
  await this.ledger.append({type:"workbench.command_requested",project_id:current.proposal.project_id,run_id:id,operation_id:input.command_id,attempt:0,artifact_refs:[],summary:`Requested Goal ${input.operation}`,data:{operation:`goal.${input.operation}`,goal_id:id,expected_revision:input.expected_revision},idempotency_key:`${input.command_id}:goal-scope`});
  if(current.revision!==input.expected_revision)throw workbenchError("goal_revision_conflict","Goal changed; read its current revision before proceeding");
  if(["completed","cancelled"].includes(current.status))throw workbenchError("goal_terminal","This Goal is already terminal");
  const next={...current,revision:current.revision+1,updated_at:new Date().toISOString()};
  if(input.operation==="approve"){
   if(current.status!=="awaiting_approval"||input.proposal_revision!==current.proposal_revision)throw workbenchError("goal_approval_revision_mismatch","Approve the current exact Goal proposal");
   next.approved_proposal_revision=current.proposal_revision;next.status="approved";return this.#write(current,next,"approved",input.command_id);
  }
  if(input.operation==="revise"){
   if(current.status==="running")throw workbenchError("goal_active","Pause this Goal before revising it");
   if(["launch_unknown","unknown_side_effect"].includes(current.last_run_status??""))throw workbenchError("goal_unknown_write_unresolved","Reconcile the unknown launch or effect before revising execution authority");
   if(input.proposal.project_id!==current.proposal.project_id||input.proposal.session_id!==current.proposal.session_id)throw workbenchError("goal_scope_immutable","Goal project and conversation cannot be changed",403);
   if(input.proposal.budget.max_tokens!==undefined&&input.proposal.budget.max_tokens<current.budget.charged_tokens||input.proposal.budget.max_time_ms!==undefined&&input.proposal.budget.max_time_ms<current.budget.elapsed_ms)throw workbenchError("goal_budget_below_spent","New ceilings cannot erase already consumed budget");
   next.proposal=input.proposal;next.proposal_revision+=1;next.approved_proposal_revision=null;next.status="awaiting_approval";next.budget={...current.budget,limits:input.proposal.budget};return this.#write(current,next,"revised",input.command_id);
  }
  if(input.operation==="accept"){
   if(current.status!=="awaiting_final_acceptance"||current.last_run_status!=="completed"||current.budget.stop_reason==="usage_unknown"||current.budget.stop_reason==="usage_overrun")throw workbenchError("goal_not_ready_for_acceptance","Goal has no successful, settled execution result for final acceptance");
   if(input.accepted_conditions.length!==current.proposal.done_conditions.length||new Set(input.accepted_conditions).size!==input.accepted_conditions.length||current.proposal.done_conditions.some(condition=>!input.accepted_conditions.includes(condition)))throw workbenchError("goal_done_conditions_unaccepted","Explicitly accept every current done condition");
   next.status="completed";next.final_accepted_at=new Date().toISOString();return this.#write(current,next,"accepted",input.command_id);
  }
  if(input.operation==="pause"||input.operation==="cancel"){
   if(input.operation==="pause"&&current.status!=="running")throw workbenchError("goal_not_running","Only a running Goal can be paused");
   await this.#leases.get(id)?.stop(input.operation==="pause"?"paused":"cancelled");
   let settled:RunProjection|undefined;
   if(current.active_run_id){const projection=await this.#ctx.runtime.getProjection(current.active_run_id);if(!isRunTerminal(projection))await this.#ctx.runtime.stop({type:"stop",command_id:`${input.command_id}:stop`,project_id:current.proposal.project_id,run_id:current.active_run_id,reason:`Goal ${input.operation}`});settled=await this.#ctx.runtime.getProjection(current.active_run_id);if(!isRunTerminal(settled))throw workbenchError("goal_pause_unsettled","Goal execution has not yet settled",503);}
   const updated=await this.#raw(id),unknown=settled&&hasUnknownEffects(settled);next.budget=updated.budget;next.status=input.operation==="pause"?(unknown?"blocked":"paused"):"cancelled";next.last_run_status=unknown?"unknown_side_effect":settled?.status??current.last_run_status;next.active_run_id=null;this.#release(id);return this.#write(current,next,input.operation==="pause"?"paused":"cancelled",input.command_id);
  }
  if(input.operation==="start"||input.operation==="resume"){
   if(current.approved_proposal_revision!==current.proposal_revision)throw workbenchError("goal_approval_required","Approve this exact Goal revision before execution",403);
   if(input.operation==="start"&&current.status!=="approved"||input.operation==="resume"&&!['paused','blocked'].includes(current.status))throw workbenchError("goal_start_state_invalid","Goal cannot start from its current state");
   if(current.status==="blocked"&&["unknown_side_effect","launch_unknown"].includes(current.last_run_status??""))throw workbenchError("goal_unknown_write_unresolved","Reconcile the unknown Run effect before any new execution");
   if(current.budget.unknown_request_count>0&&!('acknowledge_unknown_usage' in input&&input.acknowledge_unknown_usage===true))throw workbenchError("goal_usage_acknowledgement_required","Unknown requests consumed their full reservation. Review this before continuing");
   const sessionId=current.execution_session_id??current.proposal.session_id;
   if(sessionId)await this.#ctx.assertScope(current.proposal.project_id,sessionId);
   const history=await this.#publicHistory(current,sessionId);
   const lease=new SharedRunBudget({identity:`${id}:proposal:${current.proposal_revision}`,limits:current.proposal.budget,previous:current.budget,deliveryRequirements:{goal_id:id,approved_proposal_revision:current.approved_proposal_revision!,objective:current.proposal.objective,done_conditions:current.proposal.done_conditions},checkpoint:checkpoint=>this.#checkpoint(id,checkpoint)});this.#leases.set(id,lease);
   try{lease.assertDispatch();}catch(error){this.#release(id);throw error;}next.status="running";next.active_run_id=null;next.budget=lease.snapshot();await this.#write(current,next,"launch_requested",input.command_id,{acknowledged_unknown_usage:"acknowledge_unknown_usage" in input&&input.acknowledge_unknown_usage===true});
   let accepted=false;
   try{const projection=await this.#ctx.startRun({command_id:`${input.command_id}:run`,project_id:current.proposal.project_id,...(sessionId?{session_id:sessionId}:{}),mode:"execute",task:renderGoalTask(current),run_options:{...current.proposal.run_options,mode:"execute"},...(history.length?{conversation_history:history}:{})},lease);accepted=true;
    if(projection.project_id!==current.proposal.project_id||!projection.session_id||sessionId&&projection.session_id!==sessionId)throw workbenchError("goal_run_scope_mismatch","Accepted Goal execution could not be bound to its approved conversation",503);
    await this.#ctx.assertScope(current.proposal.project_id,projection.session_id);
    const latest=await this.#raw(id),linked={...latest,execution_session_id:projection.session_id,active_run_id:projection.run_id,run_ids:[...latest.run_ids,projection.run_id],last_run_status:projection.status,budget:lease.snapshot()};await this.#write(latest,linked,"run_linked",input.command_id);
    this.#subscriptions.set(id,this.#ctx.runtime.subscribe(projection.run_id,event=>{if(isTerminalEventType(event.type))void this.#serial(id,async()=>{await this.#sync(await this.#raw(id));}).catch(()=>undefined);}));
    return this.#sync(await this.#raw(id));
   }catch(error){await lease.stop("paused").catch(()=>undefined);const latest=await this.#raw(id);this.#release(id);const rejected=!accepted&&knownAdmissionRejection(error);await this.#write(latest,{...latest,status:rejected?(input.operation==="start"?"approved":"paused"):"blocked",last_run_status:rejected?"admission_rejected":"launch_unknown",active_run_id:null,budget:lease.snapshot()},"launch_failed",input.command_id,{outcome:rejected?"rejected_before_admission":"unknown"});throw error;}
  }
 throw workbenchError("goal_command_unsupported","Unsupported Goal operation",400);
 }));}
 /** Only this Goal's canonical public tasks/terminal answers enter continuation context. */
 async #publicHistory(goal:GoalSnapshot,sessionId:string|undefined):Promise<ConversationMessage[]>{
  if(goal.run_ids.length&&!sessionId)throw workbenchError("goal_history_scope_mismatch","Previous Goal execution has no verified conversation binding",503);
  const turns:ConversationMessage[][]=[];let characters=0,turn:ConversationMessage[]=[];
  const append=(role:ConversationMessage["role"],raw:unknown)=>{if(typeof raw!=="string")return;const content=redactSensitiveText(raw).replace(/\u0000/gu,"").slice(0,Math.min(8_000,64_000-characters));if(content.trim()){turn.push({role,content});characters+=content.length;}};
  for(const runId of goal.run_ids.slice(-40).reverse()){
   turn=[];
   const projection=await this.#ctx.runtime.getProjection(runId);
   if(projection.run_id!==runId||projection.project_id!==goal.proposal.project_id||projection.session_id!==sessionId||projection.timeline.some(event=>event.project_id!==goal.proposal.project_id||event.run_id!==runId||event.session_id!==sessionId))throw workbenchError("goal_history_scope_mismatch","Previous Goal result is outside its bound conversation",403);
   const created=projection.timeline.find(event=>event.type==="run.created"),terminal=[...projection.timeline].reverse().find(event=>isTerminalEventType(event.type));
   if(!created||!terminal||!isRunTerminal(projection))throw workbenchError("goal_history_unsettled","Previous Goal execution has not settled",409);
   if(hasUnknownEffects(projection))throw workbenchError("goal_unknown_write_unresolved","Previous Goal execution contains an unresolved unknown effect",409);
   append("user",created.data.task);
   if(terminal.type==="run.completed"&&projection.status==="completed")append("assistant",terminal.data.outcome);
   else append("assistant",`Previous execution status: ${projection.status}. ${terminal.summary}`);
   turns.push(turn);
   if(characters>=64_000)break;
  }
  return turns.reverse().flat();
 }
 async #checkpoint(id:string,checkpoint:BudgetCheckpoint){const current=await this.#raw(id);await this.#write(current,{...current,budget:checkpoint.snapshot,updated_at:new Date().toISOString()},`budget_${checkpoint.phase}`,undefined,{budget_checkpoint:checkpoint});}
 async #sync(current:GoalSnapshot):Promise<GoalSnapshot>{if(current.status!=="running"||!current.active_run_id)return current;const projection=await this.#ctx.runtime.getProjection(current.active_run_id);if(projection.project_id!==current.proposal.project_id||projection.session_id!==current.execution_session_id)throw workbenchError("goal_run_scope_mismatch","Goal Run is outside the approved conversation",403);const lease=this.#leases.get(current.goal_id);
  if(!isRunTerminal(projection))return lease?{...current,budget:lease.snapshot()}:current;
  if(lease){await lease.drain();lease.dispose();current=await this.#raw(current.goal_id);}
  const unknown=hasUnknownEffects(projection);
  const status=unknown||current.budget.stop_reason==="usage_unknown"||current.budget.stop_reason==="usage_overrun"?"blocked":projection.status==="completed"?"awaiting_final_acceptance":"paused";
  this.#release(current.goal_id);return this.#write(current,{...current,revision:current.revision+1,status,active_run_id:null,last_run_status:unknown?"unknown_side_effect":projection.status,budget:lease?.snapshot()??current.budget,updated_at:new Date().toISOString()},"run_settled");
 }
 async #recover(id:string){let current=await this.#raw(id);if(current.status!=="running")return;
  const budget={...current.budget,charged_tokens:current.budget.charged_tokens+current.budget.held_tokens,held_tokens:0,held_request_count:0,unknown_request_count:current.budget.unknown_request_count+(current.budget.held_request_count||(current.budget.held_tokens>0?1:0)),elapsed_ms:current.budget.elapsed_ms+Math.max(0,Date.now()-Date.parse(current.updated_at)),stop_reason:"recovery_required" as const};
  let status:GoalSnapshot["status"]="blocked",last="launch_unknown";
  if(current.active_run_id){
   const projection=await this.#ctx.runtime.getProjection(current.active_run_id),sessionId=current.execution_session_id??current.proposal.session_id;if(projection.project_id!==current.proposal.project_id||!projection.session_id||sessionId&&projection.session_id!==sessionId)throw workbenchError("goal_run_scope_mismatch","Recovered Goal Run is outside its approved conversation",403);await this.#ctx.assertScope(projection.project_id,projection.session_id);
   current={...current,execution_session_id:projection.session_id};
   const unknown=hasUnknownEffects(projection);
   status=unknown?"blocked":projection.status==="completed"&&budget.unknown_request_count===0?"awaiting_final_acceptance":"paused";last=unknown?"unknown_side_effect":projection.status;
  }
  await this.#write(current,{...current,budget,status,active_run_id:null,last_run_status:last,revision:current.revision+1,updated_at:new Date().toISOString()},"recovery_required");
  // No provider or task dispatch during recovery. Unknown launch/effects cannot auto-resume.
 }

 #release(id:string){this.#subscriptions.get(id)?.();this.#subscriptions.delete(id);this.#leases.get(id)?.dispose();this.#leases.delete(id);}
 async close(){for(const [id,lease] of this.#leases){await lease.stop("recovery_required");this.#release(id);}await Promise.all(this.#queues.values());}
}
function isRunTerminal(projection:RunProjection){return ["completed","failed","cancelled","interrupted"].includes(projection.status);}
function renderGoalTask(goal:GoalSnapshot){return `${goal.proposal.objective}\n\nUser-approved Goal done conditions:\n${goal.proposal.done_conditions.map((condition,index)=>`${index+1}. ${condition}`).join("\n")}\n\nExecute only within the approved scope and current permissions. A Run answer does not constitute final user acceptance.`.slice(0,8_000);}

function knownAdmissionRejection(error:unknown){const code=(error as {code?:unknown})?.code;return typeof code==="string"&&["project_scope_denied","project_not_registered","session_project_mismatch","workspace_project_mismatch","permission_ceiling","permission_grant_revoked","model_connection_missing","model_not_configured","credential_required","goal_budget_adapter_unsupported","delivery_budget_adapter_unsupported","goal_token_limit","goal_time_limit","file_context_unavailable","file_context_revision_conflict"].includes(code);}

function hasUnknownEffects(projection:RunProjection){return projection.timeline.some(event=>event.type==="run.failed"&&event.data.code==="unknown_side_effect"||typeof event.data.receipt==="object"&&event.data.receipt!==null&&(event.data.receipt as {business_status?:unknown}).business_status==="unknown");}
