import {describe,it,expect,vi} from "vitest";
import {LeasedModelAdapter} from "./leased-model.js";
import {createSecretReference} from "@tracegraph/core";
const input={projectId:"p",runId:"r",modelCallId:"m",task:"Respond",mode:"execute" as const,turn:1,toolSchemas:[],observations:[],retrievedMemory:[],context:{},reasoningEffort:"default" as const};
describe("Run-scoped immutable provider and credential leases",()=>{
 it("forks the captured configuration and capability with independent idempotent release",()=>{
  const owner=new LeasedModelAdapter();
  const configuration={provider:"custom" as const,protocol:"openai-chat-completions" as const,baseUrl:"https://isolated.example/v1",model:"captured-model",credentialRef:createSecretReference("OUTLIVE_CAPTURED_FIXTURE_KEY")};
  const capabilities={image_input:true};
  const parent=owner.forConfiguration(configuration,capabilities);
  configuration.model="mutated-caller-model";capabilities.image_input=false;
  owner.configure({...configuration,model:"new-global-model"});
  const child=parent.forRun!();
  expect((child as typeof parent).publicConfig().model).toBe("captured-model");expect(child.capabilities?.()).toEqual({image_input:true});
  child.releaseRun?.();child.releaseRun?.();
  const second=parent.forRun!();expect(second.capabilities?.()).toEqual({image_input:true});second.releaseRun?.();
  parent.releaseRun?.();expect(()=>parent.forRun!()).toThrow("already settled");
 });
 it("keeps a snapshot across rotation/clear and deletes its key only on Run settlement",async()=>{
  const calls:Array<{model:string;key:string|null}>=[];const cleanup=vi.fn(async()=>undefined);const secrets=new Map([["TRACEGRAPH_CUSTOM_OLD_KEY","old-value"],["TRACEGRAPH_CUSTOM_NEW_KEY","new-value"]]);
  const adapter=new LeasedModelAdapter({resolveCredential:async reference=>secrets.get(reference.match(/secret:([^}]+)/u)![1]!)!});
  adapter.configure({provider:"custom",protocol:"openai-chat-completions",baseUrl:"https://isolated.example/v1",model:"old-model",credentialRef:createSecretReference("TRACEGRAPH_CUSTOM_OLD_KEY")});const run=adapter.forRun();
  vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{calls.push({model:(JSON.parse(String(init.body)) as {model:string}).model,key:new Headers(init.headers).get("authorization")});return Response.json({choices:[{message:{content:JSON.stringify({decision_id:"d",kind:"finish",public_reason:"Done",evidence_refs:[],risk:"none",final_answer:"Done"})}}]});}));
  try{await run.decide(input as never);adapter.configure({provider:"custom",protocol:"openai-chat-completions",baseUrl:"https://isolated.example/v1",model:"new-model",credentialRef:createSecretReference("TRACEGRAPH_CUSTOM_NEW_KEY")});adapter.retireCredential(createSecretReference("TRACEGRAPH_CUSTOM_OLD_KEY"),cleanup);expect(cleanup).not.toHaveBeenCalled();await run.decide(input as never);adapter.clearConfiguration();await run.decide(input as never);expect(calls).toEqual(Array.from({length:3},()=>({model:"old-model",key:"Bearer old-value"})));expect(cleanup).not.toHaveBeenCalled();run.releaseRun?.();await Promise.resolve();expect(cleanup).toHaveBeenCalledTimes(1);run.releaseRun?.();expect(cleanup).toHaveBeenCalledTimes(1);}finally{vi.unstubAllGlobals();}
 });
});
