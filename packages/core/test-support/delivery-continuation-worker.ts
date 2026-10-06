/** Test-only real owner. It is killed after canonical approval, never shipped. */
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {BUILTIN_PERMISSION_PRESETS} from "@tracegraph/contracts";
import {createAgentRuntime} from "../src/domains/runtime/runtime.js";
import {ConfigurableModelAdapter} from "../src/domains/model/model-provider.js";
import {createManagedWorkspaceHandle} from "../src/kernel/workspace.js";
import {createEffectivePermissionPolicy} from "../src/domains/tools/policy-engine.js";
import {JsonlSessionStore} from "../src/domains/session/session-store.js";
const input=JSON.parse(await readFile(process.argv[2]!,"utf8")) as {root:string;project:string;indexFalse?:boolean;multiPatch?:boolean;guidance?:boolean;config:Parameters<ConfigurableModelAdapter["configure"]>[0]};
process.on("message",()=>undefined);
const model=new ConfigurableModelAdapter({resolveCredential:async()=>"controlled-review-key-not-live"});model.configure(input.config);
const workspace=await createManagedWorkspaceHandle({projectId:"project:delivery",root:input.project});
if(input.indexFalse)workspace.capabilities.index=false;
const runtime=await createAgentRuntime({dataDir:join(input.root,"data"),sessionStore:new JsonlSessionStore(join(input.root,"sessions")),model,deliveryReview:{maxRounds:2,ordinaryBudget:{max_tokens:200000,max_time_ms:900000}},permissionPolicy:createEffectivePermissionPolicy({preset:BUILTIN_PERMISSION_PRESETS["full-write"],rules:[{rule_id:"human:patch",priority:100,when:{tool:"commit_patch"},then:"ask",explanation:"Explicit human patch approval required"}]})});
const started=await runtime.startRun({command_id:"command:delivery",project_id:workspace.project_id,workspace,mode:"execute",task:"a".repeat(4200)+" REQUIRED_AFTER_4000: clamp reversed bounds must throw RangeError."});
const deadline=Date.now()+8000;
let approved=0;
while(Date.now()<deadline){const value=await runtime.getProjection(started.run_id);if(value.status==="awaiting_approval"){if(input.multiPatch&&approved<2){const pending=value.pending_approval!;await runtime.approve({type:"approve",command_id:`fixture:initial-human-approval:${++approved}`,project_id:value.project_id,run_id:value.run_id,approval_id:pending.approval_id,action_id:pending.action_id});continue;}if(input.guidance)await runtime.submitUserInput({type:"submit_user_input",command_id:"human:public-guidance",input_id:"input:public-guidance",project_id:value.project_id,run_id:value.run_id,kind:"message",body:"PUBLIC_REQUIRED_GUIDANCE: Keep reversed-bound RangeError behavior and report only actual verification",actor:"user"});process.send?.({pending:await runtime.getProjection(value.run_id),pid:process.pid});break;}if(["completed","failed","cancelled"].includes(value.status))throw new Error(`Unexpected controlled owner status: ${value.status}`);await new Promise(resolve=>setTimeout(resolve,10));}
// Parent deliberately SIGKILLs this actual PID. The IPC channel holds the owner.
