import {createServer, type Server} from "node:http";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {PrivateFileCredentialStore} from "@tracegraph/core";
import {createHostComposition} from "./composition/host-composition.js";

const origin="http://127.0.0.1:4310";
const apiKey="catalog-fixture-key-must-not-leak";

async function setup(){
 const root=await mkdtemp(join(tmpdir(),"outlive-model-catalog-"));
 let responseStatus=200;
 const authHeaders:string[]=[];
 const provider:Server=createServer((request,response)=>{
  authHeaders.push(String(request.headers.authorization??""));
  response.writeHead(responseStatus,{"content-type":"application/json"});
  response.end(JSON.stringify(responseStatus===200?{data:[
   {id:"deepseek-flash",name:"DeepSeek-V4.1-Flash",context_window:1_048_576,max_output_tokens:393_216,input_modalities:["text","image"],output_modalities:["text"],effort:{supported_levels:["low","high","max"],default_level:"high"}},
   {id:"future-model-without-capability-data"},
  ]}:{error:{message:"Invalid API key"}}));
 });
 await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
 const address=provider.address();if(!address||typeof address==="string")throw new Error("Fixture provider did not bind a TCP port");
 const composition=await createHostComposition({profileRoot:root,dataDir:join(root,"data"),sessionDir:join(root,"sessions"),permissionConfigPath:join(root,"permissions.json"),credentialStore:new PrivateFileCredentialStore(join(root,"credentials.json")),environment:{},useEnvironmentModel:false,nativePicker:false,nativePermissionPrompts:false,admission:"workspace"});
 const bootstrap=await composition.host.app.inject({method:"GET",url:"/api/bootstrap",headers:{origin}});
 expect(bootstrap.statusCode).toBe(200);
 const token=String(bootstrap.json().token);
 const post=(url:string,payload:Record<string,unknown>)=>composition.host.app.inject({method:"POST",url,headers:{origin,authorization:`Bearer ${token}`,"x-tracegraph-command-id":String(payload.command_id)},payload});
 return {root,provider,composition,authHeaders,post,baseUrl:`http://127.0.0.1:${address.port}/v1`,setResponseStatus(value:number){responseStatus=value;}};
}

describe("Host model catalog discovery",()=>{
 let current:Awaited<ReturnType<typeof setup>>|undefined;
 afterEach(async()=>{try{if(current){try{await current.composition.close();}finally{current.provider.closeAllConnections();await new Promise<void>(resolve=>current!.provider.close(()=>resolve()));await rm(current.root,{recursive:true,force:true});}}}finally{current=undefined;vi.unstubAllGlobals();}});

 it("uses the Host-owned saved key, keeps unknown capabilities unknown, and persists only catalog metadata",async()=>{
  current=await setup();
  const saved=await current.post("/api/workbench/models",{command_id:"catalog-save",label:"DeepSeek fixture",provider:"deepseek",protocol:"openai-chat-completions",base_url:current.baseUrl,model:"deepseek-v4-flash",models:["deepseek-v4-flash"],api_key:apiKey});
  expect(saved.statusCode).toBe(200);
  const connection=saved.json().connections[0] as {connection_id:string;revision:number};
  const result=await current.post(`/api/workbench/models/${connection.connection_id}/discover`,{command_id:"catalog-discover",expected_revision:connection.revision});
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({status:"succeeded",models:[
   {id:"deepseek-flash",name:"DeepSeek-V4.1-Flash",capability_status:"confirmed",source:"provider_response",context_window_tokens:1_048_576,max_output_tokens:393_216,input_modalities:["text","image"],output_modalities:["text"],reasoning_efforts:["low","high","max"],reasoning_default:"high"},
   {id:"future-model-without-capability-data",capability_status:"unknown",source:"model_id_only"},
  ]});
  expect(current.authHeaders).toEqual([`Bearer ${apiKey}`]);
  const registry=await readFile(join(current.root,"model-connections.json"),"utf8");
  expect(registry).toContain("future-model-without-capability-data");
  expect(registry).not.toContain(apiKey);
  const journalFiles=await readdir(join(current.root,"conversation-events"));
  const journal=(await Promise.all(journalFiles.filter(name=>name.endsWith(".jsonl")).map(name=>readFile(join(current!.root,"conversation-events",name),"utf8")))).join("\n");
  expect(journal).not.toContain(apiKey);
 });

 it("projects live DeepSeek effort choices onto the configured legacy alias",async()=>{
  current=await setup();
  const observed:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
   observed.push(`${String(url)}|${String(new Headers(init?.headers).get("authorization"))}`);
   return Response.json({data:[{id:"deepseek-flash",name:"DeepSeek-V4.1-Flash",context_window:1_048_576,max_output_tokens:393_216,input_modalities:["text","image"],output_modalities:["text"],effort:{supported_levels:["low","high","max"],default_level:"high"}}]});
  }));
  const saved=await current.post("/api/workbench/models",{command_id:"catalog-alias-save",label:"DeepSeek",provider:"deepseek",protocol:"openai-chat-completions",base_url:"https://api.deepseek.com/v1",model:"deepseek-v4-flash",models:["deepseek-v4-flash"],api_key:apiKey});
  const connection=saved.json().connections[0] as {connection_id:string;revision:number};
  const result=await current.post(`/api/workbench/models/${connection.connection_id}/discover`,{command_id:"catalog-alias-discover",expected_revision:connection.revision});
  expect(result.statusCode).toBe(200);
  expect(observed).toEqual([`https://api.deepseek.com/v1/models|Bearer ${apiKey}`]);
  expect(current.composition.conversationControl.snapshot().connections[0]).toMatchObject({
   model:"deepseek-v4-flash",
   reasoning_by_model:{"deepseek-v4-flash":["default","low","high","max"]},
  });
 });

 it("returns a safe authentication error without echoing the provider response or key",async()=>{
  current=await setup();
  const saved=await current.post("/api/workbench/models",{command_id:"catalog-auth-save",label:"Invalid fixture",provider:"custom",protocol:"openai-chat-completions",base_url:current.baseUrl,model:"fixture",api_key:apiKey});
  const connection=saved.json().connections[0] as {connection_id:string;revision:number};
  current.setResponseStatus(401);
  const result=await current.post(`/api/workbench/models/${connection.connection_id}/discover`,{command_id:"catalog-auth-discover",expected_revision:connection.revision});
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({status:"failed",error_code:"model_catalog_authentication_failed",models:[]});
  expect(JSON.stringify(result.json())).not.toContain(apiKey);
  expect(JSON.stringify(result.json())).not.toContain("Invalid API key");
 });
});
