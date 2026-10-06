import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Independent evidence reader: no Runtime, provider, subprocess or workspace edit.
const base=dirname(fileURLToPath(import.meta.url));
const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
let checks=0;
const must=(condition,label)=>{checks++;if(!condition)throw new Error(label);};
const load=async(path)=>JSON.parse(await readFile(resolve(base,path),'utf8'));
const core=await load('core-proof/report.json'),coreRuns=await load('core-proof/events.json'),artifacts=await load('core-proof/artifacts.json');
const api=await load('api-proof/report.json'),apiRuns=await load('api-proof/events.json');
function chain(runs){
  for(const [id,events] of Object.entries(runs)){
    let previous;
    for(const [index,event] of events.entries()){
      const {event_hash,...body}=event;
      must(event.run_id===id,'exact Run scope');
      must(event.sequence===index+1&&event.previous_event_hash===previous,'canonical sequence and hash chain');
      must(event_hash===sha(canonical(body)),'canonical event hash');previous=event_hash;
    }
    must(events.at(-1).type==='run.completed','actual canonical successful terminal');
    must(events.filter(event=>['run.completed','run.failed','run.cancelled'].includes(event.type)).length===1,'one terminal per Run');
  }
}
chain(coreRuns);chain(apiRuns);
const parent=coreRuns[core.run_id],child=coreRuns[core.child_run_id],end=parent.at(-1),childEnd=child.at(-1);
must(core.status==='passed'&&core.owner_exited_before_resume===true&&Number.isInteger(core.exited_owner_pid)&&core.exited_owner_pid>0,'real owner PID exited before continuation');
const resume=parent.find(event=>event.type==='run.resumed');
must(resume.data.automatic_tool_retry===false&&resume.data.model_binding_unchanged===true,'no old Tool replay or changed model binding');
const original=parent[0].data.workspace_recovery_binding;
must(/^sha256:[a-f0-9]{64}$/.test(original.root_hash)&&original.kind==='managed_local','canonical opaque workspace root identity');
const restored=parent.find(event=>event.data.operation==='delivery.budget_restored');
must(parent.filter(event=>event.data.operation==='delivery.budget_admitted').length===1,'no renewed spending authority');
must(restored.data.budget_id===parent[0].data.delivery_budget&&restored.data.new_budget===false,'same original finite lease');
must(restored.data.budget_snapshot.charged_tokens===1005&&restored.data.budget_snapshot.request_count===1,'original charged request retained');
must(end.data.delivery_budget.charged_tokens===5025&&end.data.delivery_budget.request_count===5&&end.data.delivery_budget.held_tokens===0,'implementation and child reviewer aggregate charges');
must(end.data.delivery_budget.limits.max_tokens===200000&&end.data.delivery_budget.limits.max_time_ms===900000,'original finite limits');
must(end.data.delivery_budget.elapsed_ms>=restored.data.budget_snapshot.elapsed_ms,'elapsed time not reset');
const reservations=parent.filter(event=>event.data.operation==='delivery.budget_reserved'),settlements=parent.filter(event=>event.data.operation==='delivery.budget_settled');
must(reservations.length===5&&settlements.length===5,'every actual provider request reserved and settled');
must(new Set(reservations.map(event=>event.data.budget_checkpoint.run_id)).size===2,'same lease covers parent and reviewer');
const packetBytes=await readFile(resolve(base,'core-proof/requirements.json'));
must(sha(packetBytes)===core.artifact_ref.content_hash&&packetBytes.length===core.artifact_ref.byte_length,'actual complete requirement Artifact bytes');
const packet=JSON.parse(packetBytes);
must(packet.complete===true&&packet.initial_task.length>4000&&packet.initial_task.includes('REQUIRED_AFTER_4000'),'untruncated initial public task');
must(packet.consumed_guidance.length===1&&packet.consumed_guidance[0].body.includes('PUBLIC_REQUIRED_GUIDANCE'),'exact consumed human guidance');
const consumed=parent.find(event=>event.type==='user.input_consumed'),firstPostResume=parent.find(event=>event.sequence>resume.sequence&&event.type==='model.request_started');
must(consumed.sequence<firstPostResume.sequence&&core.first_resumed_request_guidance===true,'queued guidance consumed before resumed model request');
must(packet.consumed_guidance[0].consumed_event_id===consumed.event_id,'public guidance linked to actual canonical event');
const review=parent.find(event=>event.data.operation==='delivery.review_completed'),link=parent.find(event=>event.type==='subagent.completed');
must(review.data.complete_requirements===true&&review.data.requirement_hash===core.artifact_ref.content_hash,'parent accepts exact complete packet');
must(review.data.child_terminal_event_id===childEnd.event_id&&review.data.child_terminal_event_hash===childEnd.event_hash&&link.data.child_terminal_event_hash===childEnd.event_hash,'independent reviewer actual terminal receipt');
must(child[0].data.mode==='plan'&&child[0].data.delivery_reviewer===true,'compiled readonly reviewer');
must(child.find(event=>event.type==='permission.configured').data.permission.sandbox_mode==='read-only','readonly reviewer authority');
must(child.filter(event=>event.type==='tool.started').every(event=>['read_file','read_artifact'].includes(event.data.tool_name)),'no reviewer writes or commands');
const manifests=child.filter(event=>event.type==='context.built');
const lastRef=manifests.at(-1).artifact_refs.find(ref=>ref.kind==='context_manifest'),lastArtifact=artifacts[lastRef.artifact_id];
must(lastArtifact.ref.content_hash===lastRef.content_hash&&sha(lastArtifact.content)===lastRef.content_hash,'actual final reviewer model manifest');
const manifest=JSON.parse(lastArtifact.content),ranges=[];
for(const event of child.filter(event=>event.type==='tool.completed'&&event.data.receipt.tool_name==='read_artifact')){
  const observation=event.data.observation,facts=observation.facts;
  if(facts.artifact_id!==core.artifact_ref.artifact_id)continue;
  must(facts.content_hash===core.artifact_ref.content_hash&&facts.total_bytes===packetBytes.length,'exact scoped packet page hash');
  const item=manifest.items.find(item=>item.source.source_id===observation.receipt_id);
  must(item?.action==='kept'&&item.included_tokens>0&&item.included_tokens===item.original_tokens,'each packet page retained completely with positive model tokens');
  must(JSON.parse(item.content).facts.content_excerpt===facts.content_excerpt,'manifest bytes match actual read receipt');
  ranges.push([facts.offset,facts.offset+facts.bytes_read]);
}
ranges.sort((a,b)=>a[0]-b[0]);let cursor=0;
for(const [start,finish] of ranges){must(start<=cursor,'no skipped requirement bytes');cursor=Math.max(cursor,finish);}
must(cursor===packetBytes.length&&ranges.length>1,'every packet byte really read and retained');
const delivered=await load('core-proof/delivered.json');
must(delivered['src/clamp.mjs']===delivered['dist/clamp.mjs']&&delivered['src/clamp.mjs'].includes('if (min > max)'),'actual built bytes match delivered implementation');
const command=parent.find(event=>event.type==='tool.completed'&&event.data.receipt.tool_name==='run_project_command');
must(command.sequence>parent.find(event=>event.type==='patch.applied').sequence&&command.data.observation.facts.exit_code===0,'fresh actual successful validation after patch');
const outputRef=command.artifact_refs.find(ref=>artifacts[ref.artifact_id]);
must(sha(artifacts[outputRef.artifact_id].content)===outputRef.content_hash,'real external command output Artifact hash');
must(artifacts[outputRef.artifact_id].content.includes('ACTUAL_BUILD_OUTPUT')&&artifacts[outputRef.artifact_id].content.includes('ACTUAL_CLAMP_TESTS_PASS'),'actual external build/test stdout');
must(api.status==='passed'&&Object.values(api.api_statuses).every(status=>status===200),'actual HTTP start/resume/approval/exact retry receipts');
must(api.source_sha256===api.built_sha256&&api.provider_requests===5,'API fixture disk effects and zero new exact-retry dispatch');
const apiParent=apiRuns[api.run_id];
must(apiParent.filter(event=>event.data.operation==='delivery.budget_admitted').length===1&&apiParent.find(event=>event.data.operation==='delivery.budget_restored').data.new_budget===false,'HTTP same-budget continuation');
must(apiParent.at(-1).data.delivery_budget.charged_tokens===75&&apiParent.at(-1).data.delivery_budget.request_count===5,'HTTP exact deterministic charges');
const result={status:'passed',checks,scope:'independent read-only canonical chain/bytes/budget/packet/API evidence',core_run_id:core.run_id,api_run_id:api.run_id,no_new_dispatch:true,no_paid_model_quality_claim:true};
await writeFile(resolve(base,'verification.json'),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result)+'\n');
