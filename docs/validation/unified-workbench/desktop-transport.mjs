#!/usr/bin/env node
/** PAR-088 real Electron Main/preload -> authenticated private shared Host acceptance.
 * All paths, credentials, workspaces and model responses are disposable synthetic fixtures.
 * Requires stable built packages. Does not build or inspect a user's profile/secrets.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {desktopMatrix} from './desktop-matrix.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
// A frozen installed tree is exercised externally; no unlisted QA files are copied into it.
const repository=resolve(process.env.OUTLIVE_REPOSITORY_ROOT ?? resolve(directory,'../../..'));
const {ensureLocalHost,connectLocalHost}=await import(pathToFileURL(join(repository,'packages/host/dist/index.js')).href);
const {TraceGraphClient}=await import(pathToFileURL(join(repository,'packages/sdk/dist/index.js')).href);
const {createFailingTypescriptFixture}=await import(pathToFileURL(join(repository,'packages/test-support/dist/index.js')).href);
const output=resolve(process.argv[2] ?? join(directory,'desktop-evidence'));
const playwright=process.env.OUTLIVE_PLAYWRIGHT_MODULE;
assert.ok(playwright,'Set OUTLIVE_PLAYWRIGHT_MODULE to the installed Playwright index.mjs');
const {_electron}=await import(pathToFileURL(resolve(playwright)).href);
const cleanups=[];
const receipt={task_id:'PAR-088',recorded_at:new Date().toISOString(),status:'running',model_boundary:'Synthetic loopback provider; actual packaged Electron Main/preload, HTTP over private local channel, shared Host/Runtime/ledger, real fixture patch and test processes. No provider-quality or external-user claims.',assertions:[],errors:[]};
await mkdir(output,{recursive:true});
receipt.product={artifact_mode:process.env.OUTLIVE_REPOSITORY_ROOT?'installed':'source',repository_root:repository,hashes:{}};
for(const relative of ['apps/desktop/dist/main.js','apps/desktop/dist/preload.cjs','apps/desktop/dist/renderer/index.html','apps/cli/dist/index.js','apps/cli/dist/workbench-command.js','packages/host/dist/local-host-worker.js','packages/sdk/dist/index.js']) {
  receipt.product.hashes[relative]=createHash('sha256').update(await readFile(join(repository,relative))).digest('hex');
}
const rendererHtml=await readFile(join(repository,'apps/desktop/dist/renderer/index.html'),'utf8');
for(const entry of [...rendererHtml.matchAll(/(?:src|href)="\.\/assets\/([^"\s]+)"/gu)].map(match=>'apps/desktop/dist/renderer/assets/'+match[1]))receipt.product.hashes[entry]=createHash('sha256').update(await readFile(join(repository,entry))).digest('hex');
const scratch=await mkdtemp(join(tmpdir(),'outlive-par088-'));
const profileRoot=join(scratch,'profile');
const save=(file,value)=>writeFile(join(output,file),JSON.stringify(value,null,2)+'\n');
await save('report.json',receipt);
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const matrixEnabled=process.env.OUTLIVE_DESKTOP_MATRIX==='1';
let matrix;
async function eventually(read,label,timeout=30_000){const until=Date.now()+timeout;while(Date.now()<until){const value=await read();if(value)return value;await delay(50);}throw new Error(`Timed out: ${label}`);}
let ordinal=0;
const finish=text=>({decision_id:`decision:par088-${++ordinal}`,kind:'finish',public_reason:'Return the synthetic acceptance result.',public_plan:'Report the verified local result.',evidence_refs:[],risk:'none',final_answer:text});
const tool=(name,args,held=false)=>({held,decision:{decision_id:`decision:par088-${++ordinal}`,kind:'tool_call',public_reason:`Synthetic acceptance: ${name}.`,public_plan:'Inspect the source and run its tests.',evidence_refs:[],risk:name==='preview_patch'?'high':name==='run_test'?'medium':'low',expected_effect:`Establish a real ${name} receipt.`,tool_call:{action_id:`action:par088-${ordinal}`,tool_name:name,arguments:args}}});
async function provider(){
  let script=[],calls=0,release;
  const requests=[];
  const server=createServer(async(request,response)=>{
    try {
      let raw='';for await(const part of request)raw+=part;
      const body=JSON.parse(raw);const decision=String(body.messages?.[0]?.content).includes('decision engine');
      let content;
      if(decision){const step=script[calls++];assert.ok(step,'Synthetic script exhausted');requests.push({ordinal:calls,stream:body.stream===true});if(step.held)await new Promise(done=>{release=done;});content=JSON.stringify(step.decision);}
      else content=JSON.stringify({summary:'Synthetic local acceptance.',candidates:[]});
      if(body.stream){response.writeHead(200,{'content-type':'text/event-stream'});const midpoint=Math.floor(content.length/2);for(const chunk of [content.slice(0,midpoint),content.slice(midpoint)]){response.write(`data: ${JSON.stringify({choices:[{delta:{content:chunk}}]})}\n\n`);await delay(20);}response.end('data: [DONE]\n\n');}
      else {response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({choices:[{message:{content}}]}));}
    }catch(error){if(!response.headersSent)response.writeHead(500);response.end('Synthetic provider script failure');receipt.errors.push({boundary:'synthetic-provider',message:String(error)});}
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  cleanups.push(async()=>{release?.();server.closeAllConnections();await new Promise(done=>server.close(done));});
  return {url:`http://127.0.0.1:${server.address().port}/v1`,set(value){script=value;calls=0;release=undefined;},calls:()=>calls,requests,async release(){const done=await eventually(()=>release,'held synthetic provider request');release=undefined;done();}};
}
let electron,page;
const cliReceipts=[];
async function cli(args,expected=0,stdin='') {
  const env={...process.env,OUTLIVE_PROFILE_ROOT:profileRoot,OUTLIVE_CREDENTIAL_BACKEND:'private-file'};delete env.NODE_OPTIONS;
  const child=spawn(process.execPath,[join(repository,'apps/cli/dist/index.js'),...args,'--profile-root',profileRoot],{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);child.stdin.end(stdin);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),30_000);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timeout));
  cliReceipts.push({argv:args,exit_code:code,stdout,stderr});
  await save('cli-receipts.json',cliReceipts);
  assert.equal(code,expected,`${args.join(' ')}: ${stderr}`);
  if(args[0]==='terminal'&&args[1]==='attach')return stdout;
  if(!stdout.trim())return undefined;
  if(args.includes('--jsonl'))return stdout.trim().split('\n').map(line=>JSON.parse(line));
  return JSON.parse(stdout);
}
async function launch(){
  const safeEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
  electron=await _electron.launch({executablePath:process.env.OUTLIVE_ELECTRON_BINARY ?? join(repository,'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[join(repository,'apps/desktop/dist/main.js'),'--user-data-dir='+join(scratch,'electron')],env:{...safeEnv,OUTLIVE_PROFILE_ROOT:profileRoot,OUTLIVE_CREDENTIAL_BACKEND:'private-file'}});
  page=await electron.firstWindow();
  page.on('pageerror',error=>receipt.errors.push({boundary:'renderer',message:error.message}));
  await eventually(()=>page.evaluate(async()=>window.tracegraphDesktop?.getHostStatus()).then(status=>status?.state==='ready'),'packaged Desktop shared Host readiness');
  return page;
}
async function invoke(method,...args){return page.evaluate(({method,args})=>window.tracegraphDesktop[method](...args),{method,args});}
async function readRun(client,id,status){let last;try{return await eventually(async()=>{last=await client.getRun(id);return last.status===status?last:undefined},'canonical '+status,60_000);}catch(error){if(last)await save('failure-projection.json',last);throw error;}}
const mark=name=>{receipt.assertions.push(name);process.stdout.write(name+'\n');};
async function selectSession(title) {
  await page.reload();await page.getByRole('button',{name:'Workspace tools',exact:true}).first().waitFor();
  await page.locator('.session-card').filter({hasText:title}).first().click();
  await page.locator('.main-workbench').waitFor();
}
let owner,fixture;
const knownOwnerPids=new Set();
const processExited=pid=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}};
try {
  // Public TestSupport resolves these resources from this same source/installed tree.
  // Never substitute a source template when validating a frozen installed archive.
  receipt.fixture_template={root:'examples/failing-typescript-repo',hashes:{}};
  for(const relative of ['package.json','src/add.ts','src/index.ts','test/run.mjs','tsconfig.json','README.md','README.zh.md']) {
    const bytes=await readFile(join(repository,receipt.fixture_template.root,relative));
    receipt.fixture_template.hashes[relative]=createHash('sha256').update(bytes).digest('hex');
  }
  await save('report.json',receipt);
  const model=await provider();
  fixture=await createFailingTypescriptFixture('par088-shared-workspace');cleanups.push(fixture.cleanup);
  const runFile=promisify(execFile);
  await runFile('git',['init'],{cwd:fixture.handle.real_root});
  await runFile('git',['add','.'],{cwd:fixture.handle.real_root});
  await runFile('git',['-c','user.name=Outlive acceptance fixture','-c','user.email=fixture@localhost.invalid','commit','-m','Synthetic fixture baseline'],{cwd:fixture.handle.real_root});
  owner=await ensureLocalHost({profileRoot,httpPort:0,credentialBackend:'private-file',environment:{...process.env,TRACEGRAPH_ROLLBACK_ENABLED:'false',TRACEGRAPH_ROLLBACK_ALLOW_FORCE:'false'}});
  knownOwnerPids.add(owner.status.pid);
  cleanups.push(async()=>{let current;try{current=await connectLocalHost({profileRoot});}catch(error){if(error.code==='ENOENT'&&knownOwnerPids.size&&[...knownOwnerPids].every(processExited))return;throw error;}const pid=current.status.pid;knownOwnerPids.add(pid);await current.stop();await current.close();await eventually(()=>[...knownOwnerPids].every(processExited),'all disposable Host process exits');});
  const registered=await owner.native.registerProject({selectedPath:fixture.handle.real_root,access:'read_write'});
  const source=join(fixture.handle.real_root,'src/add.ts');
  const originalSource=await readFile(source);
  await launch();cleanups.push(async()=>{if(electron){await electron.close();electron=undefined;}});
  await invoke('configureModel',{provider:'openai',protocol:'openai-chat-completions',base_url:model.url,model:'synthetic-par088',api_key:'synthetic-par088-disposable-key'});
  await invoke('configurePermissionPreset',{command_id:'command:par088-permission',preset_key:'workspace-write'});
  assert.equal((await owner.client.getModelConfig()).model,'synthetic-par088');
  assert.equal((await invoke('getHostStatus')).identity.package_name,'@tracegraph/host');
  mark('Desktop Main and private typed client share model configuration and one Runtime owner');
  const gateway=new TraceGraphClient({baseUrl:owner.status.http_address,nodeOrigin:'http://127.0.0.1:4310'});await gateway.bootstrap();
  const before=await invoke('getWorkbenchSettings');
  const updated=await invoke('updateWorkbenchSettings',{command_id:'command:par088-settings',expected_revision:before.revision,patch:{general:{...before.settings.general,language:'en'},appearance:{...before.settings.appearance,theme:'light'}}});
  assert.equal((await gateway.getWorkbenchSettings()).revision,updated.revision);
  await assert.rejects(()=>invoke('updateWorkbenchSettings',{command_id:'command:par088-stale-settings',expected_revision:before.revision,patch:{appearance:{...before.settings.appearance,theme:'dark'}}}),/revision|conflict|changed/i);
  mark('Desktop and loopback Web gateway observe the same settings revision; stale CAS rejected');
  const capabilities=await invoke('getCapabilities');assert.equal(capabilities.profile_id,owner.status.profile_id);
  await invoke('getPermissionConfig');await invoke('getTelemetryStatus');await invoke('getUsage');await invoke('listExtensions');await invoke('listSkills');await invoke('getMcpStatus');await invoke('getLspStatus');
  mark('Fixed settings/status/skills/extensions/MCP/LSP/usage/telemetry routes reach the shared Host');
  const cliStatus=await cli(['host','status']);assert.equal(cliStatus.boot_nonce,owner.status.boot_nonce);assert.equal(cliStatus.pid,owner.status.pid);
  assert.equal((await cli(['model','get'])).model,'synthetic-par088');
  assert.equal((await cli(['config','get'])).revision,updated.revision);
  assert.equal((await cli(['model','test','--command-id','command:par088-cli-model-test'])).status,'passed');
  await cli(['model','configure','--api-key','synthetic-par088-rejected-argv-key'],2);
  assert.ok(!cliReceipts.at(-1).stderr.includes('synthetic-par088-rejected-argv-key'));
  await page.reload();await page.locator('.sidebar-account-trigger').waitFor();
  if(matrixEnabled) {
    matrix=desktopMatrix({page:()=>page,electron:()=>electron,output,receipt,delay});
    await matrix.core('empty');
    await page.locator('.workspace-option').filter({hasText:registered.label}).first().click();
    await matrix.core('project-ready');
    await page.keyboard.press('Control+b');await page.getByRole('button',{name:'Show navigation',exact:true}).waitFor();
    await page.keyboard.press('Control+b');await page.getByRole('button',{name:'Hide navigation',exact:true}).waitFor();
    await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Command palette',exact:true}).waitFor();await page.keyboard.press('Escape');
    await page.keyboard.press('Control+,');await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();await page.getByRole('button',{name:'Back to workbench',exact:true}).click();
    const composer=page.getByRole('textbox',{name:'Task',exact:true});await composer.fill('IME draft');
    await composer.dispatchEvent('keydown',{key:'Enter',isComposing:true});await delay(150);assert.equal(model.calls(),0);assert.equal((await invoke('getWorkbenchResources')).runs.length,0);
    await composer.press('Shift+Enter');assert.ok((await composer.inputValue()).includes('\n'));await composer.fill('');
    mark('Actual Desktop keyboard navigation/palette/settings controls and DOM composition Enter/newline semantics are verified');
  }
  mark('Actual packaged CLI shares owner/settings/model and rejects command-line credentials without printing values');

  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
  const attachment=await page.evaluate(async bytes=>window.tracegraphDesktop.uploadAttachment({metadata:{command_id:'command:par088-attachment',target:'project',project_id:(await window.tracegraphDesktop.listProjects())[0].project_id,declared_media_type:'image/png',delivery:'offload'},bytes:new Uint8Array(bytes)}),[...png]);
  assert.equal(attachment.status,'accepted');
  model.set([tool('search',{pattern:'return left - right;'},true),tool('read_file',{path:'src/add.ts'}),tool('preview_patch',{path:'src/add.ts',expected:'return left - right;',replacement:'return left + right;'}),tool('run_test',{suite:'fixture'}),{decision:finish('Synthetic PAR-088 fixture repair completed.')}]);
  let active;
  if(matrixEnabled) {
    await page.locator('input[type="file"]').first().setInputFiles({name:'synthetic-fixture.png',mimeType:'image/png',buffer:png});
    await page.getByRole('button',{name:'Execute',exact:true}).click();
    await page.getByRole('textbox',{name:'Task',exact:true}).fill('PAR-088 synthetic fixture repair');
    await page.getByRole('textbox',{name:'Task',exact:true}).press('Enter');
    active=await eventually(async()=>{const resources=await invoke('getWorkbenchResources');const run=resources.runs.find(item=>item.task==='PAR-088 synthetic fixture repair');return run?owner.client.getRun(run.run_id):undefined;},'actual Desktop composer Run admission');
    mark('Desktop composer stages the actual fixture image and Enter starts an executable task through fixed transport');
  } else active=await invoke('startRun',{command_id:'command:par088-start',project_id:registered.project_id,task:'PAR-088 synthetic fixture repair',mode:'execute',attachment_upload_ids:[attachment.upload_id]});
  if(matrixEnabled) {await selectSession('PAR-088 synthetic fixture repair');await matrix.core('active-run');assert.equal(await page.getByRole('button',{name:'Test output',exact:true}).count(),0);}
  const observed={ledger:[],activity:[],model_surface:[]};
  const streamIds=await Promise.all(Object.keys(observed).map(kind=>invoke('openStream',{kind,run_id:active.run_id,after:0,reconnect:false})));
  const reads=streamIds.map((id,index)=>page.evaluate(async({id,kind})=>{const events=[];for(let i=0;i<100;i++){const packet=await window.tracegraphDesktop.readStream(id);if(packet.state==='end')break;if(packet.state==='error')throw new Error(packet.message);events.push(packet.value);}return {kind,events};},{id,kind:Object.keys(observed)[index]}));
  await invoke('submitUserInput',{run_id:active.run_id,input:{command_id:'command:par088-input',input_id:'input:par088',kind:'message',body:'Only edit src/add.ts.'}});
  await model.release();
  const waiting=await readRun(owner.client,active.run_id,'awaiting_approval');
  if(matrixEnabled) {
    await page.getByRole('button',{name:'Allow once',exact:true}).waitFor();await matrix.core('approval');
    const activity=page.locator('.inline-activity-details').first();assert.equal(await activity.getAttribute('open'),null);
    await activity.locator(':scope > summary').click();await activity.locator('.inline-activity-history').waitFor();
    assert.match(await activity.innerText(),/search/i);await page.screenshot({path:join(output,'public-activity-expanded.png'),animations:'disabled'});
    await activity.locator(':scope > summary').click();assert.equal(await activity.getAttribute('open'),null);
    mark('Current public activity stays collapsed until the user opens actual operation history, then closes again');
  }
  assert.match(await readFile(source,'utf8'),/return left - right;/);
  for(const id of streamIds)await invoke('closeStream',id);
  for(const {kind,events} of await Promise.all(reads))observed[kind]=events;
  assert.ok(observed.ledger.some(event=>event.type==='tool.completed'));
  assert.ok(observed.activity.some(event=>event.kind==='tool'));
  assert.ok(observed.model_surface.some(event=>event.type==='public_plan_snapshot'));
  assert.ok(observed.model_surface.every(event=>event.type!=='thinking_snapshot'));
  await save('public-streams.json',observed);
  assert.equal((await owner.client.getRun(active.run_id)).status,'awaiting_approval');
  await invoke('writeTodo',{run_id:active.run_id,input:{command_id:'command:par088-todo',input:{operation:'create',todo_id:'todo:par088',title:'Inspect actual test receipt',state:'pending'}}});

  mark('Three actual SSE feeds preserve independent cursors; public model/operation events forwarded, unsubscribe does not cancel Run');
  assert.ok((await invoke('getTodos',active.run_id)).items.some(todo=>todo.todo_id==='todo:par088'));
  await cli(['todo','create',active.run_id,'--todo-id','todo:par088-cli','--title','Read actual artifact','--command-id','command:par088-cli-todo']);
  assert.ok((await invoke('getTodos',active.run_id)).items.some(todo=>todo.todo_id==='todo:par088-cli'));
  const pending=waiting.pending_approval;assert.ok(pending);
  const approved=await invoke('approve',{type:'approve',command_id:'command:par088-approve',project_id:waiting.project_id,run_id:waiting.run_id,approval_id:pending.approval_id,action_id:pending.action_id});
  await invoke('approve',{type:'approve',command_id:'command:par088-approve',project_id:waiting.project_id,run_id:waiting.run_id,approval_id:pending.approval_id,action_id:pending.action_id});
  const completed=await readRun(owner.client,active.run_id,'completed');
  assert.match(await readFile(source,'utf8'),/return left \+ right;/);
  const test=completed.timeline.find(event=>event.type==='test.completed');assert.equal(test.data.receipt.business_status,'success');assert.equal(test.data.receipt.code,'tests_passed');
  const logRef=test.artifact_refs.find(ref=>ref.kind==='test_log');assert.ok(logRef);
  const artifact=await invoke('getArtifact',{run_id:completed.run_id,artifact_id:logRef.artifact_id});assert.match(JSON.stringify(artifact),/2\/2 fixture assertions passed/);
  const projection=await invoke('getRun',completed.run_id);assert.equal(projection.last_sequence,completed.last_sequence);
  await save('completed-projection.json',completed);await save('test-artifact.json',artifact);
  mark('Exact approval command retry does not double-write; actual patch file, success receipt and 2/2 test-log Artifact agree');
  assert.match(JSON.stringify(await cli(['artifact','get',completed.run_id,logRef.artifact_id])),/2\/2 fixture assertions passed/);
  const cliEvents=await cli(['run','events',completed.run_id,'--jsonl']);assert.ok(cliEvents.some(event=>event.type==='test.completed'));
  await cli(['usage','--project-id',registered.project_id,'--session-id',completed.session_id]);
  if(matrixEnabled) {
    await page.getByRole('button',{name:'Review changes',exact:true}).first().waitFor();
    await matrix.core('tool-result');
    await page.getByRole('button',{name:'Test output',exact:true}).click();
    const outputText=await page.locator('.bottom-drawer pre').innerText();assert.equal(outputText.trim(),artifact.content.trim());
    await writeFile(join(output,'desktop-test-output.txt'),outputText);await page.screenshot({path:join(output,'desktop-test-output.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Close log',exact:true}).last().click();
    mark('Test output is absent before an actual test and opens the same real Artifact content through the visible Desktop control');
    await matrix.core('change-review',async()=>{const panel=page.getByRole('complementary',{name:'Review changes',exact:true});if(await panel.count()===0)await page.getByRole('button',{name:'Review changes',exact:true}).first().click();await panel.waitFor();});
    await page.getByRole('button',{name:'Close review',exact:true}).click();
  }
  const attachmentId=completed.attachments.items[0].attachment.attachment_id;
  const binary=await page.evaluate(async({runId,attachmentId})=>{const result=await window.tracegraphDesktop.getAttachmentContent(runId,attachmentId);return {...result,bytes:[...result.bytes]};},{runId:completed.run_id,attachmentId});
  assert.deepEqual(binary.bytes,[...png]);assert.equal(binary.sha256,'sha256:'+createHash('sha256').update(png).digest('hex'));
  const cliAttachment=join(scratch,'cli-attachment.png');await cli(['attachments','content',completed.run_id,attachmentId,'--output',cliAttachment]);assert.deepEqual(await readFile(cliAttachment),png);
  mark('Attachment upload and relation-scoped read preserve exact bytes/media/hash across preload/private transport');
  const replay=await invoke('createReplay',{session_id:completed.session_id,run_id:completed.run_id,until_sequence:completed.last_sequence});assert.equal(replay.replay_token,'desktop-scoped-replay');
  assert.equal((await invoke('getHostStatus')).state,'ready');
  await assert.rejects(()=>invoke('configurePermissionPreset',{command_id:'command:par088-replay-write',preset_key:'workspace-write'}),/replay|read.only|forbidden/i);
  await invoke('getReplayDiff',{from:1,to:completed.last_sequence});await invoke('exitReplay');
  mark('Replay authority is opaque in renderer and read-only writes are rejected until explicit exit');

  const applied=completed.timeline.find(event=>event.type==='patch.applied');assert.ok(applied?.action_id);
  const patchedHash=createHash('sha256').update(await readFile(source)).digest('hex');
  assert.equal((await invoke('getCapabilities')).capabilities.find(item=>item.operation==='rollback.write').state,'policy-denied');
  if(matrixEnabled) {
    await page.getByRole('button',{name:'Review changes',exact:true}).first().click();
    await page.getByText('Applied actions and rollback',{exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Review rollback',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Close review',exact:true}).click();
  }
  const refused=await invoke('rollbackAction',completed.run_id,applied.action_id,{command_id:'command:par088-default-rollback',force:true});
  const refusal=refused.timeline.find(event=>event.type==='action.rollback_refused'&&event.action_id===applied.action_id);
  assert.equal(refusal?.data.reason,'rollback_policy_disabled');
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),patchedHash);
  await save('default-rollback-refusal.json',refused);
  mark('Default rollback policy disables the UI action and records actual same-Action refusal without changing the file hash');
  const previousPid=owner.status.pid;await owner.stop();await owner.close();
  await eventually(()=>{try{process.kill(previousPid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'default-policy Host process exit');
  owner=await ensureLocalHost({profileRoot,httpPort:0,credentialBackend:'private-file',environment:{...process.env,TRACEGRAPH_ROLLBACK_ENABLED:'true',TRACEGRAPH_ROLLBACK_ALLOW_FORCE:'true'}});
  knownOwnerPids.add(owner.status.pid);
  await invoke('startHost');
  assert.equal((await invoke('getCapabilities')).capabilities.find(item=>item.operation==='rollback.write').state,'available');
  if(matrixEnabled) {
    await selectSession('PAR-088 synthetic fixture repair');
    await page.getByRole('button',{name:'Review changes',exact:true}).first().click();
    await page.getByText('Applied actions and rollback',{exact:true}).click();
    await page.getByRole('button',{name:'Review rollback',exact:true}).click();
    const confirmation=page.getByRole('alertdialog',{name:'Confirm Action rollback',exact:true});await confirmation.waitFor();
    const text=await confirmation.innerText();assert.ok(text.includes(completed.project_id)&&text.includes(completed.run_id)&&text.includes(applied.action_id)&&text.includes('src/add.ts'));
    assert.equal(await confirmation.getByRole('button',{name:'Confirm rollback',exact:true}).isDisabled(),true);
    await confirmation.getByRole('checkbox',{name:'Explicitly request force for this persistent workspace; Host policy must allow it',exact:true}).check();
    await page.screenshot({path:join(output,'rollback-confirmation.png'),animations:'disabled'});
    await confirmation.getByRole('button',{name:'Confirm rollback',exact:true}).click();
    await page.getByText('Rollback recorded',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Close review',exact:true}).click();
  } else await invoke('rollbackAction',completed.run_id,applied.action_id,{command_id:'command:par088-enabled-rollback',force:true});
  const rolledBack=await owner.client.getRun(completed.run_id);
  const restored=rolledBack.timeline.find(event=>event.type==='patch.rolled_back'&&event.action_id===applied.action_id&&event.sequence>refusal.sequence);assert.ok(restored);
  const restoredSource=await readFile(source);assert.deepEqual(restoredSource,originalSource);
  await save('rollback-projection.json',rolledBack);await save('rollback-file-hashes.json',{path:'src/add.ts',action_id:applied.action_id,original_sha256:createHash('sha256').update(originalSource).digest('hex'),patched_sha256:patchedHash,restored_sha256:createHash('sha256').update(restoredSource).digest('hex'),refusal_event:refusal.event_id,rollback_event:restored.event_id,flags:{TRACEGRAPH_ROLLBACK_ENABLED:true,TRACEGRAPH_ROLLBACK_ALLOW_FORCE:true}});
  mark(matrixEnabled?'Explicit isolated Host policy restart enables real UI force confirmation; durable same-Action rollback and external file hash restore agree':'Explicit isolated Host policy restart enables fixed rollback transport; durable same-Action rollback and external file hash restore agree');

  model.set([tool('search',{pattern:'return left'},true),{decision:finish('Synthetic detached task completed.')}]);
  const background=await invoke('startRun',{command_id:'command:par088-background',project_id:registered.project_id,session_id:completed.session_id,task:'PAR-088 background continuation',mode:'execute'});
  await eventually(()=>model.calls()===1,'background provider request');
  const queuedStart=cli(['run','start','--project-id',registered.project_id,'--task','PAR-088 queued task','--mode','execute','--command-id','command:par088-queued'],1);
  // Admission is a waiting HTTP command, not a fabricated Core Run projection.
  await eventually(async()=>(await invoke('getWorkbenchResources')).runs.some(run=>run.run_id==='queued:command:par088-queued'),'queued workspace admission');
  await cli(['run','cancel','queued:command:par088-queued','--command-id','command:par088-queue-cancel']);await queuedStart;
  assert.ok(!(await invoke('getWorkbenchResources')).runs.some(run=>run.run_id==='queued:command:par088-queued'));
  assert.equal(model.calls(),1);
  mark('CLI queued holder cancellation removes only queued work, preserving the active Run and model dispatch');
  await electron.close();electron=undefined;
  const observer=await connectLocalHost({profileRoot});cleanups.push(()=>observer.close());
  assert.equal(observer.status.boot_nonce,owner.status.boot_nonce);assert.equal(observer.status.pid,owner.status.pid);
  assert.ok(['running','indexing'].includes((await observer.client.getRun(background.run_id)).status));
  await launch();assert.equal((await invoke('getRun',background.run_id)).run_id,background.run_id);
  await model.release();await readRun(owner.client,background.run_id,'completed');
  mark('Closing Electron leaves the same owner and Run active; a new Desktop reconnects to that Run and receives completion');
  model.set([tool('search',{pattern:'return left'},true),{decision:finish('Must not dispatch after cancellation.')}]);
  const cancelling=await invoke('startRun',{command_id:'command:par088-cancel-start',project_id:registered.project_id,session_id:completed.session_id,task:'PAR-088 cancellation',mode:'execute'});await eventually(()=>model.calls()===1,'cancellable provider request');
  const cancelReceipt=await cli(['run','cancel',cancelling.run_id,'--command-id','command:par088-cancel']);assert.equal(cancelReceipt.status,'cancelled');await model.release();await readRun(owner.client,cancelling.run_id,'cancelled');assert.equal(model.calls(),1);
  await cli(['run','get',cancelling.run_id],1);
  mark('Explicit CLI cancellation exits zero only for canonical cancelled; task read remains exit 1 and next model dispatch is prevented');
  if(matrixEnabled) {
    await selectSession('PAR-088 synthetic fixture repair');
    await matrix.settingsMatrix();
  }
  // Real resource receipts and native isolation; all backend lifetimes are explicit.
  const terminal=await cli(['terminal','create','--project-id',registered.project_id,'--title','PAR-088 real PTY']);
  await cli(['terminal','input',terminal.terminal.terminal_id,'--text',"printf 'PAR088_REAL_PTY\\n'\n"]);
  await eventually(async()=>{const result=await invoke('getWorkbenchResources');return result.terminals.find(item=>item.terminal_id===terminal.terminal.terminal_id)?.transcript.includes('PAR088_REAL_PTY')},'actual PTY output');
  await cli(['terminal','attach',terminal.terminal.terminal_id],0,String.fromCharCode(29));
  assert.equal((await invoke('getWorkbenchResources')).terminals.find(item=>item.terminal_id===terminal.terminal.terminal_id).state,'running');
  const previewServer=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><title>Isolated fixture preview</title><h1>PAR-088 isolated project preview</h1>');});
  await new Promise(done=>previewServer.listen(0,'127.0.0.1',done));cleanups.push(async()=>{previewServer.closeAllConnections();await new Promise(done=>previewServer.close(done));});
  const preview=await cli(['preview','register','--project-id',registered.project_id,'--port',String(previewServer.address().port)]);
  const schedule=await cli(['schedule','create','--input-json',JSON.stringify({title:'PAR-088 scheduled fixture',task:'Inspect later',project_id:registered.project_id,mode:'plan',timing:{kind:'once',at:'2099-01-01T00:00:00.000Z'},timezone:'Asia/Shanghai',enabled:false})]);
  await invoke('openPreview',preview.preview.preview_id);
  const isolation=await electron.evaluate(async({webContents})=>{
    const contents=webContents.getAllWebContents().find(value=>value.getURL().startsWith('http://127.0.0.1:'));
    if(!contents)throw new Error('Native view missing');
    return {url:contents.getURL(),preferences:contents.getLastWebPreferences(),surface:await contents.executeJavaScript('({bridge:typeof window.tracegraphDesktop,require:typeof require,node:typeof process})')};
  });
  assert.equal(isolation.preferences.nodeIntegration,false);assert.equal(isolation.preferences.contextIsolation,true);assert.equal(isolation.preferences.sandbox,true);assert.deepEqual(isolation.surface,{bridge:'undefined',require:'undefined',node:'undefined'});
  await save('native-preview-isolation.json',{url:isolation.url,preferences:{nodeIntegration:isolation.preferences.nodeIntegration,contextIsolation:isolation.preferences.contextIsolation,sandbox:isolation.preferences.sandbox},surface:isolation.surface});
  const previewPixels=await electron.evaluate(async({webContents})=>{const view=webContents.getAllWebContents().find(value=>value.getURL().startsWith('http://127.0.0.1:'));return (await view.capturePage()).toPNG().toString('base64');});
  await writeFile(join(output,'native-preview.png'),Buffer.from(previewPixels,'base64'));
  await invoke('closePreview');assert.equal((await invoke('getWorkbenchResources')).previews.find(item=>item.preview_id===preview.preview.preview_id).state,'ready');
  if(matrixEnabled)await matrix.resourceMatrix();
  await cli(['terminal','close',terminal.terminal.terminal_id]);await cli(['preview','stop',preview.preview.preview_id]);await cli(['schedule','delete',schedule.schedule.schedule_id]);
  mark('Actual CLI resource commands share PTY/preview/schedule receipts; isolated native preview has no Node/app bridge and closing view preserves service');

  const editor=join(scratch,'fixture-editor');const editorReceipt=join(scratch,'editor-receipt.json');
  await writeFile(editor,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(editorReceipt)},JSON.stringify({argv:process.argv.slice(2),shell:process.env.SYNTHETIC_EDITOR_SECRET??null}));\n`);await chmod(editor,0o700);
  const settingsNow=await invoke('getWorkbenchSettings');await invoke('updateWorkbenchSettings',{command_id:'command:par088-editor',expected_revision:settingsNow.revision,patch:{developer:{...settingsNow.settings.developer,editor}}});
  await electron.evaluate(({dialog},{source})=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},{source});
  await invoke('openProjectFile',registered.project_id);
  const editorObserved=await eventually(async()=>{try{return JSON.parse(await readFile(editorReceipt,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}},'configured editor actual argv');
  assert.deepEqual(editorObserved.argv,[source]);await save('editor-receipt.json',editorObserved);
  mark('Configured external editor executes one confined native-selected file with fixed argv');
  // Migration is last because it intentionally swaps the profile data and reconnects the Main client.
  const legacy=join(scratch,'legacy-source');await mkdir(legacy);await writeFile(join(legacy,'evidence.txt'),'Synthetic legacy evidence only\n');
  await electron.evaluate(({dialog},{legacy})=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[legacy]});},{legacy});
  const inventory=await invoke('previewMigration');assert.equal(inventory.sources.length,1);assert.equal(inventory.sources[0].source_id,'legacy-1');assert.ok(!JSON.stringify(inventory).includes(scratch));
  await assert.rejects(()=>invoke('commitMigration',{source_id:'unknown-source'}),/select|inspect/i);
  const migrated=await invoke('commitMigration',{source_id:'legacy-1'});assert.equal(migrated.backup_created,true);assert.equal(await readFile(join(legacy,'evidence.txt'),'utf8'),'Synthetic legacy evidence only\n');
  const rebound=await connectLocalHost({profileRoot});cleanups.push(()=>rebound.close());assert.notEqual(rebound.status.boot_nonce,owner.status.boot_nonce);assert.equal((await invoke('getCapabilities')).profile_id,rebound.status.profile_id);
  knownOwnerPids.add(rebound.status.pid);
  assert.equal(await readFile(join(rebound.status.data_root,'evidence.txt'),'utf8'),'Synthetic legacy evidence only\n');
  await save('migration-preview.json',inventory);await save('migration-receipt.json',migrated);
  mark('Native-selected migration exposes only metadata/source IDs, preserves source, backs up and rebinds Desktop to the new owner');
  const stoppingPid=rebound.status.pid;await invoke('workbenchCommand',{type:'host.stop',command_id:'command:par088-owner-stop'});
  await eventually(()=>{try{process.kill(stoppingPid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'explicit Host shutdown');
  assert.equal((await invoke('getHostStatus')).state,'offline');await invoke('startHost');assert.equal((await invoke('getHostStatus')).state,'ready');
  const restarted=await connectLocalHost({profileRoot});knownOwnerPids.add(restarted.status.pid);assert.equal(restarted.status.http_address,rebound.status.http_address);await restarted.close();
  mark('Explicit Host stop yields actual offline readiness; native start reconnects the same profile without auto-restarting');
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth}));assert.ok(viewport.scrollWidth<=viewport.width+1);
  await page.screenshot({path:join(output,'desktop-shared-host.png'),animations:'disabled'});
  await save('safe-host-status.json',owner.status);
  await save('model-requests.json',model.requests);
}catch(error){receipt.errors.push({boundary:'acceptance',message:error.message,stack:error.stack});receipt.status='failed';if(page&&!page.isClosed()){await page.screenshot({path:join(output,'failure-ui.png'),animations:'disabled'}).catch(()=>{});await writeFile(join(output,'failure-ui.txt'),await page.locator('body').innerText()).catch(()=>{});await save('failure-layout.json',await page.evaluate(()=>Object.fromEntries(['.workspace','.review-side-panel','.workspace-resource-panel','.unified-settings'].map(selector=>{const node=document.querySelector(selector);if(!node)return[selector,null];const css=getComputedStyle(node),bounds=node.getBoundingClientRect();return[selector,{rect:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},display:css.display,position:css.position,gridColumn:css.gridColumn,gridRow:css.gridRow,gridTemplateColumns:css.gridTemplateColumns,inset:css.inset,visibility:css.visibility}];})))).catch(()=>{});}}
finally {
  const failures=[];
  for(const cleanup of cleanups.reverse())try{await cleanup();}catch(error){failures.push(error.message);}
  try{await rm(scratch,{recursive:true,force:true});}catch(error){failures.push(error.message);}
  receipt.cleanup={completed:failures.length===0,failures};
  receipt.owner_processes=[...knownOwnerPids].map(pid=>({pid,exited:processExited(pid)}));
  receipt.status=receipt.status==='failed'||failures.length?'failed':'passed';
  await save('report.json',receipt);
}
process.stdout.write(JSON.stringify({status:receipt.status,assertions:receipt.assertions.length,errors:receipt.errors,cleanup:receipt.cleanup})+'\n');
if(receipt.status!=='passed')process.exitCode=1;
