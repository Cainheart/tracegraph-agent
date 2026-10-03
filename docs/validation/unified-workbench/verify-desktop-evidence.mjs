#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const directory=resolve(process.argv[2]??'docs/validation/unified-workbench/desktop-evidence-final');
const read=async file=>JSON.parse(await readFile(join(directory,file),'utf8'));
const report=await read('report.json');
assert.equal(report.status,'passed');assert.deepEqual(report.errors,[]);assert.equal(report.cleanup.completed,true);assert.deepEqual(report.cleanup.failures,[]);
const projection=await read('completed-projection.json');assert.equal(projection.status,'completed');
const test=projection.timeline.find(event=>event.type==='test.completed');assert.equal(test.data.receipt.business_status,'success');assert.equal(test.data.receipt.code,'tests_passed');
const artifact=await read('test-artifact.json');assert.equal(artifact.status,'available');assert.equal(artifact.artifact.run_id,projection.run_id);assert.match(artifact.content,/2\/2 fixture assertions passed/);assert.equal(artifact.artifact.content_hash,'sha256:'+createHash('sha256').update(artifact.content).digest('hex'));
const streams=await read('public-streams.json');assert.ok(streams.ledger.some(event=>event.type==='tool.completed'));assert.ok(streams.activity.some(event=>event.kind==='tool'));assert.ok(streams.model_surface.some(event=>event.type==='public_plan_snapshot'));assert.ok(streams.model_surface.every(event=>event.type!=='thinking_snapshot'));
const unique=new Set();const states=new Map();
for(const shot of report.screenshots??[]) {
  assert.ok(!unique.has(shot.file));unique.add(shot.file);
  const bytes=await readFile(join(directory,shot.file));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),shot.sha256);
  const pixelWidth=bytes.readUInt32BE(16),pixelHeight=bytes.readUInt32BE(20);assert.ok(pixelWidth===shot.width||pixelWidth===shot.width*2);assert.equal(pixelWidth/shot.width,pixelHeight/shot.height);
  assert.ok(shot.bounds.scrollWidth<=shot.width+1);assert.equal(shot.bounds.theme,shot.theme);
  states.set(shot.state,(states.get(shot.state)??0)+1);
}
if(report.screenshots?.length) {
  assert.equal(report.screenshots.length,134);
  for(const state of ['empty','project-ready','active-run','approval','tool-result','change-review'])assert.equal(states.get(state),6);
  for(let index=1;index<=10;index++)assert.equal(states.get(`settings-${String(index).padStart(2,'0')}`),6);
  for(let index=1;index<=6;index++)assert.equal(states.get(`resources-${String(index).padStart(2,'0')}`),6);
  assert.equal(states.get('settings-search'),2);
}
const cli=await read('cli-receipts.json');assert.ok(cli.some(value=>value.argv[0]==='run'&&value.argv[1]==='events'&&value.exit_code===0));assert.ok(cli.some(value=>value.argv[0]==='terminal'&&value.argv[1]==='attach'&&value.exit_code===0));
assert.ok(cli.some(value=>value.argv[0]==='run'&&value.argv[1]==='cancel'&&value.argv[2].startsWith('queued:')&&value.exit_code===0));
const isolation=await read('native-preview-isolation.json');assert.deepEqual(isolation.surface,{bridge:'undefined',require:'undefined',node:'undefined'});assert.equal(isolation.preferences.sandbox,true);assert.equal(isolation.preferences.nodeIntegration,false);assert.equal(isolation.preferences.contextIsolation,true);
const migration=await read('migration-receipt.json');assert.equal(migration.backup_created,true);assert.ok(!('backup_root' in migration));
const refusal=await read('default-rollback-refusal.json');const hashes=await read('rollback-file-hashes.json');
assert.ok(refusal.timeline.some(event=>event.type==='action.rollback_refused'&&event.action_id===hashes.action_id&&event.event_id===hashes.refusal_event&&event.data.reason==='rollback_policy_disabled'));
const rollback=await read('rollback-projection.json');assert.ok(rollback.timeline.some(event=>event.type==='patch.rolled_back'&&event.action_id===hashes.action_id&&event.event_id===hashes.rollback_event));
assert.equal(hashes.original_sha256,hashes.restored_sha256);assert.notEqual(hashes.original_sha256,hashes.patched_sha256);
assert.deepEqual(hashes.flags,{TRACEGRAPH_ROLLBACK_ENABLED:true,TRACEGRAPH_ROLLBACK_ALLOW_FORCE:true});
assert.ok(cli.some(value=>value.argv[0]==='run'&&value.argv[1]==='cancel'&&!value.argv[2].startsWith('queued:')&&value.exit_code===0&&JSON.parse(value.stdout).status==='cancelled'));
for(const [relative,hash] of Object.entries(report.product.hashes))assert.equal(createHash('sha256').update(await readFile(join(report.product.repository_root,relative))).digest('hex'),hash,`Product artifacts changed during/after acceptance: ${relative}`);
if(report.product.artifact_mode==='installed')assert.ok(report.fixture_template,'Installed acceptance must record its same-tree fixture resources');
if(report.fixture_template)for(const [relative,hash] of Object.entries(report.fixture_template.hashes))assert.equal(createHash('sha256').update(await readFile(join(report.product.repository_root,report.fixture_template.root,relative))).digest('hex'),hash,`Fixture resource changed during/after acceptance: ${relative}`);
const result={status:'passed',verified_at:new Date().toISOString(),assertions:report.assertions.length,screenshots:unique.size,states:Object.fromEntries(states),actual_test_receipt:'success/tests_passed',raw_test_assertions:'2/2',cli_process_commands:cli.length,resource_cleanup:'passed',boundary:report.model_boundary};
await writeFile(join(directory,'independent-verification.json'),JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result)+'\n');
