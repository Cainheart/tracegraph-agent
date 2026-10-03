import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {ScheduleInputSchema,ScheduleOccurrenceSchema,ScheduleSnapshotSchema,type ScheduleInput,type ScheduleOccurrence,type ScheduleSnapshot,type WorkbenchCommandRequest,type WorkbenchCommandResult} from "@tracegraph/contracts";
import {atomicPrivateJson} from "./local-profile.js";
import {workbenchError,type WorkbenchJournal} from "./workbench-journal.js";
import type {WorkbenchControlContext} from "./workbench-control.js";
interface ScheduleContext extends WorkbenchControlContext {journal:WorkbenchJournal;now?:()=>Date;automaticTimer?:boolean;}
export function validateTimezone(timezone:string):void{try{new Intl.DateTimeFormat("en-US",{timeZone:timezone}).format();}catch{throw workbenchError("timezone_invalid","Use an IANA timezone, for example Asia/Shanghai",400);}}
export function nextScheduleTime(input:ScheduleInput,after:Date):string|null {
  validateTimezone(input.timezone);
  if(input.timing.kind==="once")return Date.parse(input.timing.at)>after.getTime()?input.timing.at:null;
  if(input.timing.kind==="interval")return new Date(after.getTime()+input.timing.seconds*1000).toISOString();
  const formatter=new Intl.DateTimeFormat("en-GB",{timeZone:input.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  // Minute search handles DST gaps and repeated local times without converting wall clocks as UTC.
  const start=Math.floor(after.getTime()/60000)*60000+60000;
  for(let minute=0;minute<48*60;minute++){const candidate=new Date(start+minute*60000);if(formatter.format(candidate)===input.timing.time)return candidate.toISOString();}
  throw workbenchError("schedule_time_invalid","No valid occurrence of this local time was found",400);
}
export class WorkbenchScheduler {
  readonly #context:ScheduleContext;readonly #schedules=new Map<string,ScheduleSnapshot>();readonly #occurrences=new Map<string,ScheduleOccurrence>();
  readonly #inflight=new Set<string>();readonly #activeOccurrence=new Map<string,string>();readonly #now:()=>Date;#timer:ReturnType<typeof setInterval>|undefined;#queue:Promise<unknown>=Promise.resolve();#closed=false;
  constructor(context:ScheduleContext){this.#context=context;this.#now=context.now??(()=>new Date());}
  async initialize(){
    try{const value=JSON.parse(await readFile(join(this.#context.profileRoot,"schedules.json"),"utf8"));for(const item of value.schedules??[]){const s=ScheduleSnapshotSchema.parse(item);this.#schedules.set(s.schedule_id,s);}for(const item of value.occurrences??[]){const event=ScheduleOccurrenceSchema.parse(item);this.#occurrences.set(event.occurrence_id,event);}}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    // Durable ledger is authoritative even if a crash interrupted writing the JSON projection.
    for(const id of await this.#context.journal.ledger.listRunIds()){if(!id.startsWith("schedule:"))continue;for(const event of await this.#context.journal.ledger.list(id)){if(event.type!=="schedule.trigger_recorded")continue;const data=event.data;const occurrence=ScheduleOccurrenceSchema.parse({occurrence_id:event.operation_id,schedule_id:data.schedule_id,scheduled_at:data.scheduled_at,status:data.status,...(data.run_id?{run_id:data.run_id}:{})});this.#occurrences.set(occurrence.occurrence_id,occurrence);}}
    for(const schedule of this.#schedules.values()){
      if(schedule.running_run_id){const runId=schedule.running_run_id;const occurrence=this.history(schedule.schedule_id).find(item=>item.run_id===runId);try{const p=await this.#context.runtime.getProjection(runId);if(!["completed","failed","cancelled"].includes(p.status)){schedule.last_status="interrupted";schedule.enabled=false;}else schedule.last_status=p.status==="completed"?"completed":"failed";}catch{schedule.last_status="interrupted";schedule.enabled=false;}if(occurrence)await this.#record(schedule,occurrence.scheduled_at,schedule.last_status,runId,occurrence.occurrence_id);schedule.running_run_id=null;}
      if(schedule.next_at&&Date.parse(schedule.next_at)<this.#now().getTime()){await this.#record(schedule,schedule.next_at,"missed");schedule.next_at=nextScheduleTime(schedule,this.#now());}
    }
    await this.#persist();
    if(this.#context.automaticTimer!==false){this.#timer=setInterval(()=>{void this.tick().catch(()=>undefined);},1000);this.#timer.unref();}
  }
  list(){return [...this.#schedules.values()].map(s=>({...s}));}
  history(id:string){return [...this.#occurrences.values()].filter(x=>x.schedule_id===id).sort((a,b)=>a.scheduled_at.localeCompare(b.scheduled_at)).slice(-1000);}
  async close(){this.#closed=true;if(this.#timer)clearInterval(this.#timer);await this.#queue;await this.#persist();}
  async command(input:WorkbenchCommandRequest):Promise<WorkbenchCommandResult>{
    const execute=async()=>{
      const base={command_id:input.command_id,status:"succeeded" as const,code:"ok",message:"Operation completed"};
      if(input.type==="schedule.create"){
        if(this.#schedules.size>=128)throw workbenchError("schedule_limit","The schedule limit has been reached");const values=ScheduleInputSchema.parse(input.input);await this.#context.resolveWorkspace(values.project_id);validateTimezone(values.timezone);const next=nextScheduleTime(values,this.#now());if(values.timing.kind==="once"&&!next)throw workbenchError("schedule_in_past","Choose a future time",400);
        const schedule:ScheduleSnapshot={...values,schedule_id:`schedule:${randomUUID()}`,revision:0,next_at:next,running_run_id:null,last_status:"never"};this.#schedules.set(schedule.schedule_id,schedule);await this.#persist();return {...base,schedule:{...schedule}};
      }
      if(input.type==="schedule.update"){
        const current=this.#get(input.schedule_id);if(current.revision!==input.expected_revision)throw workbenchError("schedule_revision_conflict","Schedule changed in another client");await this.#context.resolveWorkspace(input.input.project_id);validateTimezone(input.input.timezone);
        const schedule={...current,...input.input,revision:current.revision+1,next_at:nextScheduleTime(input.input,this.#now())};this.#schedules.set(schedule.schedule_id,schedule);await this.#persist();return {...base,schedule:{...schedule}};
      }
      if(input.type==="schedule.delete"){const schedule=this.#get(input.schedule_id);if(schedule.running_run_id||this.#inflight.has(schedule.schedule_id))throw workbenchError("schedule_active","Cancel or finish the active Run before deleting this schedule");this.#schedules.delete(schedule.schedule_id);await this.#persist();return base;}
      if(input.type==="schedule.history"){this.#get(input.schedule_id);return {...base,occurrences:this.history(input.schedule_id)};}
      if(input.type==="schedule.run"){
        const schedule=this.#get(input.schedule_id);await this.#launch(schedule,`${this.#now().toISOString()}#${input.command_id}`);return {...base,schedule:{...schedule}};
      }
      throw workbenchError("schedule_operation_invalid","Unsupported schedule operation",400);
    };
    const result=this.#queue.then(execute,execute);this.#queue=result.catch(()=>undefined);return result;
  }
  async tick(){if(this.#closed)return;
    for(const schedule of this.#schedules.values()){
      if(schedule.running_run_id){const projection=await this.#context.runtime.getProjection(schedule.running_run_id);if(projection.pending_approval!=null||projection.status==="awaiting_approval"||projection.status==="awaiting_plan_approval"){schedule.enabled=false;schedule.last_status="awaiting-approval";await this.#record(schedule,this.#activeOccurrence.get(schedule.schedule_id)??this.history(schedule.schedule_id).find(item=>item.run_id===schedule.running_run_id)?.scheduled_at??this.#now().toISOString(),"awaiting-approval",schedule.running_run_id);}
        else if(["completed","failed","cancelled"].includes(projection.status)){schedule.last_status=projection.status==="completed"?"completed":"failed";await this.#record(schedule,this.#activeOccurrence.get(schedule.schedule_id)??this.history(schedule.schedule_id).find(item=>item.run_id===schedule.running_run_id)?.scheduled_at??this.#now().toISOString(),schedule.last_status,schedule.running_run_id);schedule.running_run_id=null;this.#activeOccurrence.delete(schedule.schedule_id);}
      }
      if(!schedule.enabled||!schedule.next_at||Date.parse(schedule.next_at)>this.#now().getTime())continue;
      const due=schedule.next_at;schedule.next_at=nextScheduleTime(schedule,this.#now());
      if(this.#now().getTime()-Date.parse(due)>5000){await this.#record(schedule,due,"missed");continue;}
      // Persist claim and advance before dispatch; shutdown cannot replay the occurrence.
      void this.#launch(schedule,due).catch(()=>undefined);
    }
    await this.#persist();
  }
  #get(id:string){const s=this.#schedules.get(id);if(!s)throw workbenchError("schedule_not_found","Schedule is unavailable",404);return s;}
  async #launch(schedule:ScheduleSnapshot,at:string){
    if(schedule.running_run_id||this.#inflight.has(schedule.schedule_id)){await this.#record(schedule,at,"overlap-skipped");return;}
    const identifier=`occurrence:${createHash("sha256").update(`${schedule.schedule_id}:${at}`).digest("hex")}`;
    if(this.#occurrences.has(identifier))return;
    this.#inflight.add(schedule.schedule_id);
    try{
      await this.#record(schedule,at,"started");await this.#persist();
      const projection=await this.#context.startRun({command_id:identifier,project_id:schedule.project_id,task:schedule.task,mode:schedule.mode});schedule.running_run_id=projection.run_id;this.#activeOccurrence.set(schedule.schedule_id,at);schedule.last_status="started";
      await this.#record(schedule,at,"started",projection.run_id);
    }catch{schedule.last_status="failed";await this.#record(schedule,at,"failed");}
    finally{this.#inflight.delete(schedule.schedule_id);await this.#persist();}
  }
  async #record(schedule:ScheduleSnapshot,at:string,status:ScheduleSnapshot["last_status"],runId?:string,occurrenceIdOverride?:string){
    // Manual triggers use a unique suffix for dedup, while display timestamps remain strict ISO.
    const occurrenceId=occurrenceIdOverride??`occurrence:${createHash("sha256").update(`${schedule.schedule_id}:${at}`).digest("hex")}`;const timestamp=at.split("#")[0]!;
    await this.#context.journal.trigger({scheduleId:schedule.schedule_id,occurrenceId,scheduledAt:timestamp,status,...(runId?{runId}:{})});
    this.#occurrences.set(occurrenceId,{occurrence_id:occurrenceId,schedule_id:schedule.schedule_id,scheduled_at:timestamp,status,...(runId?{run_id:runId}:{})});schedule.last_status=status;
  }
  #saveQueue:Promise<void>=Promise.resolve();
  #persist(){const save=()=>atomicPrivateJson(join(this.#context.profileRoot,"schedules.json"),{schedules:this.list(),occurrences:[...this.#occurrences.values()]});const result=this.#saveQueue.then(save,save);this.#saveQueue=result.catch(()=>undefined);return result;}
}
