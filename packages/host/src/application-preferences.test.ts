import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect} from "vitest";
import {ConfigurableModelAdapter,type AgentRuntime} from "@tracegraph/core";
import {createWorkbenchControl,type WorkbenchControlContext} from "./workbench-control.js";
import {WorkspaceCoordinator} from "./workspace-coordinator.js";
import type {PermissionConfigController} from "./composition/permission-config.js";
describe("APP-105 shared persisted native preference",()=>{
 it("persists opt-in with CAS/history, preserves existing notification settings, and restores as a new revision",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-app105-"));
  const context:WorkbenchControlContext={profileRoot:root,profileId:"profile:app105",runtime:{inspectSkills:async()=>[]} as unknown as AgentRuntime,model:new ConfigurableModelAdapter(),workspaceCoordinator:new WorkspaceCoordinator(),permissionConfig:{snapshot:()=>({selected_preset:{sandbox_mode:"read-only"}})} as unknown as PermissionConfigController,resolveWorkspace:async()=>{throw new Error("No project");},listProjects:()=>[],getModelConfig:()=>({provider:"openai",protocol:"openai",configured:false,base_url:"https://api.openai.com/v1",model:"",has_key:false}),startRun:async()=>{throw new Error("Must not dispatch");},readSession:async()=>{throw new Error("No session");}};
  let control=await createWorkbenchControl(context);try{
   const original=await control.settings();expect(original.settings.general.prevent_sleep_during_tasks??false).toBe(false);expect(original.fields.find(field=>field.path==="general.prevent_sleep_during_tasks")).toMatchObject({source:"default",writable:true,effective:"immediate"});
   await control.updateSettings({command_id:"notifications-off",expected_revision:0,patch:{general:{notify_completed:false}}});
   const input={command_id:"sleep-enabled",expected_revision:1,patch:{general:{prevent_sleep_during_tasks:true}}};
   const changed=await control.updateSettings(input);expect(changed.settings.general).toMatchObject({prevent_sleep_during_tasks:true,notify_completed:false,notify_approval:true});expect(changed.pending_restart).toEqual([]);expect(changed.fields.find(field=>field.path==="general.prevent_sleep_during_tasks")?.effective).toBe("immediate");
   expect((await control.updateSettings(input)).revision).toBe(2);
   await expect(control.updateSettings({command_id:"stale-sleep",expected_revision:1,patch:{general:{prevent_sleep_during_tasks:false}}})).rejects.toMatchObject({code:"settings_revision_conflict"});
   expect(JSON.parse(await readFile(join(root,"workbench-settings.json"),"utf8")).settings.general.prevent_sleep_during_tasks).toBe(true);
   const history=await control.settingsHistory();expect(history.entries[0]?.settings.general.prevent_sleep_during_tasks).toBe(true);
   await control.close();control=await createWorkbenchControl(context);expect((await control.settings()).settings.general.prevent_sleep_during_tasks).toBe(true);
   const restored=await control.restoreSettings({command_id:"sleep-restore",expected_revision:2,target_revision:1});expect(restored.snapshot.revision).toBe(3);expect(restored.snapshot.settings.general.prevent_sleep_during_tasks??false).toBe(false);expect(restored.snapshot.settings.general.notify_completed).toBe(false);
  }finally{await control.close();await rm(root,{recursive:true,force:true});}
 });
});
