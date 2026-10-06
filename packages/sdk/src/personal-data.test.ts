import {describe,expect,it,vi} from "vitest";
import {TraceGraphClient} from "./index.js";
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
const profile={schema_version:"outlive.personal-profile.v1",profile_id:"profile:one",revision:1,updated_at:"2026-10-05T00:00:00Z",last_command_id:"command:profile",source:"local",model_transmission:false,values:{display_name:"Ada",bio:"Local only",avatar_color:"slate"}};
const page={as_of:"2026-10-05T00:00:00Z",complete:true,inventory_complete:true,scanned_runs:1,total_scanned_runs:1,skipped_runs:0,skipped_events:0,scan_limit_reached:false};
describe("personal data typed SDK",()=>{
 it("uses fixed routes and checks profile command identity without mutation retry",async()=>{
   let value:unknown=profile;const transport=vi.fn(async()=>response(value)),client=new TraceGraphClient({token:"fixture",fetch:transport});
   const input={command_id:"command:profile",expected_revision:0,values:{display_name:"Ada",bio:"Local only",avatar_color:"slate" as const}};
   expect(await client.updatePersonalProfile(input)).toEqual(profile);expect(String(transport.mock.calls[0]![0])).toContain("/api/workbench/personal/profile");
   value={...profile,last_command_id:"command:other"};await expect(client.updatePersonalProfile(input)).rejects.toThrow(/bound command/);
   value={command_id:"command:other",state:"completed",result:profile};await expect(client.getPersonalProfileCommandReceipt(input.command_id)).rejects.toThrow(/command scope/);
   const lost=vi.fn(async()=>{throw new TypeError("Synthetic dropped response");}),offline=new TraceGraphClient({token:"fixture",fetch:lost});await expect(offline.updatePersonalProfile(input)).rejects.toThrow();expect(lost).toHaveBeenCalledOnce();
 });
 it("binds public search hits to requested scope and excludes extra private fields",async()=>{
   const hit={project_id:"project:one",session_id:"session:one",run_id:"run:one",event_id:"event:answer",sequence:5,source:"answer",occurred_at:"2026-10-04T00:00:00Z",status:"completed",archived:false,title:"Public title",excerpt:"Public report"};let value:unknown={schema_version:"outlive.public-search.v1",query:"report",order:"inventory-page",hits:[hit],page};
   const transport=vi.fn(async()=>response(value)),client=new TraceGraphClient({token:"fixture",fetch:transport}),input={q:"report",project_id:"project:one",session_id:"session:one",status:"completed" as const,archive:"active" as const,limit:20};
   expect((await client.searchPublicSessions(input)).hits[0]!.run_id).toBe("run:one");const url=new URL(String(transport.mock.calls[0]![0]));expect(url.searchParams.get("project_id")).toBe("project:one");
   for(const changed of [{project_id:"project:other"},{session_id:"session:other"},{status:"failed"},{archived:true},{reasoning_content:"private"}]){value={schema_version:"outlive.public-search.v1",query:"report",order:"inventory-page",hits:[{...hit,...changed}],page};await expect(client.searchPublicSessions(input)).rejects.toThrow();}
 });
 it("validates UTC usage boundaries rather than accepting a different date range",async()=>{
   const totals={run_count:0,completed_runs:0,failed_runs:0,cancelled_runs:0,interrupted_runs:0,active_runs:0,model_call_count:0,reported_request_count:0,unreported_model_call_count:0,input_tokens:0,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0,total_tokens:0,cost_status:"unknown",costs:[]};let value:unknown={schema_version:"outlive.personal-usage.v1",source:"ledger",timezone:"UTC",from_day:"2026-10-04",to_day:"2026-10-04",project_count:0,session_count:0,totals,days:[{day:"2026-10-04",...totals}],page};const client=new TraceGraphClient({token:"fixture",fetch:vi.fn(async()=>response(value))}),input={from_day:"2026-10-04",to_day:"2026-10-04"};expect((await client.queryPersonalUsage(input)).totals.cost_status).toBe("unknown");value={...value as object,to_day:"2026-10-05"};await expect(client.queryPersonalUsage(input)).rejects.toThrow(/UTC range/);
 });
});
