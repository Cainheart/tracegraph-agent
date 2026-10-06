import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {describe,expect,it,vi} from "vitest";
import type {TraceGraphClient} from "@tracegraph/sdk";
import type {DesktopBridgeApi} from "./bridge-contract.js";
import {createDesktopSdkPort} from "./desktop-sdk.js";
import {invokeDirectDesktopRoute} from "./direct-routes.js";
import {DESKTOP_IPC} from "./ipc-channels.js";

const managementOperations=["listManagedSkills","readManagedSkill","validateManagedSkill","managedSkillCommand","getManagedSkillCommandReceipt","getVisualRetentionSettings","updateVisualRetentionSettings","listVisualEvidence","pinVisualEvidence","cleanupVisualEvidence","getVisualEvidenceCommandReceipt"] as const;
type ManagementOperation=(typeof managementOperations)[number];
const sha=`sha256:${"0".repeat(64)}`,scope={kind:"global" as const};
const settings={schema_version:"outlive.visual-retention.v1",profile_id:"profile:fixture",revision:0,updated_at:null,last_command_id:null,values:{retention_days:30,automatic_cleanup:true},legacy_policy:"retain-unregistered"};
const entry={evidence_id:"evidence:one",source:"browser",project_id:"project:one",captured_at:"2026-10-05T00:00:00.000Z",sha256:sha,byte_length:128,mime_type:"image/png",revision:0,pinned:false,state:"retained",run_artifacts:[]};
const skillEntry={name:"fixture-skill",sha256:sha,byte_length:10,enabled:true,removed:false,diagnostics:[]};
const skillCommand={type:"save" as const,command_id:"skill:save",scope,name:"fixture-skill",expected_sha256:sha,content:"# Explicit local content"};
const examples:Array<{operation:ManagementOperation;args:unknown[];reply:unknown;parsedArgs?:unknown[]}>= [
 {operation:"listManagedSkills",args:[scope],reply:{scope,state_sha256:sha,state_revision:0,entries:[skillEntry],conflicts:[],diagnostics:[],effective:"new-run",legacy_disabled_names:[]}},
 {operation:"readManagedSkill",args:[{scope,name:"fixture-skill"}],reply:{...skillEntry,scope,content:"# Explicit local content"}},
 {operation:"validateManagedSkill",args:[{name:"fixture-skill",content:"# Explicit local content"}],reply:{valid:false,sha256:sha,diagnostics:["Required metadata is missing"]}},
 {operation:"managedSkillCommand",args:[skillCommand],reply:{command_id:"skill:save",scope,name:"fixture-skill",status:"conflict",code:"skill_revision_conflict",sha256:sha,effective:"new-run"}},
 {operation:"getManagedSkillCommandReceipt",args:["skill:save"],reply:{command_id:"skill:save",state:"unknown",observed_sha256:sha,code:"skill_outcome_unknown"}},
 {operation:"getVisualRetentionSettings",args:[],reply:settings},
 {operation:"updateVisualRetentionSettings",args:[{command_id:"retention:update",expected_revision:0,values:{retention_days:1,automatic_cleanup:false}}],reply:settings},
 {operation:"listVisualEvidence",args:[{}],parsedArgs:[{limit:50,offset:0}],reply:{source:"registered-provenance",entries:[entry],total:1,legacy_policy:"retain-unregistered"}},
 {operation:"pinVisualEvidence",args:["evidence:one",{command_id:"pin:one",expected_revision:0,pinned:true}],reply:{...entry,pinned:true}},
 {operation:"cleanupVisualEvidence",args:[{command_id:"cleanup:one"}],parsedArgs:[{command_id:"cleanup:one",limit:50}],reply:{command_id:"cleanup:one",status:"unknown",deleted:[],unknown:["evidence:one"],deleted_bytes:0,checked_at:"2026-10-05T00:00:00.000Z",more_expired:false}},
 {operation:"getVisualEvidenceCommandReceipt",args:["cleanup:one"],reply:{command_id:"cleanup:one",state:"unknown",operation:"visual.evidence.cleanup",observed_bytes:[{evidence_id:"evidence:one",all_registered_bytes_absent:false,present_copies:1,unverifiable_copies:0}]}},
];

