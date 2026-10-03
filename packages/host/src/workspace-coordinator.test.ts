import {mkdtemp,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect} from "vitest";
import {createManagedWorkspaceHandle} from "@tracegraph/core";
import {WorkspaceCoordinator} from "./workspace-coordinator.js";
describe("canonical workspace write admission",()=>{
 it("queues aliases, lets another workspace start, and releases FIFO",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-admit-"));const other=await mkdtemp(join(tmpdir(),"outlive-other-"));
  try{const a=await createManagedWorkspaceHandle({projectId:"p:a",root});const b=await createManagedWorkspaceHandle({projectId:"p:b",root:other});await symlink(root,join(other,"alias"));const alias={...a,project_id:"p:alias",real_root:join(other,"alias")};
   const coordinator=new WorkspaceCoordinator();const first=await coordinator.acquireWorkspace(a,{holderId:"first",kind:"terminal"});let started=false;const pending=coordinator.acquireWorkspace(alias,{holderId:"second",kind:"run"}).then(x=>{started=true;return x;});
   const independent=await coordinator.acquireWorkspace(b,{holderId:"independent",kind:"run"});await new Promise(resolve=>setTimeout(resolve,10));expect(started).toBe(false);expect(coordinator.list().find(x=>x.holder_id==="second")?.state).toBe("queued");first.release();const next=await pending;expect(started).toBe(true);expect(coordinator.list().find(x=>x.holder_id==="second")?.state).toBe("active");next.release();independent.release();expect(coordinator.list()).toEqual([]);
  }finally{await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
 });
 it("serializes one readonly Session and aborts queued resources",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-session-"));try{const workspace=await createManagedWorkspaceHandle({projectId:"p",root});const coordinator=new WorkspaceCoordinator();const active=await coordinator.acquireWorkspace(workspace,{holderId:"run-a",kind:"run",sessionId:"s",readOnly:true});const abort=new AbortController();const queued=coordinator.acquireWorkspace(workspace,{holderId:"run-b",kind:"run",sessionId:"s",readOnly:true,signal:abort.signal});const expected=expect(queued).rejects.toMatchObject({name:"AbortError"});await new Promise(resolve=>setTimeout(resolve,5));abort.abort();await expected;active.release();coordinator.close();await expect(coordinator.acquireWorkspace(workspace,{holderId:"late",kind:"run"})).rejects.toThrow("closed");}finally{await rm(root,{recursive:true,force:true});}
 });
 it("cancels only queued holders and preserves active writer authority",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-cancel-queue-"));
  try{const workspace=await createManagedWorkspaceHandle({projectId:"p",root});const coordinator=new WorkspaceCoordinator();const active=await coordinator.acquireWorkspace(workspace,{holderId:"active",kind:"run"});const queued=coordinator.acquireWorkspace(workspace,{holderId:"queued",kind:"run"});const rejected=expect(queued).rejects.toMatchObject({code:"workspace_queue_cancelled",statusCode:409});await new Promise(resolve=>setTimeout(resolve,5));expect(coordinator.cancel("active")).toBe(false);expect(coordinator.cancel("missing")).toBe(false);expect(coordinator.cancel("queued")).toBe(true);await rejected;expect(coordinator.cancel("queued")).toBe(false);expect(coordinator.list()).toMatchObject([{holder_id:"active",state:"active"}]);active.release();expect(coordinator.list()).toEqual([]);coordinator.close();}
  finally{await rm(root,{recursive:true,force:true});}
 });
});
