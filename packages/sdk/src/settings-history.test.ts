import {describe,it,expect} from "vitest";
import {WorkbenchSettingsValuesSchema} from "@tracegraph/contracts";
import {TraceGraphClient} from "./index.js";

describe("typed settings inheritance/history transport",()=>{
 it("uses only fixed settings routes with exact command IDs and partial overrides",async()=>{
  const requests:Array<{url:string;method:string;command:string|null;body?:unknown}>=[];
  const options={mode:"execute",reasoning_effort:"high",permission_preset:"read-only"};
  const snapshot={config_version:"outlive.workbench.v1",revision:2,profile_id:"profile:fixture",settings:WorkbenchSettingsValuesSchema.parse({}),fields:[],pending_restart:[]};
  const client=new TraceGraphClient({token:"isolated-test-token",fetch:async(input,init)=>{
   const url=String(input),method=init?.method??"GET";requests.push({url,method,command:new Headers(init?.headers).get("x-tracegraph-command-id"),...(init?.body?{body:JSON.parse(String(init.body))}:{})});
   if(url.endsWith("/history"))return Response.json({profile_id:"profile:fixture",current_revision:2,entries:[],has_more:false});
   if(url.endsWith("/restore"))return Response.json({snapshot,restored_from_revision:0,preserved_sections:[]});
   if(url.endsWith("/reset"))return Response.json({session_id:"session:fixture",revision:3,options,overrides:{},fields:[]});
   return Response.json({project_id:"project:fixture",revision:method==="GET"?0:1,overrides:method==="GET"?{}:{reasoning_effort:"low"},options,fields:[]});
  }});
  await client.getWorkbenchSettingsHistory();await client.restoreWorkbenchSettings({command_id:"restore:one",expected_revision:1,target_revision:0});
  await client.getProjectRunDefaults("project:fixture");await client.updateProjectRunDefaults("project:fixture",{command_id:"project:one",expected_revision:0,overrides:{reasoning_effort:"low"}});
  await client.resetSessionRunOptions("session:fixture",{command_id:"session:reset",expected_revision:2,fields:["permission_preset"]});
  expect(requests.map(request=>request.url.replace(/^https?:\/\/[^/]+/u,""))).toEqual(["/api/workbench/settings/history","/api/workbench/settings/restore","/api/workbench/projects/project%3Afixture/defaults","/api/workbench/projects/project%3Afixture/defaults","/api/workbench/sessions/session%3Afixture/options/reset"]);
  expect(requests[1]).toMatchObject({method:"POST",command:"restore:one",body:{command_id:"restore:one",expected_revision:1,target_revision:0}});
  expect(requests[3]?.body).toEqual({command_id:"project:one",expected_revision:0,overrides:{reasoning_effort:"low"}});
  expect(requests[4]?.body).toEqual({command_id:"session:reset",expected_revision:2,fields:["permission_preset"]});
 });
 it("rejects malformed restore and model/credential project defaults before dispatch",async()=>{
  let requests=0;const client=new TraceGraphClient({token:"isolated-test-token",fetch:async()=>{requests++;return Response.json({});}});
  await expect(client.restoreWorkbenchSettings({command_id:"invalid",expected_revision:-1,target_revision:0})).rejects.toThrow();
  await expect(client.updateProjectRunDefaults("project:fixture",{command_id:"invalid",expected_revision:0,overrides:{api_key:"synthetic"} as never})).rejects.toThrow();expect(requests).toBe(0);
 });
});
