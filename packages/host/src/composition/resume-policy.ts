import {BUILTIN_TOOL_NAMES,type EffectivePermissionPolicy,type RunProjection,type WorkspaceHandle} from "@tracegraph/contracts";
import {createEffectivePermissionPolicy,type ExtensionManager} from "@tracegraph/core";
import {RunSessionControllerError} from "@tracegraph/api";

/** Recovered authority is revalidated; current-process Runs keep their original policy. */
export class RecoveredRunPolicyGuard {
  readonly #resumed=new Set<string>();
  constructor(readonly resolvePolicy:(workspace:WorkspaceHandle,projection:RunProjection)=>Promise<EffectivePermissionPolicy>,readonly extensions:Pick<ExtensionManager,"snapshot"|"policyRules">){}
  async assertCurrent(projection:RunProjection,workspace:WorkspaceHandle):Promise<void>{
    if(projection.project_id!==workspace.project_id)throw new RunSessionControllerError(409,"resume_project_mismatch","Recovered Run belongs to another project");
    const candidate=await this.resolvePolicy(workspace,projection);
    const builtin=new Set<string>(BUILTIN_TOOL_NAMES),allowed=new Set(candidate.preset.allowed_tools);
    const tools=this.extensions.snapshot().active_tool_names.filter(name=>!builtin.has(name)&&!allowed.has(name)).sort();
    const current=createEffectivePermissionPolicy({preset:{...candidate.preset,allowed_tools:[...candidate.preset.allowed_tools,...tools]},rules:[...candidate.host_rules,...this.extensions.policyRules()],projectRules:candidate.project_rules});
    if(projection.permission?.policy_digest!==current.policy_digest)throw new RunSessionControllerError(409,"resume_policy_changed","Recovered Run permission policy differs from the current Host or project policy; start a new Run to review current permissions");
  }
  async beforeResume(projection:RunProjection,workspace:WorkspaceHandle):Promise<void>{await this.assertCurrent(projection,workspace);this.#resumed.add(projection.run_id);}
  async beforeApproval(projection:RunProjection,workspace:WorkspaceHandle):Promise<void>{if(this.#resumed.has(projection.run_id)||projection.status==="interrupted")await this.assertCurrent(projection,workspace);}
}
