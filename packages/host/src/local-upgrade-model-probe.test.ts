import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect,vi} from "vitest";
import {ConfigurableModelAdapter} from "@tracegraph/core";
import {ModelCapabilityControl} from "./model-capability-control.js";
import {LocalOwnerAdmission,LocalOwnerUpgrade,assertSettledLocalFacts} from "./local-host-upgrade.js";

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"outlive-upgrade-model-probe-"));let calls=0,release:(()=>void)|undefined;
 const server=createServer(async(request,response)=>{let raw="";for await(const part of request)raw+=String(part);const body=JSON.parse(raw) as {messages:Array<{content:string}>};calls++;const challenge=body.messages[0]!.content.split(": ").at(-1)!;release=()=>{if(response.destroyed||response.writableEnded)return;response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{message:{content:challenge},finish_reason:"stop"}]}));};});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("Isolated provider unavailable");
 const adapter=new ConfigurableModelAdapter({resolveCredential:async()=>"isolated-probe-key"});adapter.configure({provider:"custom",protocol:"openai-chat-completions",baseUrl:`http://127.0.0.1:${address.port}/v1`,model:"isolated-upgrade-probe",credentialRef:"${secret:ISOLATED_PROBE_KEY}"});
 const admission=new LocalOwnerAdmission(),profileId=randomUUID(),nonce=randomUUID(),upgrade=new LocalOwnerUpgrade(root,profileId,nonce,"a".repeat(64),admission);await upgrade.initialize();
 const input={command_id:"upgrade:after-probe",profile_id:profileId,owner_nonce:nonce,source_build_id:"a".repeat(64),target_build_id:"b".repeat(64)};
 return {root,adapter,upgrade,input,calls:()=>calls,release:()=>release?.(),inspect:()=>assertSettledLocalFacts(root,join(root,"data")),close:async()=>{release?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}};
}
const testInput={command_id:"probe:actual-readonly",expected_revision:1,model:"isolated-upgrade-probe",features:["text"] as "text"[],confirmed:true as const};
describe("readonly model probe settlement and owner upgrade",()=>{
 it("blocks a real held request and its receipt projection, then upgrades after a successful response without usage",async()=>{
  const f=await fixture();let project!:()=>void;const control=await ModelCapabilityControl.open({profileRoot:f.root,capture:()=>({adapter:f.adapter,provider:"custom",protocol:"openai-chat-completions",revision:1}),record:()=>new Promise<void>(done=>{project=done;})});
  try{const pending=control.test("connection:isolated",testInput);await vi.waitFor(()=>expect(f.calls()).toBe(1));expect(control.pending).toBe(1);await expect(f.upgrade.prepare(f.input,f.inspect,()=>({busy:control.pending>0,resume(){}}))).rejects.toMatchObject({code:"host_upgrade_busy"});expect((await f.upgrade.receipt(f.input.command_id)).state).toBe("not_found");f.release();await vi.waitFor(()=>expect(project).toBeTypeOf("function"));expect(control.pending).toBe(1);await expect(f.upgrade.prepare(f.input,f.inspect,()=>({busy:control.pending>0,resume(){}}))).rejects.toMatchObject({code:"host_upgrade_busy"});project();const result=await pending;expect(result.results).toMatchObject([{status:"passed",dispatched:true,usage_status:"unknown",evidence:"exact_text"}]);expect(control.pending).toBe(0);const before=await control.receipt(testInput.command_id);await f.inspect();expect(await f.upgrade.prepare(f.input,f.inspect,()=>({busy:control.pending>0,resume(){}}))).toMatchObject({state:"prepared"});await f.upgrade.recordRetired();expect(await control.receipt(testInput.command_id)).toEqual(before);expect(f.calls()).toBe(1);}
  finally{project?.();control.close();await f.close();}
 });
 it("preserves the actual aborted readonly probe's unknown result without replay or a permanent file-effect lock",async()=>{
  const f=await fixture(),control=await ModelCapabilityControl.open({profileRoot:f.root,capture:()=>({adapter:f.adapter,provider:"custom",protocol:"openai-chat-completions",revision:1})});
  try{const pending=control.test("connection:isolated",testInput);await vi.waitFor(()=>expect(f.calls()).toBe(1));expect(control.pending).toBe(1);control.close();const result=await pending;expect(result.results).toMatchObject([{status:"unknown",dispatched:true,usage_status:"unknown",code:"model_timeout"}]);expect(control.pending).toBe(0);const receipt=await control.receipt(testInput.command_id);await f.inspect();expect(await f.upgrade.prepare(f.input,f.inspect,()=>({busy:control.pending>0,resume(){}}))).toMatchObject({state:"prepared"});await f.upgrade.recordRetired();expect(await control.receipt(testInput.command_id)).toEqual(receipt);expect(f.calls()).toBe(1);}
  finally{control.close();await f.close();}
 });
});
