import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {PrivateFileCredentialStore,type ModelAdapter} from '@tracegraph/core';
import {WorkbenchSettingsValuesSchema} from '@tracegraph/contracts';
import {createHostComposition} from './composition/host-composition.js';

async function fixture(model:ModelAdapter){
 const root=await mkdtemp(join(tmpdir(),'outlive-host-delivery-admission-')),projectRoot=join(root,'project');await mkdir(projectRoot);await writeFile(join(projectRoot,'source.txt'),'USER_SOURCE_BYTES');
 const composition=await createHostComposition({profileRoot:root,deliveryBudget:{max_tokens:200_000,max_time_ms:900_000},dataDir:join(root,'data'),sessionDir:join(root,'sessions'),permissionConfigPath:join(root,'permission.json'),credentialStore:new PrivateFileCredentialStore(join(root,'credentials.json')),environment:{TRACEGRAPH_PERMISSION_PRESET:'full-write'},runtimeModel:model,useEnvironmentModel:false,nativePicker:false,nativePermissionPrompts:false,admission:'workspace',settings:WorkbenchSettingsValuesSchema.parse({memory:{memory_recall:false,experience_recall:false}})});
 const project=await composition.registerProject(projectRoot,'read_write');project.workspace.capabilities.index=false;
 return{composition,project,async assertUntouched(){expect(await readFile(join(projectRoot,'source.txt'),'utf8')).toBe('USER_SOURCE_BYTES');expect(composition.workspaceCoordinator.list()).toEqual([]);},async close(){await composition.close();await rm(root,{recursive:true,force:true});}};
}
const answer={decision_id:'unexpected',kind:'finish' as const,public_reason:'Must not dispatch',evidence_refs:[],risk:'none' as const,final_answer:'Unexpected result'};
describe('explicitly budgeted compatibility fixture delivery admission',()=>{
 it('rejects an unsupported adapter rather than silently disabling production review',async()=>{
  let calls=0;const f=await fixture({name:'unsupported-host-adapter',async decide(){calls++;return answer;}});
  try{await expect(f.composition.host.runSessions.startRun({command_id:'host:unsupported',project_id:f.project.workspace.project_id,task:'Implement this project',mode:'execute'})).rejects.toMatchObject({code:'delivery_budget_adapter_unsupported'});expect(calls).toBe(0);await f.assertUntouched();}
  finally{await f.close();}
 });
 it('the production-composed Runtime checks and releases an unsupported per-Run binding',async()=>{
  let calls=0,releases=0;const model:ModelAdapter={name:'outer-budget-facade',supportsRequestBudget:true,async decide(){calls++;return answer;},forRun(){return{name:'bound-unsupported',async decide(){calls++;return answer;},releaseRun(){releases++;}};}};
  const f=await fixture(model);
  try{await expect(f.composition.runtime.startRun({command_id:'host:bound-unsupported',project_id:f.project.workspace.project_id,workspace:f.project.workspace,task:'Implement this project',mode:'execute'})).rejects.toMatchObject({code:'delivery_budget_adapter_unsupported'});expect(calls).toBe(0);expect(releases).toBe(1);await f.assertUntouched();}
  finally{await f.close();}
 });
});
