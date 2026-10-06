import {describe,it,expect} from "vitest";
import {NativeRunNavigationSchema} from "./application-runtime.js";
import {UpdateWorkbenchSettingsRequestSchema,WorkbenchSettingsValuesSchema} from "./local-workbench.js";
describe("APP-105 closed native preferences and navigation",()=>{
 it("preserves legacy settings and keeps sleep prevention opt-in without synthesized unrelated settings",()=>{expect(WorkbenchSettingsValuesSchema.parse({}).general.prevent_sleep_during_tasks).toBeUndefined();expect(UpdateWorkbenchSettingsRequestSchema.parse({command_id:"sleep-on",expected_revision:0,patch:{general:{prevent_sleep_during_tasks:true}}})).toEqual({command_id:"sleep-on",expected_revision:0,patch:{general:{prevent_sleep_during_tasks:true}}});expect(()=>UpdateWorkbenchSettingsRequestSchema.parse({command_id:"sleep-on",expected_revision:0,patch:{general:{prevent_sleep_during_tasks:"yes"}}})).toThrow();});
 it("rejects native navigation execution authority and invalid generations",()=>{const input={event_id:"event:canonical",run_id:"run:one",project_id:"project:one",connection_generation:1};expect(NativeRunNavigationSchema.parse(input)).toEqual(input);expect(()=>NativeRunNavigationSchema.parse({...input,command_id:"execute"})).toThrow();expect(()=>NativeRunNavigationSchema.parse({...input,connection_generation:1.5})).toThrow();});
});
