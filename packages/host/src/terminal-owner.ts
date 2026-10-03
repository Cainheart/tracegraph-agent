import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {identifyTerminalProcess,OwnedTerminalProcesses,readTerminalProcesses} from "./terminal-processes.js";

export interface TerminalGuardian {close():Promise<void>;}
export async function startTerminalGuardian(pid:number):Promise<TerminalGuardian> {
  const identity=await identifyTerminalProcess(pid);
  const child=spawn(process.execPath,[fileURLToPath(new URL("./terminal-guardian.js",import.meta.url)),JSON.stringify(identity),String(process.pid)],{detached:true,stdio:["pipe","pipe","pipe"],shell:false,env:{PATH:process.env.PATH??"/usr/bin:/bin",LC_ALL:"C"}});
  let ready=false;let closing:Promise<void>|undefined;
  const completion=new Promise<void>((resolve,reject)=>{child.once("error",()=>reject(new Error("Terminal supervisor could not start")));child.once("exit",code=>code===0?resolve():reject(new Error("Terminal supervisor cleanup is unknown")));});
  void completion.catch(()=>undefined);
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Terminal supervisor did not become ready")),3000);const cleanup=()=>clearTimeout(timer);child.stdout!.once("data",data=>{cleanup();if(String(data)==="ready\n"){ready=true;resolve();}else reject(new Error("Invalid terminal supervisor readiness"));});void completion.then(()=>{cleanup();if(!ready)reject(new Error("Terminal supervisor exited before readiness"));},error=>{cleanup();reject(error);});});}
  catch(error){child.stdin?.end();const rows=await readTerminalProcesses();const self=rows.find(row=>row.pid===process.pid);await new OwnedTerminalProcesses(identity,self?[self.group]:[]).stop();throw error;}
  return {close:()=>closing??=(async()=>{child.stdin!.end();await completion;})()};
}
