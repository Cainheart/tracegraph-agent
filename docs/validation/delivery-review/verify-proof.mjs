import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// This independent evidence reader never invokes a model, command or Runtime.
const base=resolve(process.argv[2]??resolve(dirname(fileURLToPath(import.meta.url)),'controlled-known-failure-proof'));
const proof=JSON.parse(await readFile(resolve(base,'proof.json'),'utf8'));
const runs=JSON.parse(await readFile(resolve(base,'canonical-events.json'),'utf8'));
const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
let checks=0;const must=(condition,label)=>{checks++;if(!condition)throw Error(label);};
must(proof.scope==='controlled-real-disk-runtime-protocol'&&proof.no_paid_requests===true&&proof.full_software_quality_claim===false,'scope and provider claims');
must(proof.child_run_ids.length===2&&Object.keys(runs).length===3,'actual parent plus two separate reviewers');
for(const [id,events] of Object.entries(runs)){
  let previous;
  events.forEach((event,index)=>{
    const {event_hash,...body}=event;
    must(event.run_id===id&&event.project_id===proof.project_id,'Run/project scope');
    must(event.sequence===index+1&&event.previous_event_hash===previous,'canonical sequence/previous hash');
    must(event_hash===sha(canonical(body)),'canonical event content hash');previous=event_hash;
  });
  must(events.filter(event=>['run.completed','run.failed','run.cancelled'].includes(event.type)).length===1,'one actual terminal');
  must(events.at(-1).type==='run.completed','actual completion');
}
const parent=runs[proof.run_id],terminal=parent.at(-1);
const reviews=parent.filter(event=>event.data.operation==='delivery.review_completed');
must(reviews.length===2&&reviews[0].data.review_result.verdict==='blocked'&&reviews[1].data.review_result.verdict==='passed','concrete defect then re-review');
must(reviews[0].data.review_result.findings.some(item=>item.severity==='blocking'&&item.path==='src/clamp.mjs'),'real reported missing bound guard');
for(const review of reviews){
  const child=runs[review.data.child_run_id],end=child.at(-1);
  const link=parent.find(event=>event.type==='subagent.completed'&&event.data.link.child_run_id===child[0].run_id);
  must(end.data.review_result.verdict===review.data.review_result.verdict,'child verdict matches parent report');
  must(review.data.child_terminal_event_id===end.event_id&&review.data.child_terminal_event_hash===end.event_hash,'review terminal exact id/hash');
  must(link.data.child_terminal_event_id===end.event_id&&link.data.child_terminal_event_hash===end.event_hash,'actual parent child receipt');
  must(child[0].data.mode==='plan'&&child[0].data.delivery_reviewer===true,'trusted reviewer Plan mode');
  must(child.find(event=>event.type==='permission.configured').data.permission.sandbox_mode==='read-only','readonly authority');
  const reads=new Set(child.filter(event=>event.type==='tool.completed'&&event.data.receipt.tool_name==='read_file'&&event.data.receipt.business_status==='success').map(event=>event.data.observation.facts.path));
  must(child.filter(event=>event.type==='tool.started').every(event=>event.data.tool_name==='read_file'),'no reviewer command/write');
  for(const path of review.data.review_result.reviewed_paths)must(reads.has(path),'declared path has canonical actual read');
  for(const path of Object.keys(review.data.source_hashes))must(reads.has(path),'required scope actually read');
}
for(const [path,hash] of Object.entries(proof.files))must(sha(await readFile(resolve(base,'delivered',path)))===hash,'delivered byte hash');
must(proof.files['src/clamp.mjs']===proof.files['dist/clamp.mjs'],'actual build copied final source');
const source=await readFile(resolve(base,'delivered/src/clamp.mjs'),'utf8'),tests=await readFile(resolve(base,'delivered/test/clamp.test.mjs'),'utf8');
must(source.includes('if (min > max)')&&tests.includes('assert.throws(()=>clamp(4,10,0),RangeError)'),'real guard and regression source');
must(reviews[0].data.source_hashes['src/clamp.mjs']!==reviews[1].data.source_hashes['src/clamp.mjs'],'source truly repaired between reviews');
const edge=await readFile(resolve(base,proof.independent_external_edge_regression_before_repair.stderr_path),'utf8');
must(sha(edge)===proof.independent_external_edge_regression_before_repair.stderr_sha256&&edge.includes('Missing expected exception (RangeError)'),'independent pre-repair actual assertion failure');
must(proof.outputs.length===3,'pass/fail/pass external command artifacts');
let statuses=[];
for(const output of proof.outputs){
  const bytes=await readFile(resolve(base,output.path)),event=parent.find(event=>event.event_id===output.event_id),ref=event.artifact_refs.find(item=>item.artifact_id===output.artifact_ref.artifact_id),content=JSON.parse(bytes.toString());
  must(sha(bytes)===output.sha256&&ref.content_hash===output.sha256&&ref.byte_length===bytes.length,'external command artifact bytes/hash');
  must(ref.project_id===proof.project_id&&ref.run_id===proof.run_id,'scoped real command artifact');
  const observation=event.data.observation.facts;
  must(observation.started===true&&observation.timed_out===false&&observation.aborted===false&&observation.output_truncated===false,'settled bounded actual command');
  statuses.push(event.data.receipt.business_status);
  if(event.type==='tool.failed')must(observation.exit_code===1&&content.stderr.includes('Missing expected exception (RangeError)'),'actual regression exit1 stderr');
  else must(observation.exit_code===0&&content.stdout.includes('ACTUAL_BUILD_OUTPUT'),'actual success stdout');
}
must(JSON.stringify(statuses)==='["success","failure","success"]','ordered real pass/fail/pass');
const failed=parent.find(event=>event.type==='tool.failed'&&event.data.receipt.tool_name==='run_project_command');
const checkpoint=parent.find(event=>event.data.operation==='delivery.verification_failure_checkpoint');
const resolved=parent.find(event=>event.data.operation==='delivery.verification_failure_resolved');
must(checkpoint.data.failed_event_id===failed.event_id&&checkpoint.data.automatic_command_retry===false&&checkpoint.data.process_boundary==='posix-quiescent','no automatic failed command retry');
must(resolved.data.failed_event_id===failed.event_id&&resolved.sequence>failed.sequence&&parent.find(event=>event.event_id===resolved.data.verification_event_id).type==='tool.completed','known failure reconciled by actual fresh success');
must(parent.some(event=>event.sequence>failed.sequence&&event.sequence<resolved.sequence&&event.type==='patch.applied'&&event.data.verified===true),'real approved repair between failed and successful verification');
const phases=parent.filter(event=>event.data.operation==='delivery.turn_checkpoint');
must(JSON.stringify(phases.map(event=>event.data.turns_completed))==='[3,6,9]'&&phases.every(event=>event.data.budget_id===parent[0].data.delivery_budget&&event.data.automatic_side_effect_retry===false),'bounded same-lease internal continuation');
const reservations=parent.filter(event=>event.data.operation==='delivery.budget_reserved'),settlements=parent.filter(event=>event.data.operation==='delivery.budget_settled');
must(reservations.length===proof.request_count&&settlements.length===proof.request_count,'every real request reserved and settled');
must(new Set(reservations.map(event=>event.data.budget_checkpoint.run_id)).size===3,'one aggregate lease includes implementing and reviewer Runs');
must(terminal.data.delivery_budget.charged_tokens===proof.request_count*15&&terminal.data.delivery_budget.held_tokens===0&&terminal.data.delivery_budget.request_count===proof.request_count,'terminal accounting exact known fixture usage');
must(terminal.data.delivery_budget.limits.max_tokens===200000&&terminal.data.delivery_budget.limits.max_time_ms===900000,'finite production defaults');
const result={status:'passed',checks,scope:'independent read-only evidence validation',run_id:proof.run_id,request_count:proof.request_count,real_command_receipts:3,actual_child_review_runs:2,no_new_effects:true};
await writeFile(resolve(base,'verification.json'),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result)+'\n');
