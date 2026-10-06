import {randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import type {WorkspaceHandle} from "@tracegraph/contracts";

export interface WorkspaceClaim {holderId:string;kind:"run"|"subagent"|"terminal"|"preview"|"git"|"schedule"|"file";signal?:AbortSignal;sessionId?:string;readOnly?:boolean;}
export interface WorkspaceLease {readonly leaseId:string;readonly root:string;release():void;}
export interface WorkspaceAdmission {lease_id:string;holder_id:string;project_id:string;root:string;kind:WorkspaceClaim["kind"];state:"queued"|"active";queued_at:string;}
interface Waiting {record:WorkspaceAdmission;keys:string[];resolve:(lease:WorkspaceLease)=>void;reject:(error:unknown)=>void;abort:()=>void;signal:AbortSignal|undefined;}
/** Trusted Host-only authority shared by Runs and developer resources. FIFO per canonical workspace. */
export class WorkspaceCoordinator {
  readonly #active=new Map<string,Waiting>();
  readonly #waiting:Waiting[]=[];
  #closed=false;
  #ownerUpgradePauses=0;
  #maxParallelRuns=4;
  setMaxParallelRuns(value:number):void {if(!Number.isInteger(value)||value<1||value>16)throw new RangeError("Parallel Runs must be 1..16");this.#maxParallelRuns=value;this.#pump();}
  async acquireWorkspace(workspace:WorkspaceHandle,input:WorkspaceClaim):Promise<WorkspaceLease> {
    if(this.#closed) throw new Error("Workspace admission is closed");
    if(this.#ownerUpgradePauses)throw Object.assign(new Error("Workspace admission is paused for a verified owner upgrade"),{code:"host_upgrade_in_progress",statusCode:409});
    const root=await realpath(workspace.real_root);
    if(this.#closed||this.#ownerUpgradePauses)throw Object.assign(new Error("Workspace admission changed before its lease was acquired"),{code:"host_upgrade_in_progress",statusCode:409});
    const keys=[...(input.readOnly===true ? [] : [`workspace:${root}`]),...(input.sessionId ? [`session:${input.sessionId}`] : [])];
    return new Promise((resolve,reject)=>{
      const record:WorkspaceAdmission={lease_id:randomUUID(),holder_id:input.holderId,project_id:workspace.project_id,root,kind:input.kind,state:"queued",queued_at:new Date().toISOString()};
      const waiting:Waiting={record,keys,resolve,reject,signal:input.signal,abort:()=>{
        const index=this.#waiting.indexOf(waiting);if(index>=0){this.#waiting.splice(index,1);reject(new DOMException("Queued workspace admission cancelled","AbortError"));this.#pump();}
      }};
      if(input.signal?.aborted){reject(new DOMException("Queued workspace admission cancelled","AbortError"));return;}
      input.signal?.addEventListener("abort",waiting.abort,{once:true});this.#waiting.push(waiting);this.#pump();
    });
  }
  pauseForOwnerUpgrade(){this.#ownerUpgradePauses++;let resumed=false;return {busy:this.list().length>0,resume:()=>{if(!resumed){resumed=true;this.#ownerUpgradePauses--;}}};}
  cancel(holderId:string):boolean {
    const index=this.#waiting.findIndex(x=>x.record.holder_id===holderId);
    if(index<0)return false;
    const [waiting]=this.#waiting.splice(index,1);waiting!.signal?.removeEventListener("abort",waiting!.abort);
    waiting!.reject(Object.assign(new Error("Queued workspace task was cancelled"),{code:"workspace_queue_cancelled",statusCode:409}));this.#pump();return true;
  }
  list():WorkspaceAdmission[] {return [...this.#active.values(),...this.#waiting].map(({record})=>({...record}));}
  close():void {this.#closed=true;for(const waiting of this.#waiting.splice(0)){waiting.signal?.removeEventListener("abort",waiting.abort);waiting.reject(new Error("Host stopped before queued task could start"));}this.#active.clear();}
  #pump():void {
    for(let index=0;index<this.#waiting.length;) {
      const waiting=this.#waiting[index]!;
      const atCapacity=waiting.record.kind==="run" && [...this.#active.values()].filter(x=>x.record.kind==="run").length>=this.#maxParallelRuns;
      const blocked=atCapacity || [...this.#active.values(),...this.#waiting.slice(0,index)].some(other=>other.keys.some(key=>waiting.keys.includes(key)));
      if(blocked){index++;continue;}
      this.#waiting.splice(index,1);waiting.signal?.removeEventListener("abort",waiting.abort);waiting.record.state="active";this.#active.set(waiting.record.lease_id,waiting);
      waiting.resolve({leaseId:waiting.record.lease_id,root:waiting.record.root,release:()=>{if(this.#active.delete(waiting.record.lease_id))this.#pump();}});
    }
  }
}
