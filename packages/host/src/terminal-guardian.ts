import {OwnedTerminalProcesses,readTerminalProcesses,type TerminalProcessIdentity} from "./terminal-processes.js";

// A trusted Host-created lifetime pipe. This is not a renderer/native PID endpoint.
const [rawIdentity,rawOwnerPid]=process.argv.slice(2);
let identity:TerminalProcessIdentity;
try{identity=JSON.parse(rawIdentity??"") as TerminalProcessIdentity;}catch{process.exit(64);}
const ownerPid=Number(rawOwnerPid);
if(!Number.isSafeInteger(ownerPid)||ownerPid<=1||process.platform==="win32")process.exit(64);
let ending=false;
let tracker:OwnedTerminalProcesses;
let refresh:Promise<unknown>=Promise.resolve();
let refreshing=false;
let timer:ReturnType<typeof setInterval>|undefined;
async function stop(){if(ending)return;ending=true;if(timer)clearInterval(timer);try{await refresh.catch(()=>undefined);await tracker.stop();process.exit(0);}catch{process.stderr.write("Owned terminal cleanup requires inspection\n");process.exit(70);}}
try{const rows=await readTerminalProcesses();const owner=rows.find(row=>row.pid===ownerPid&&row.uid===process.getuid?.());const self=rows.find(row=>row.pid===process.pid);if(!owner||!self)throw new Error("Owner unavailable");tracker=new OwnedTerminalProcesses(identity!,[owner.group,self.group]);await tracker.initialize();
 timer=setInterval(()=>{if(ending||refreshing)return;refreshing=true;refresh=tracker.refresh().catch(()=>undefined).finally(()=>{refreshing=false;});},500);
 process.stdin.resume();process.stdin.once("end",()=>void stop());process.stdin.once("error",()=>void stop());process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());process.stdout.write("ready\n");
}catch{process.stderr.write("Owned terminal supervision unavailable\n");process.exit(70);}
