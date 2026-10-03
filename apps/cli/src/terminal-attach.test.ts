import {EventEmitter} from "node:events";
import {describe,expect,it,vi} from "vitest";
import type {TraceGraphClient} from "@tracegraph/sdk";
import {attachHostTerminal} from "./terminal-attach.js";

describe("CLI terminal attachment lifetime",()=>{
  it("forwards ordered input and detaches with Ctrl+] without closing the Host PTY",async()=>{
    const input=new EventEmitter() as EventEmitter&{resume:()=>void;pause:()=>void;isTTY:boolean;setRawMode:ReturnType<typeof vi.fn>};
    input.resume=()=>{queueMicrotask(()=>input.emit("data",Buffer.from("printf synthetic\\n\x1d")));};input.pause=vi.fn();input.isTTY=true;input.setRawMode=vi.fn();
    const workbenchCommand=vi.fn(async()=>({status:"succeeded"}));
    const getWorkbenchResources=vi.fn(async()=>({terminals:[{terminal_id:"terminal:test",state:"running",transcript:"synthetic prompt\n",cursor:17,exit_code:null}]}));
    const client={workbenchCommand,getWorkbenchResources} as unknown as TraceGraphClient;
    const output:string[]=[];
    expect(await attachHostTerminal(client,"terminal:test",{input,write:text=>output.push(text),pollMs:1})).toBe(0);
    expect(workbenchCommand).toHaveBeenCalledTimes(1);
    expect(workbenchCommand).toHaveBeenCalledWith(expect.objectContaining({type:"terminal.input",terminal_id:"terminal:test",text:"printf synthetic\\n"}));
    expect(input.listenerCount("data")).toBe(0);expect(input.setRawMode.mock.calls).toEqual([[true],[false]]);
    expect(input.pause).toHaveBeenCalledOnce();
  });
  it("returns actual closed failure and transcript without accepting more input",async()=>{
    const client={getWorkbenchResources:async()=>({terminals:[{terminal_id:"terminal:test",state:"closed",transcript:"synthetic failure\n",cursor:18,exit_code:2}]}),workbenchCommand:vi.fn()} as unknown as TraceGraphClient;
    const writes:string[]=[];
    expect(await attachHostTerminal(client,"terminal:test",{write:text=>writes.push(text)})).toBe(1);
    expect(writes).toEqual(["synthetic failure\n"]);expect(client.workbenchCommand).not.toHaveBeenCalled();
  });
});