describe("Closed Desktop Skill and visual-evidence management",()=>{
 it("dispatches each fixed typed operation once, including bounded query defaults and truthful conflict/unknown receipts",async()=>{
  for(const example of examples){const operation=vi.fn(async()=>example.reply),client={[example.operation]:operation} as unknown as TraceGraphClient;
   await expect(invokeDirectDesktopRoute(client,example.operation,example.args)).resolves.toEqual(example.reply);
   expect(operation).toHaveBeenCalledOnce();expect(operation).toHaveBeenCalledWith(...example.parsedArgs??example.args);
  }
 });
 it("rejects Skill filesystem/authority injection and oversized content before any Host command",async()=>{
  const command=vi.fn(),client={managedSkillCommand:command} as unknown as TraceGraphClient;
  for(const input of [{...skillCommand,source_path:"/private/arbitrary/SKILL.md"},{...skillCommand,root:"/arbitrary"},{...skillCommand,scope:{kind:"project"}},{...skillCommand,approval:{approval_id:"approval:one",decision:"approve",policy:"full-write"}},{...skillCommand,content:"x".repeat(256*1024+1)}])await expect(invokeDirectDesktopRoute(client,"managedSkillCommand",[input])).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();
 });
 it("rejects deletion paths, unscoped Run filters and unbounded inventories before any Host method",async()=>{
  const cleanup=vi.fn(),list=vi.fn(),client={cleanupVisualEvidence:cleanup,listVisualEvidence:list} as unknown as TraceGraphClient;
  for(const input of [{command_id:"cleanup:one",path:"/private/capture.png"},{command_id:"cleanup:one",run_id:"run:foreign"},{command_id:"cleanup:one",limit:101}])await expect(invokeDirectDesktopRoute(client,"cleanupVisualEvidence",[input])).rejects.toThrow();
  for(const input of [{run_id:"run:foreign"},{limit:101},{offset:10001},{scope:"all-files"}])await expect(invokeDirectDesktopRoute(client,"listVisualEvidence",[input])).rejects.toThrow();
  expect(cleanup).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();
 });
 it("refuses private paths, pixel bytes and invalid replies at the renderer boundary",async()=>{
  const listVisualEvidence=vi.fn(async()=>({source:"registered-provenance",entries:[{...entry,path:"/private/capture.png"}],total:1,legacy_policy:"retain-unregistered"}));
  await expect(invokeDirectDesktopRoute({listVisualEvidence} as unknown as TraceGraphClient,"listVisualEvidence",[{}])).rejects.toThrow();
  const getVisualRetentionSettings=vi.fn(async()=>({...settings,credential_ref:"renderer-secret"}));
  await expect(invokeDirectDesktopRoute({getVisualRetentionSettings} as unknown as TraceGraphClient,"getVisualRetentionSettings",[])).rejects.toThrow();
  const getManagedSkillCommandReceipt=vi.fn(async()=>({command_id:"skill:save",state:"unknown",bytes:new Uint8Array([1])}));
  await expect(invokeDirectDesktopRoute({getManagedSkillCommandReceipt} as unknown as TraceGraphClient,"getManagedSkillCommandReceipt",["skill:save"])).rejects.toThrow();
 });
 it("keeps receipt inspection and validation in Main read authority while all effects stay mutations",async()=>{
  const main=await readFile(new URL("./main.ts",import.meta.url),"utf8"),reads=/const readChannels=new Set<string>\(\[([^\]]+)\]\)/u.exec(main)![1]!;
  for(const name of ["listManagedSkills","readManagedSkill","validateManagedSkill","getManagedSkillCommandReceipt","getVisualRetentionSettings","listVisualEvidence","getVisualEvidenceCommandReceipt"])expect(reads).toContain(`DESKTOP_IPC.${name},`);
  for(const name of ["managedSkillCommand","updateVisualRetentionSettings","pinVisualEvidence","cleanupVisualEvidence"])expect(reads).not.toContain(`DESKTOP_IPC.${name}`);
 });
 it("exposes only the eleven fixed channels from the compiled sandbox preload",async()=>{
  const source=await readFile(new URL("../dist/preload.cjs",import.meta.url),"utf8");let bridge!:DesktopBridgeApi;
  const invoke=vi.fn(async()=>undefined),listeners:string[]=[];
  runInNewContext(source,{exports:{},require:(name:string)=>{expect(name).toBe("electron");return {contextBridge:{exposeInMainWorld:(_name:string,value:DesktopBridgeApi)=>{bridge=value;}},ipcRenderer:{invoke,on:(channel:string)=>listeners.push(channel)}};},queueMicrotask});
  for(const example of examples){await (bridge[example.operation] as (...args:unknown[])=>Promise<unknown>)(...example.args);expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC[example.operation],...example.args);}
  expect(invoke).toHaveBeenCalledTimes(examples.length);expect(listeners).toEqual(["tracegraph:native-run-requested"]);expect(bridge).not.toHaveProperty("invoke");expect(bridge).not.toHaveProperty("readFile");
 });
 it("forwards through the shared Desktop SDK without repeating effects or inventing completion",async()=>{
  const methods=Object.fromEntries(examples.map(example=>[example.operation,vi.fn(async()=>example.reply)]));const sdk=createDesktopSdkPort(methods as unknown as DesktopBridgeApi);
  for(const example of examples){const result=await (sdk[example.operation] as (...args:unknown[])=>Promise<unknown>)(...example.args);expect(result).toBe(example.reply);expect(methods[example.operation]).toHaveBeenCalledOnce();}
 });
});
