import {EffectivePermissionPolicySchema,WorkspaceHandleSchema,SubagentWorkspaceBindingSchema,type WorkspaceHandle,type EffectivePermissionPolicy,type SubagentSpec,type SubagentRunLink,type SubagentWorkspaceBinding} from "@tracegraph/contracts";
import {SubagentDomainError} from "./subagent.js";
import {PolicyEngine} from "../tools/policy-engine.js";
import {isAbsolute,relative,resolve,sep} from "node:path";
export interface SubagentWorkspaceRequest {readonly parentWorkspace:WorkspaceHandle;readonly parentPolicy:EffectivePermissionPolicy;readonly link:SubagentRunLink;readonly spec:SubagentSpec;readonly signal:AbortSignal;}
export interface ResolvedSubagentWorkspace {readonly workspace:WorkspaceHandle;readonly permissionPolicy:EffectivePermissionPolicy;readonly binding:SubagentWorkspaceBinding;release():void;}
export type SubagentWorkspaceResolver=(request:SubagentWorkspaceRequest)=>Promise<ResolvedSubagentWorkspace>;
export const subagentRequiresWritableWorkspace=(spec:{readonly tool_allowlist:readonly string[]})=>spec.tool_allowlist.some(tool=>tool==="commit_patch"||tool==="run_test"||tool==="run_project_command");
/** A trusted composition may narrow authority; malformed callback output still fails closed. */
export function validateSubagentWorkspace(parentWorkspace:WorkspaceHandle,parentPolicy:EffectivePermissionPolicy,value:ResolvedSubagentWorkspace):ResolvedSubagentWorkspace {
 const workspace=WorkspaceHandleSchema.parse(value.workspace),permissionPolicy=EffectivePermissionPolicySchema.parse(value.permissionPolicy),binding=SubagentWorkspaceBindingSchema.parse(value.binding);
 const modes={"read-only":0,"workspace-write":1,"danger-full-access":2},approval={never:0,"on-write":1,always:2};
 const contains=(root:string,target:string)=>{const path=relative(resolve(root),resolve(target));return path===""||(!isAbsolute(path)&&path!==".."&&!path.startsWith(`..${sep}`));};
 if(workspace.project_id!==parentWorkspace.project_id||!isAbsolute(workspace.real_root)||contains(parentWorkspace.real_root,workspace.real_root)||contains(workspace.real_root,parentWorkspace.real_root)||workspace.workspace_kind!=="managed_local"||Object.entries(workspace.capabilities).some(([name,enabled])=>enabled&&!parentWorkspace.capabilities[name as keyof typeof parentWorkspace.capabilities])||modes[permissionPolicy.preset.sandbox_mode]>Math.min(1,modes[parentPolicy.preset.sandbox_mode])||approval[permissionPolicy.preset.approval_policy]<approval[parentPolicy.preset.approval_policy]||permissionPolicy.preset.allowed_tools.some(tool=>!parentPolicy.preset.allowed_tools.includes(tool))||JSON.stringify(permissionPolicy.preset.path_scope)!==JSON.stringify(parentPolicy.preset.path_scope)||JSON.stringify(permissionPolicy.host_rules)!==JSON.stringify(parentPolicy.host_rules)||JSON.stringify(permissionPolicy.project_rules)!==JSON.stringify(parentPolicy.project_rules))throw new SubagentDomainError("subagent_workspace_authority_invalid","Child workspace authority exceeds or escapes its parent");
 PolicyEngine.fromEffective(permissionPolicy);
 return {workspace,permissionPolicy,binding,release:()=>value.release()};
}
