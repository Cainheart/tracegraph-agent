import {describe,it,expect,vi} from "vitest";
import {LeasedModelAdapter} from "./leased-model.js";
import {createSecretReference} from "@tracegraph/core";
const input={projectId:"p",runId:"r",modelCallId:"m",task:"Respond",mode:"execute" as const,turn:1,toolSchemas:[],observations:[],retrievedMemory:[],context:{},reasoningEffort:"default" as const};
describe("Run-scoped immutable provider and credential leases",()=>{
 it("keeps a snapshot across rotation/clear and deletes its key only on Run settlement",async()=>{
  const calls:Array<{model:string;key:string|null}>=[];const cleanup=vi.fn(async()=>undefined);const secrets=new Map([["TRACEGRAPH_CUSTOM_OLD_KEY","old-value"],["TRACEGRAPH_CUSTOM_NEW_KEY","new-value"]]);
  const adapter=new LeasedModelAdapter({resolveCredential:async reference=>secrets.get(reference.match(/secret:([^}]+)/u)![1]!)!});
  adapter.configure({provider:"custom",protocol:"openai-chat-completions",baseUrl:"https://isolated.example/v1",model:"old-model",credentialRef:createSecretReference("TRACEGRAPH_CUSTOM_OLD_KEY")});const run=adapter.forRun();
  vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{calls.push({model:(JSON.parse(String(init.body)) as {model:string}).model,key:new Headers(init.headers).get("authorization")});return Response.json({choices:[{message:{content:JSON.stringify({decision_id:"d",kind:"finish",public_reason:"Done",evidence_refs:[],risk:"none",final_answer:"Done"})}}]});}));
  try{await run.decide(input as never);adapter.configure({provider:"custom",protocol:"openai-chat-completions",baseUrl:"https://isolated.example/v1",model:"new-model",credentialRef:createSecretReference("TRACEGRAPH_CUSTOM_NEW_KEY")});adapter.retireCredential(createSecretReference("TRACEGRAPH_CUSTOM_OLD_KEY"),cleanup);expect(cleanup).not.toHaveBeenCalled();await run.decide(input as never);adapter.clearConfiguration();await run.decide(input as never);expect(calls).toEqual(Array.from({length:3},()=>({model:"old-model",key:"Bearer old-value"})));expect(cleanup).not.toHaveBeenCalled();run.releaseRun?.();await Promise.resolve();expect(cleanup).toHaveBeenCalledTimes(1);run.releaseRun?.();expect(cleanup).toHaveBeenCalledTimes(1);}finally{vi.unstubAllGlobals();}
 });
});
