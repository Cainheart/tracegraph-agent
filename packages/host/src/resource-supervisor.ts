import {spawn} from "node:child_process";
// stdin is the owner-lifetime pipe. Losing the Host ends the entire process group.
const [command,...args]=process.argv.slice(2);
if(!command)process.exit(64);
const child=spawn(command,args,{stdio:["ignore","ignore","pipe"]});
child.stderr?.pipe(process.stderr);
let ending=false;
function stop(){if(ending)return;ending=true;try{if(process.platform!=="win32")process.kill(-process.pid,"SIGTERM");else child.kill();}catch{}setTimeout(()=>process.exit(0),250).unref();}
process.stdin.resume();process.stdin.on("end",stop);process.stdin.on("error",stop);process.once("SIGTERM",()=>{child.kill();setTimeout(()=>{try{if(process.platform!=="win32")process.kill(-process.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}},500).unref();});
child.once("error",()=>process.exit(70));child.once("exit",code=>process.exit(code??1));
