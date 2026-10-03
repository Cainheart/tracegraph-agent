import {randomUUID} from "node:crypto";
import type {TraceGraphClient} from "@tracegraph/sdk";

export interface TerminalAttachInput {
  isTTY?:boolean;
  setRawMode?(raw:boolean):unknown;
  on(event:"data",listener:(data:Buffer|string)=>void):unknown;
  off(event:"data",listener:(data:Buffer|string)=>void):unknown;
  resume():unknown;
  pause():unknown;
}
export interface TerminalAttachOptions {
  signal?:AbortSignal;
  input?:TerminalAttachInput;
  write?:(text:string)=>void;
  pollMs?:number;
}
/** Attach/detach is a client subscription; terminal.close alone stops the Host-owned PTY. */
export async function attachHostTerminal(client:TraceGraphClient,terminalId:string,options:TerminalAttachOptions={}):Promise<number> {
  const first=(await client.getWorkbenchResources()).terminals.find(value=>value.terminal_id===terminalId);
  if(!first)throw new Error("Terminal is unavailable");
  const write=options.write??(text=>{process.stdout.write(text);});
  if(first.state!=="running"){write(first.transcript);return first.state==="closed"&&first.exit_code===0?0:1;}
  const input=options.input??process.stdin;
  const abort=new AbortController();
  const externalAbort=()=>abort.abort();
  options.signal?.addEventListener("abort",externalAbort,{once:true});if(options.signal?.aborted)abort.abort();
  let cursor=0;let pending=Promise.resolve();let inputFailure:unknown;
  const queue=(text:string)=>{pending=pending.then(async()=>{const result=await client.workbenchCommand({type:"terminal.input",command_id:randomUUID(),terminal_id:terminalId,text});if(result.status!=="succeeded"&&result.status!=="queued")throw new Error("Terminal input was not accepted");}).catch(error=>{inputFailure=error;abort.abort();});};
  const receive=(data:Buffer|string)=>{
    const text=String(data),detach=text.indexOf("\x1d");
    if(detach>=0){if(detach>0)queue(text.slice(0,detach));abort.abort();}else if(text.length>0)queue(text);
  };
  try {
    if(input.isTTY)input.setRawMode?.(true);
    input.on("data",receive);input.resume();
    while(!abort.signal.aborted){
      const terminal=(await client.getWorkbenchResources()).terminals.find(value=>value.terminal_id===terminalId);
      if(!terminal)throw new Error("Terminal is unavailable");
      const fresh=terminal.cursor-cursor;if(fresh>0)write(fresh>=terminal.transcript.length?terminal.transcript:terminal.transcript.slice(-fresh));cursor=terminal.cursor;
      if(terminal.state!=="running")return terminal.state==="closed"&&terminal.exit_code===0?0:1;
      await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);abort.signal.removeEventListener("abort",finish);resolve();};const timer=setTimeout(finish,options.pollMs??100);abort.signal.addEventListener("abort",finish,{once:true});if(abort.signal.aborted)finish();});
    }
    return 0;
  }finally{
    input.off("data",receive);input.pause();if(input.isTTY)input.setRawMode?.(false);
    options.signal?.removeEventListener("abort",externalAbort);
    await pending;if(inputFailure)throw inputFailure;
  }
}
