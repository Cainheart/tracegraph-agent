import {randomUUID} from "node:crypto";
import {spawn,type ChildProcess} from "node:child_process";
import {access,mkdir,readFile,realpath} from "node:fs/promises";
import {isAbsolute,join,relative,resolve,basename} from "node:path";
import {fileURLToPath} from "node:url";
import * as pty from "node-pty";
import {generateSeatbeltProfile,probeNativeSandbox,redactSensitiveText,runBoundedProcess,SEATBELT_EXECUTABLE,seatbeltArguments} from "@tracegraph/core";
import {TerminalSnapshotSchema,PreviewSnapshotSchema,type GitStatusSnapshot,type PreviewSnapshot,type TerminalSnapshot,type WorkbenchCommandRequest,type WorkbenchCommandResult,type WorkbenchSettingsValues,type WorkspaceHandle} from "@tracegraph/contracts";
import {atomicPrivateJson} from "./local-profile.js";
import {workbenchError} from "./workbench-journal.js";
import type {WorkbenchControlContext} from "./workbench-control.js";
import type {WorkspaceLease} from "./workspace-coordinator.js";
import {startTerminalGuardian,type TerminalGuardian} from "./terminal-owner.js";
interface DevContext extends WorkbenchControlContext {getSettings():WorkbenchSettingsValues;}
interface ActiveTerminal {snapshot:TerminalSnapshot;process?:pty.IPty;guardian?:TerminalGuardian;lease?:WorkspaceLease;closing?:Promise<void>;}
interface ActivePreview {snapshot:PreviewSnapshot;process?:ChildProcess;lease?:WorkspaceLease;closing?:Promise<void>;}
const SAFE_SHELLS=["/bin/zsh","/bin/bash","/bin/sh","/usr/bin/zsh","/usr/bin/bash"];
const GIT_EXEC=process.platform==="win32"?"git.exe":process.platform==="darwin"?"/Library/Developer/CommandLineTools/usr/bin/git":"/usr/bin/git";
/** One resource owner. UI views detach; explicit close disposes the process and lease. */
export class DevWorkbench {
  readonly #context:DevContext;
  readonly #terminals=new Map<string,ActiveTerminal>();
  readonly #previews=new Map<string,ActivePreview>();
  #saveQueue:Promise<void>=Promise.resolve();
  #closed=false;
  #timer:ReturnType<typeof setInterval>|undefined;
  constructor(context:DevContext){this.#context=context;}
  async initialize(){
    try{const value=JSON.parse(await readFile(join(this.#context.profileRoot,"developer-resources.json"),"utf8"));
      for(const item of value.terminals??[]){const snapshot=TerminalSnapshotSchema.parse(item);this.#terminals.set(snapshot.terminal_id,{snapshot:{...snapshot,state:snapshot.state==="running"?"interrupted":snapshot.state}});}
      for(const item of value.previews??[]){const snapshot=PreviewSnapshotSchema.parse(item);this.#previews.set(snapshot.preview_id,{snapshot:{...snapshot,state:"stopped",message:"Previous Host stopped; service was not restarted"}});}
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    this.#timer=setInterval(()=>{void this.#health().then(()=>this.#persist()).catch(()=>undefined);},1000);this.#timer.unref();
  }
  validateSettings(settings:WorkbenchSettingsValues){
    if(settings.developer.shell&&!SAFE_SHELLS.includes(settings.developer.shell))throw workbenchError("shell_invalid","Choose an installed system shell using its absolute path",400);
    if(settings.developer.worktree_directory&&!isAbsolute(settings.developer.worktree_directory))throw workbenchError("worktree_directory_invalid","Worktree directory must be absolute",400);
    if(settings.developer.editor&&(!isAbsolute(settings.developer.editor)||/[\0\r\n]/u.test(settings.developer.editor)))throw workbenchError("editor_invalid","Editor must be an absolute executable path",400);
  }
  terminals(){return [...this.#terminals.values()].map(item=>({...item.snapshot}));}
  previews(){return [...this.#previews.values()].map(item=>({...item.snapshot}));}
  async close(){this.#closed=true;if(this.#timer)clearInterval(this.#timer);for(const item of this.#terminals.values())await this.#closeTerminal(item);for(const item of this.#previews.values())await this.#closePreview(item);await this.#persist(true);}
  async command(input:WorkbenchCommandRequest):Promise<WorkbenchCommandResult>{
    if(this.#closed)throw workbenchError("host_stopping","The Host is stopping",409);
    const base={command_id:input.command_id,status:"succeeded" as const,code:"ok",message:"Operation completed"};
    if(input.type.startsWith("git.")){
      if(!("project_id" in input)||!input.project_id)throw workbenchError("project_required","Select a project",400);
      const workspace=await this.#context.resolveWorkspace(input.project_id);
      const readOnly=input.type==="git.status"||input.type==="git.diff";
      if(!readOnly)this.#assertWrite(workspace);
      const lease=await this.#context.workspaceCoordinator.acquireWorkspace(workspace,{holderId:input.command_id,kind:"git",readOnly});
      try{
        const exec=(args:string[],extraRoots:string[]=[])=>this.#git(workspace,args,extraRoots,readOnly);
        if(input.type==="git.diff"){
          const scope=input.scope;const baseRef=input.base??"HEAD";if(baseRef.startsWith("-")||/[\0\r\n]/u.test(baseRef))throw workbenchError("git_ref_invalid","Invalid branch reference",400);
          if(input.paths)await this.#validatePaths(workspace,input.paths);
          const diff=await exec(["diff","--no-ext-diff","--no-textconv",...(scope==="staged"?["--cached"]:scope==="branch"?[`${baseRef}...HEAD`]:[]),"--",...(input.paths??[])]);
          return {...base,git:{...(await this.#status(workspace)),diff:redactSensitiveText(diff)}};
        }
        if(input.type==="git.stage"||input.type==="git.unstage"||input.type==="git.discard"){
          await this.#validatePaths(workspace,input.paths);
          if(input.type==="git.discard"){
            const head=await exec(["rev-parse","HEAD"]);if(input.expected_head!==head.trim())throw workbenchError("discard_preview_required","Inspect the affected paths and current HEAD before discarding modifications");
            await exec(["restore","--worktree","--",...input.paths]);
          }else await exec(input.type==="git.stage"?["add","--",...input.paths]:["restore","--staged","--",...input.paths]);
        }else if(input.type==="git.commit")await exec(["-c","commit.gpgSign=false","commit","-m",input.message,"--"]);
        else if(input.type==="git.branch.create"){
          this.#branch(input.name);await exec(["branch",input.name]);
        }else if(input.type==="git.worktree.create"){
          this.#branch(input.branch);if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(input.name))throw workbenchError("worktree_name_invalid","Use a simple directory name",400);
          const directory=await this.#worktreeDirectory();const target=join(directory,input.name);
          await exec(["worktree","add","-b",input.branch,"--",target], [directory]);
          await this.#context.registerWorktree?.(target);
        }else if(input.type==="git.worktree.remove"){
          const target=await realpath(input.worktree_path);const directory=await this.#worktreeDirectory();
          if(!this.#within(directory,target)||target===workspace.real_root)throw workbenchError("worktree_scope_denied","Only managed worktrees can be removed",403);
          if(this.#context.workspaceCoordinator.list().some(claim=>claim.root===target))throw workbenchError("worktree_active","Close or finish all work in this worktree before removing it");
          const status=await this.#status(workspace);if(!status.worktrees.some(item=>item.path===target))throw workbenchError("worktree_not_registered","Worktree is not registered with this repository",404);
          await exec(["worktree","remove","--",target],[directory]);await this.#context.unregisterWorktree?.(target);
        }else if(input.type!=="git.status")throw workbenchError("git_operation_invalid","Unsupported Git operation",400);
        return {...base,git:await this.#status(workspace)};
      }finally{lease.release();}
    }
    if(input.type==="terminal.create"){
      if(this.#terminals.size>=32){const closed=[...this.#terminals].find(([,item])=>item.snapshot.state!=="running");if(closed)this.#terminals.delete(closed[0]);}
      if(this.#terminals.size>=32)throw workbenchError("terminal_limit","Close an existing terminal before creating another");
      const workspace=await this.#context.resolveWorkspace(input.project_id);this.#assertWrite(workspace);
      const lease=await this.#context.workspaceCoordinator.acquireWorkspace(workspace,{holderId:input.command_id,kind:"terminal"});
      try{
        const shell=this.#context.getSettings().developer.shell|| (process.platform==="darwin"?"/bin/zsh":"/bin/bash");await access(shell);
        const shellArgs=shell.endsWith("zsh")?["-f"]:shell.endsWith("bash")?["--noprofile","--norc"]:[];
        const executable=await this.#execution(workspace,shell,shellArgs);
        const processHandle=pty.spawn(executable.command,executable.args,{name:"xterm-256color",cols:input.cols,rows:input.rows,cwd:workspace.real_root,env:{PATH:process.env.PATH??"/usr/bin:/bin",TERM:"xterm-256color",LANG:process.env.LANG??"en_US.UTF-8"}});
        let guardian:TerminalGuardian|undefined;
        try{if(process.platform!=="win32")guardian=await startTerminalGuardian(processHandle.pid);if(this.#closed){await guardian?.close();throw workbenchError("host_stopping","The Host is stopping",409);}}
        catch(error){try{processHandle.kill();}catch{}throw error;}
        const snapshot:TerminalSnapshot={terminal_id:`terminal:${randomUUID()}`,project_id:input.project_id,title:input.title??basename(workspace.real_root),state:"running",transcript:"",cursor:0,exit_code:null,created_at:new Date().toISOString()};
        const active:ActiveTerminal={snapshot,process:processHandle,...(guardian?{guardian}:{}),lease};this.#terminals.set(snapshot.terminal_id,active);
        processHandle.onData(data=>{const safe=redactSensitiveText(data);active.snapshot.transcript=(active.snapshot.transcript+safe).slice(-262144);active.snapshot.cursor+=safe.length;});
        processHandle.onExit(event=>{active.snapshot.exit_code=event.exitCode;void this.#closeTerminal(active).then(()=>this.#persist()).catch(()=>{active.snapshot.state="interrupted";});});
        await this.#persist();return {...base,terminal:{...snapshot}};
      }catch(error){lease.release();throw error;}
    }
    if(input.type==="terminal.input"||input.type==="terminal.resize"||input.type==="terminal.close"){
      const active=this.#terminals.get(input.terminal_id);if(!active)throw workbenchError("terminal_not_found","Terminal is unavailable",404);
      if(input.type==="terminal.close")await this.#closeTerminal(active);
      else {if(!active.process||active.snapshot.state!=="running")throw workbenchError("terminal_closed","Terminal is no longer running");if(input.type==="terminal.input")active.process.write(input.text);else active.process.resize(input.cols,input.rows);}
      await this.#persist();return {...base,terminal:{...active.snapshot}};
    }
    if(input.type==="preview.start"||input.type==="preview.register"){
      if(this.#previews.size>=32){const stopped=[...this.#previews].find(([,item])=>item.snapshot.state==="stopped");if(stopped)this.#previews.delete(stopped[0]);}
      if(this.#previews.size>=32)throw workbenchError("preview_limit","Stop an existing preview before creating another");
      const workspace=await this.#context.resolveWorkspace(input.project_id);
      if([...this.#previews.values()].some(x=>x.snapshot.url===`http://127.0.0.1:${input.port}/`&&x.snapshot.state!=="stopped"))throw workbenchError("preview_port_busy","This port is already managed by a preview");
      const snapshot:PreviewSnapshot={preview_id:`preview:${randomUUID()}`,project_id:input.project_id,url:`http://127.0.0.1:${input.port}/`,state:"starting",owned_process:input.type==="preview.start"};const active:ActivePreview={snapshot};
      if(input.type==="preview.start"){
        this.#assertWrite(workspace);const lease=await this.#context.workspaceCoordinator.acquireWorkspace(workspace,{holderId:input.command_id,kind:"preview"});active.lease=lease;
        try{const command=await this.#resolveExecutable(input.command,workspace);const execution=await this.#execution(workspace,command,input.args,input.port);
          const child=spawn(process.execPath,[fileURLToPath(new URL("./resource-supervisor.js",import.meta.url)),execution.command,...execution.args],{cwd:workspace.real_root,detached:process.platform!=="win32",env:{PATH:process.env.PATH??"/usr/bin:/bin",LANG:process.env.LANG??"en_US.UTF-8",PORT:String(input.port)},stdio:["pipe","ignore","pipe"]});active.process=child;
          child.stderr?.on("data",data=>{snapshot.message=redactSensitiveText(String(data)).slice(-1000);});
          child.once("error",()=>{snapshot.state="failed";snapshot.message="Preview process could not start";lease.release();});
          child.once("exit",()=>{if(snapshot.state!=="stopped")snapshot.state="failed";void this.#closePreview(active).catch(()=>{snapshot.state="failed";snapshot.message="Process group cleanup requires manual inspection";});});
        }catch(error){lease.release();throw error;}
      }
      this.#previews.set(snapshot.preview_id,active);
      try{const response=await fetch(snapshot.url,{signal:AbortSignal.timeout(1000),redirect:"manual"});snapshot.state=response.status<500?"ready":"failed";snapshot.message=`HTTP ${response.status}`;await response.body?.cancel();}catch{snapshot.message="Waiting for the local service";}
      await this.#persist();return {...base,preview:{...snapshot}};
    }
    if(input.type==="preview.stop"){
      const active=this.#previews.get(input.preview_id);if(!active)throw workbenchError("preview_not_found","Preview is unavailable",404);await this.#closePreview(active);await this.#persist();return {...base,preview:{...active.snapshot}};
    }
    throw workbenchError("developer_operation_invalid","Unsupported developer operation",400);
  }
  #assertWrite(workspace:WorkspaceHandle){if(!workspace.capabilities.commit_patch&&!workspace.capabilities.run_command)throw workbenchError("workspace_read_only","Project registration is read-only",403);if(this.#context.permissionConfig.snapshot().selected_preset.sandbox_mode==="read-only")throw workbenchError("policy_denied","Select a Host-permitted write preset before this operation",403);}
  #branch(name:string){if(name.startsWith("-")||! /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/u.test(name)||name.includes("..")||name.endsWith("/"))throw workbenchError("git_branch_invalid","Invalid branch name",400);}
  #within(root:string,target:string){const rel=relative(root,target);return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));}
  async #worktreeDirectory(){const requested=this.#context.getSettings().developer.worktree_directory||join(this.#context.profileRoot,"worktrees");await mkdir(requested,{recursive:true,mode:0o700});return realpath(requested);}
  async #validatePaths(workspace:WorkspaceHandle,paths:string[]){for(const path of paths){const absolute=resolve(workspace.real_root,path);if(!this.#within(workspace.real_root,absolute)||path.startsWith("-"))throw workbenchError("path_scope_denied","Path is outside the registered workspace",403);try{const actual=await realpath(absolute);if(!this.#within(workspace.real_root,actual))throw workbenchError("path_scope_denied","Path resolves outside the registered workspace",403);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}}
  async #execution(workspace:WorkspaceHandle,command:string,args:string[],port?:number,extraRoots:string[]=[],readOnly=false){
    const selected=this.#context.permissionConfig.snapshot().selected_preset.sandbox_mode;
    const mode=selected==="danger-full-access"?selected:readOnly?"read-only":selected;
    const report=await probeNativeSandbox({mode,workspaceRoot:workspace.real_root});
    if(mode==="danger-full-access")return {command,args};
    if(report.enforcement!=="full")throw workbenchError("sandbox_unavailable",`Sandbox unavailable: ${report.unmet_constraints.join(", ")}`,503);
    let profile=generateSeatbeltProfile(mode);if(process.platform==="darwin"&&command===GIT_EXEC)profile+='\n(allow file-read* file-map-executable (subpath "/Library/Developer/CommandLineTools"))\n';const extraArgs:string[]=[];
    extraRoots.forEach((root,index)=>{const parameter=`OUTLIVE_EXTRA_${index}`;extraArgs.push("-D",`${parameter}=${root}`);profile+=`\n(allow file-read* file-map-executable (subpath (param "${parameter}")))\n`;if(!readOnly)profile+=`(allow file-write* (subpath (param "${parameter}")))\n`;});
    // Explicit local-preview grant only; no arbitrary outbound network permission.
    if(port)profile+=`\n(allow network-bind network-inbound (local ip "localhost:${port}"))\n(allow network-outbound (remote ip "localhost:*"))\n`;
    // PTY device endpoints are required by an interactive system shell.
    if(SAFE_SHELLS.includes(command))profile+='\n(allow file-read* file-write* file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))\n(allow signal (target same-sandbox))\n';
    return {command:SEATBELT_EXECUTABLE,args:[...extraArgs,...seatbeltArguments({profile,workspaceRoot:workspace.real_root,executable:command,args})]};
  }
  async #git(workspace:WorkspaceHandle,args:string[],extraRoots:string[]=[],readOnly=true){
    const safeArgs=["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","diff.external=","-c","protocol.ext.allow=never",...args];
    const common=await this.#gitMetadata(workspace);
    const execution=await this.#execution(workspace,GIT_EXEC,safeArgs,undefined,[...new Set([...extraRoots,...common])],readOnly);
    const result=await runBoundedProcess(execution.command,execution.args,{cwd:workspace.real_root,timeoutMs:30000,maxOutputBytes:1048576});
    if(result.exitCode!==0)throw workbenchError("git_failed",redactSensitiveText(result.stderr||"Git operation failed").slice(0,1000),400);
    return result.stdout;
  }
  async #gitMetadata(workspace:WorkspaceHandle):Promise<string[]>{
    const pointer=join(workspace.real_root,".git");let location:string;
    try{const actual=await realpath(pointer);if(!this.#within(workspace.real_root,actual))throw workbenchError("git_metadata_scope_denied","Git metadata symlink escapes the workspace",403);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    try{const text=await readFile(pointer,"utf8");if(!text.startsWith("gitdir: "))throw workbenchError("git_metadata_invalid","Invalid Git metadata pointer",400);location=await realpath(resolve(workspace.real_root,text.slice(8).trim()));}
    catch(error){if((error as NodeJS.ErrnoException).code==="EISDIR")return [];if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
    const allowed=[...this.#context.listProjects()].map(project=>join(project.workspace.real_root,".git"));
    if(!allowed.some(root=>this.#within(root,location)))throw workbenchError("git_metadata_scope_denied","Linked Git metadata is outside registered project scope",403);
    let common=location;try{common=await realpath(resolve(location,(await readFile(join(location,"commondir"),"utf8")).trim()));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(!allowed.some(root=>this.#within(root,common)))throw workbenchError("git_metadata_scope_denied","Git common metadata is outside registered project scope",403);
    return [common];
  }
  async #status(workspace:WorkspaceHandle):Promise<GitStatusSnapshot>{
    const status=await this.#git(workspace,["status","--porcelain=v1","-z"]);const branch=(await this.#git(workspace,["branch","--show-current"])).trim();const trees=await this.#git(workspace,["worktree","list","--porcelain"]);
    const records=status.split("\0");const files:GitStatusSnapshot["files"]=[];for(let index=0;index<records.length;index++){const item=records[index];if(!item)continue;files.push({path:item.slice(3),index_status:item[0]??"",worktree_status:item[1]??""});if(/[RC]/u.test(item.slice(0,2)))index++;}
    let head="";try{head=(await this.#git(workspace,["rev-parse","HEAD"])).trim();}catch{/* unborn branch */}
    const worktrees=trees.trim().split("\n\n").filter(Boolean).map(record=>{const lines=record.split("\n");return {path:lines.find(x=>x.startsWith("worktree "))?.slice(9)??"",head:lines.find(x=>x.startsWith("HEAD "))?.slice(5)??"",branch:lines.find(x=>x.startsWith("branch "))?.slice(7)??"",locked:lines.some(x=>x.startsWith("locked"))};});
    return {project_id:workspace.project_id,branch,head,files,worktrees};
  }
  async #resolveExecutable(command:string,workspace:WorkspaceHandle){if(command.includes("/")&&!isAbsolute(command))throw workbenchError("preview_command_invalid","Use an executable name or absolute path",400);const candidates=isAbsolute(command)?[command]:(process.env.PATH??"/usr/bin:/bin").split(":").map(directory=>join(directory,command));for(const path of candidates){try{await access(path);const actual=await realpath(path);if(this.#within(workspace.real_root,actual)||actual.startsWith("/usr/")||actual.startsWith("/bin/")||actual.startsWith("/opt/homebrew/")||actual.startsWith("/usr/local/")||actual.includes("/.codex/"))return actual;}catch{/* next candidate */}}throw workbenchError("preview_dependency_missing",`Install ${command} or choose an installed absolute executable`,400);}
  #checkingHealth=false;
  async #health(){if(this.#checkingHealth)return;this.#checkingHealth=true;try{for(const active of this.#previews.values()){if(active.snapshot.state==="stopped"||active.snapshot.state==="failed")continue;try{const response=await fetch(active.snapshot.url,{signal:AbortSignal.timeout(700),redirect:"manual"});active.snapshot.state=response.status<500?"ready":"failed";active.snapshot.message=`HTTP ${response.status}`;await response.body?.cancel();}catch{active.snapshot.state="starting";active.snapshot.message="Local service is not responding";}}}finally{this.#checkingHealth=false;}}
  #closeTerminal(active:ActiveTerminal):Promise<void>{return active.closing??=(async()=>{const processHandle=active.process;try{if(active.guardian)await active.guardian.close();else if(processHandle)await terminateOwnedGroup(processHandle.pid,()=>{try{processHandle.kill();}catch{}});}catch{active.snapshot.state="interrupted";throw workbenchError("resource_quiescence_unknown","Owned terminal jobs could not be confirmed stopped; the workspace remains reserved",503);}delete active.guardian;delete active.process;active.snapshot.state="closed";active.lease?.release();delete active.lease;})();}
  #closePreview(active:ActivePreview):Promise<void>{return active.closing??=(async()=>{if(active.process?.pid){const handle=active.process;await terminateOwnedGroup(handle.pid!,()=>{handle.kill();});}delete active.process;active.snapshot.state="stopped";active.lease?.release();delete active.lease;})();}
  #persist(force=false){if(this.#closed&&!force)return Promise.resolve();const save=()=>atomicPrivateJson(join(this.#context.profileRoot,"developer-resources.json"),{terminals:this.terminals(),previews:this.previews()});const result=this.#saveQueue.then(save,save);this.#saveQueue=result.catch(()=>undefined);return result;}
}

async function terminateOwnedGroup(pid:number,fallback:()=>void):Promise<void>{
  const exists=()=>{try{process.kill(process.platform==="win32"?pid:-pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return false;throw error;}};
  try{if(process.platform==="win32")fallback();else process.kill(-pid,"SIGTERM");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")fallback();}
  await new Promise(done=>setTimeout(done,100));
  if(exists()){try{process.kill(process.platform==="win32"?pid:-pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}}
  const deadline=Date.now()+3000;while(exists()){if(Date.now()>deadline)throw workbenchError("resource_quiescence_unknown","The process group did not stop; its workspace remains reserved",503);await new Promise(done=>setTimeout(done,20));}
}
