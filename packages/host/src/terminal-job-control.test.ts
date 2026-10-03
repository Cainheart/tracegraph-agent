import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn,type ChildProcess} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe,it,expect} from "vitest";
import {createManagedWorkspaceHandle,type AgentRuntime} from "@tracegraph/core";
import {WorkbenchSettingsValuesSchema} from "@tracegraph/contracts";
import {DevWorkbench} from "../dist/dev-workbench.js";
import {WorkspaceCoordinator} from "./workspace-coordinator.js";
import {OwnedTerminalProcesses,identifyTerminalProcess,readTerminalProcesses} from "./terminal-processes.js";
import type {WorkbenchControlContext} from "./workbench-control.js";
import type {PermissionConfigController} from "./composition/permission-config.js";

async function eventually<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean):Promise<T>{const deadline=Date.now()+10_000;while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(done=>setTimeout(done,30));}throw new Error("Timed out waiting for PTY process oracle");}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function fixture(){const root=await mkdtemp(join(tmpdir(),"outlive-pty-jobs-"));const workspaceRoot=join(root,"workspace");await mkdir(workspaceRoot);const workspace=await createManagedWorkspaceHandle({projectId:"pty:fixture",root:workspaceRoot});const workspaceCoordinator=new WorkspaceCoordinator();const context={profileRoot:root,profileId:"pty:profile",runtime:{} as AgentRuntime,workspaceCoordinator,permissionConfig:{snapshot:()=>({selected_preset:{sandbox_mode:"workspace-write"}})} as unknown as PermissionConfigController,resolveWorkspace:async()=>workspace,listProjects:()=>[{workspace}]} as unknown as WorkbenchControlContext;const dev=new DevWorkbench({...context,getSettings:()=>WorkbenchSettingsValuesSchema.parse({})});await dev.initialize();return {root,workspaceRoot,dev,workspaceCoordinator};}

