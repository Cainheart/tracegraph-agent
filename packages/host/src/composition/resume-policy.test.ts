import {describe,it,expect,vi} from "vitest";
import {BUILTIN_PERMISSION_PRESETS,type RunProjection,type WorkspaceHandle} from "@tracegraph/contracts";
import {createEffectivePermissionPolicy} from "@tracegraph/core";
import {RecoveredRunPolicyGuard} from "./resume-policy.js";

describe("recovered Session permission selection",()=>{
 it("resolves the exact recovered Session policy rather than its global default",async()=>{
  const workspace={project_id:"project:1"} as WorkspaceHandle;
  const full=createEffectivePermissionPolicy({preset:BUILTIN_PERMISSION_PRESETS["full-write"],rules:[]});
  const readonly=createEffectivePermissionPolicy({preset:BUILTIN_PERMISSION_PRESETS["read-only"],rules:[]});
  const projection={project_id:"project:1",session_id:"session:explicit-full",run_id:"run:1",status:"interrupted",permission:{policy_digest:full.policy_digest}} as RunProjection;
  const resolve=vi.fn(async(_workspace:WorkspaceHandle,run:RunProjection)=>run.session_id==="session:explicit-full"?full:readonly);
  const guard=new RecoveredRunPolicyGuard(resolve,{snapshot:()=>({active_tool_names:[]}) as never,policyRules:()=>[]});
  await expect(guard.beforeResume(projection,workspace)).resolves.toBeUndefined();
  expect(resolve).toHaveBeenCalledWith(workspace,projection);
  await expect(guard.beforeResume({...projection,session_id:"session:without-grant"},workspace)).rejects.toMatchObject({code:"resume_policy_changed"});
 });
 it("continues to reject changed extension grants before recovered approval",async()=>{
  const workspace={project_id:"project:1"} as WorkspaceHandle;
  const policy=createEffectivePermissionPolicy({preset:BUILTIN_PERMISSION_PRESETS["workspace-write"],rules:[]});
  const projection={project_id:"project:1",session_id:"session:1",run_id:"run:1",status:"interrupted",permission:{policy_digest:policy.policy_digest}} as RunProjection;
  let tools:string[]=[];
  const guard=new RecoveredRunPolicyGuard(async()=>policy,{snapshot:()=>({active_tool_names:tools}) as never,policyRules:()=>[]});
  await guard.beforeResume(projection,workspace);
  tools=["trusted-new-tool"];
  await expect(guard.beforeApproval(projection,workspace)).rejects.toMatchObject({code:"resume_policy_changed"});
 });
});
