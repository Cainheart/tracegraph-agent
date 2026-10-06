import {describe,expect,it} from "vitest";
import {BUILTIN_PERMISSION_PRESETS,MANAGED_LOCAL_CAPABILITIES,SubagentWorkspaceBindingSchema,type WorkspaceHandle} from "@tracegraph/contracts";
import {createEffectivePermissionPolicy} from "../tools/policy-engine.js";
import {validateSubagentWorkspace,type ResolvedSubagentWorkspace} from "./workspace.js";
const parent:WorkspaceHandle={project_id:"p",handle_id:"source",real_root:"/tmp/source",workspace_kind:"managed_local",capabilities:{...MANAGED_LOCAL_CAPABILITIES},created_at:"2026-10-05T00:00:00Z"};
const parentPolicy=createEffectivePermissionPolicy({preset:BUILTIN_PERMISSION_PRESETS["full-write"]});
const narrow=createEffectivePermissionPolicy({preset:{...parentPolicy.preset,key:"custom",sandbox_mode:"workspace-write"}});
const binding=SubagentWorkspaceBindingSchema.parse({binding_id:"child:fixture",baseline_digest:`sha256:${"0".repeat(64)}`,source_head:"0".repeat(40),source_index_hash:`sha256:${"1".repeat(64)}`,source_tree_hash:`sha256:${"2".repeat(64)}`});
const value=():ResolvedSubagentWorkspace=>({workspace:{...parent,handle_id:"child",real_root:"/tmp/isolated-child"},permissionPolicy:narrow,binding,release(){}});
describe("trusted child workspace authority",()=>{
 it("accepts a disjoint narrowed workspace and keeps release exactly bound to its Host lease",()=>{let released=0;const supplied={...value(),release(){released++;}};const checked=validateSubagentWorkspace(parent,parentPolicy,supplied);expect(checked.permissionPolicy.preset.sandbox_mode).toBe("workspace-write");checked.release();expect(released).toBe(1);});
 it.each(["same","nested","ancestor","relative","full-access","foreign-project","weaker-approval","new-tool","new-rule","new-capability"] as const)("rejects forged %s authority",kind=>{const supplied=value();const modified=kind==="full-access"?{...supplied,permissionPolicy:parentPolicy}:kind==="weaker-approval"?{...supplied,permissionPolicy:narrow}:kind==="new-tool"?{...supplied,permissionPolicy:createEffectivePermissionPolicy({preset:{...narrow.preset,allowed_tools:[...narrow.preset.allowed_tools,"untrusted_tool"]}})}:kind==="new-rule"?{...supplied,permissionPolicy:createEffectivePermissionPolicy({preset:narrow.preset,rules:[{rule_id:"invented",priority:1,when:{},then:"allow",explanation:"Widen authority"}]})}: {...supplied,workspace:{...supplied.workspace,real_root:kind==="same"?parent.real_root:kind==="nested"?"/tmp/source/subdir":kind==="ancestor"?"/tmp":kind==="relative"?"relative":supplied.workspace.real_root,...(kind==="foreign-project"?{project_id:"foreign"}:{})}};
  const authority=kind==="weaker-approval"?createEffectivePermissionPolicy({preset:BUILTIN_PERMISSION_PRESETS["workspace-write"]}):parentPolicy;
  const source=kind==="new-capability"?{...parent,capabilities:{...parent.capabilities,test:false}}:parent;
  expect(()=>validateSubagentWorkspace(source,authority,modified)).toThrow(/exceeds or escapes/u);
 });
});