describe.skipIf(process.platform!=="darwin")("real restricted PTY job-control ownership",()=>{
 it("supports Ctrl-Z/jobs/fg/Ctrl-C and closes an independent background job group before releasing its workspace",async()=>{
  const {root,workspaceRoot,dev,workspaceCoordinator}=await fixture();const outside=join(root,"outside.txt");let backgroundPid:number|undefined;
  try{const created=await dev.command({type:"terminal.create",command_id:"pty:create",project_id:"pty:fixture",cols:100,rows:30});const id=created.terminal!.terminal_id;let command=0;const input=(text:string)=>dev.command({type:"terminal.input",command_id:`pty:input:${++command}`,terminal_id:id,text});
   await input(`printf proof > allowed.txt; printf denied > '${outside}'; /bin/sleep 60 & print -r -- $! > bg.pid; /bin/sleep 60\r`);
   backgroundPid=await eventually(async()=>Number(await readFile(join(workspaceRoot,"bg.pid"),"utf8").catch(()=>"0")),pid=>pid>1);expect(await readFile(join(workspaceRoot,"allowed.txt"),"utf8")).toBe("proof");await expect(readFile(outside)).rejects.toMatchObject({code:"ENOENT"});expect(alive(backgroundPid)).toBe(true);
   await input("\x1a");await eventually(async()=>dev.terminals()[0]!.transcript,text=>/suspended|Stopped/iu.test(text));await input("jobs\r");await eventually(async()=>dev.terminals()[0]!.transcript,text=>text.includes("jobs"));await input("fg\r");await new Promise(done=>setTimeout(done,100));await input("\x03");await input("printf 'JOB_'; printf 'CONTROL_OK\\n'\r");await eventually(async()=>dev.terminals()[0]!.transcript,text=>text.includes("JOB_CONTROL_OK"));expect(dev.terminals()[0]!.transcript).not.toContain("can't set tty pgrp");expect(workspaceCoordinator.list()).toHaveLength(1);
   await dev.command({type:"terminal.close",command_id:"pty:close",terminal_id:id});await eventually(async()=>alive(backgroundPid!),value=>!value);expect(workspaceCoordinator.list()).toHaveLength(0);expect(dev.terminals()[0]?.state).toBe("closed");
  }finally{if(backgroundPid&&alive(backgroundPid))try{process.kill(backgroundPid,"SIGKILL");}catch{}await dev.close();await rm(root,{recursive:true,force:true});}
 },20_000);

 it("owner SIGKILL closes the guardian lifetime pipe and removes separately grouped background jobs",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-pty-owner-death-"));const workspaceRoot=join(root,"workspace");await mkdir(workspaceRoot);const launcher=join(root,"owner.mjs");let owner:ChildProcess|undefined;let backgroundPid:number|undefined;
  const core=fileURLToPath(new URL("../../core/dist/index.js",import.meta.url)),contracts=fileURLToPath(new URL("../../contracts/dist/index.js",import.meta.url)),devPath=fileURLToPath(new URL("../dist/dev-workbench.js",import.meta.url)),coordinator=fileURLToPath(new URL("../dist/workspace-coordinator.js",import.meta.url));
  await writeFile(launcher,`import{createManagedWorkspaceHandle}from ${JSON.stringify(core)};import{WorkbenchSettingsValuesSchema}from ${JSON.stringify(contracts)};import{DevWorkbench}from ${JSON.stringify(devPath)};import{WorkspaceCoordinator}from ${JSON.stringify(coordinator)};const workspace=await createManagedWorkspaceHandle({projectId:'pty:death',root:${JSON.stringify(workspaceRoot)}});const dev=new DevWorkbench({profileRoot:${JSON.stringify(root)},profileId:'pty:death-profile',runtime:{},workspaceCoordinator:new WorkspaceCoordinator(),permissionConfig:{snapshot:()=>({selected_preset:{sandbox_mode:'workspace-write'}})},resolveWorkspace:async()=>workspace,listProjects:()=>[{workspace}],getSettings:()=>WorkbenchSettingsValuesSchema.parse({})});await dev.initialize();const created=await dev.command({type:'terminal.create',command_id:'death:create',project_id:'pty:death',cols:100,rows:30});await dev.command({type:'terminal.input',command_id:'death:input',terminal_id:created.terminal.terminal_id,text:${JSON.stringify("trap '' HUP; /bin/sleep 60 & print -r -- $! > bg.pid\r")}});setInterval(()=>{},1000);`);
  try{owner=spawn(process.execPath,[launcher],{stdio:["ignore","ignore","pipe"],env:{PATH:process.env.PATH??"/usr/bin:/bin",LC_ALL:"C"},detached:true});let stderr="";owner.stderr?.on("data",chunk=>{stderr+=String(chunk);});backgroundPid=await eventually(async()=>{if(owner!.exitCode!==null)throw new Error(`Fixture owner exited: ${stderr}`);return Number(await readFile(join(workspaceRoot,"bg.pid"),"utf8").catch(()=>"0"));},pid=>pid>1);await new Promise(done=>setTimeout(done,650));expect(alive(backgroundPid)).toBe(true);owner.kill("SIGKILL");await new Promise<void>(done=>owner!.once("exit",()=>done()));await eventually(async()=>alive(backgroundPid!),value=>!value);}
  finally{owner?.kill("SIGKILL");if(backgroundPid&&alive(backgroundPid))try{process.kill(backgroundPid,"SIGKILL");}catch{}await rm(root,{recursive:true,force:true});}
 },20_000);

 it("rejects a changed process identity and cannot adopt a different terminal or the Host process group",async()=>{
  const rows=await readTerminalProcesses();const host=rows.find(row=>row.pid===process.pid)!;expect(()=>new OwnedTerminalProcesses({...host,tty:"fake-tty"},[host.group])).not.toThrow();await expect(new OwnedTerminalProcesses({...host,tty:"fake-tty",started:"different process birth"},[host.group]).initialize()).rejects.toThrow("identity changed");await expect(identifyTerminalProcess(1)).rejects.toThrow("identity is unavailable");
 });
});
