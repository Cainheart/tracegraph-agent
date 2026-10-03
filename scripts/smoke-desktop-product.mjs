#!/usr/bin/env node
// Test harness only: launches the actual packaged app in an isolated profile.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

async function poll(read,predicate,timeout=20_000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{last=await read();if(predicate(last))return last;}catch(error){last={error:error.message};}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Timed out waiting for product state: ${JSON.stringify(last)}`);}
async function freePort(){const server=netServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
class Cdp {
  constructor(socket){this.socket=socket;this.next=0;this.pending=new Map();socket.addEventListener("message",event=>{const value=JSON.parse(String(event.data));if(!value.id)return;const request=this.pending.get(value.id);if(!request)return;this.pending.delete(value.id);value.error?request.reject(new Error(value.error.message)):request.resolve(value.result);});socket.addEventListener("close",()=>{for(const request of this.pending.values())request.reject(new Error("Renderer closed"));this.pending.clear();});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});return new Cdp(socket);}
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.next;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP ${method} timed out`));},25_000);this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const value=await this.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}
  call(operation,args=[]){return this.evaluate(`window.tracegraphDesktop[${JSON.stringify(operation)}](...${JSON.stringify(args)})`);}
  close(){this.socket.close();}
}
export async function smokeDesktopProduct(product,output){
  product=resolve(product);output=resolve(output);await mkdir(output,{recursive:true});
  const release=JSON.parse(await readFile(join(product,"product-release.json"),"utf8"));
  assert.equal(release.platform,process.platform,"Actual launch must use the matching OS");assert.equal(release.arch,process.arch,"Actual launch must use the matching CPU");
  const appRoot=process.platform==="darwin"?join(product,"artifacts",process.arch==="arm64"?"mac-arm64":"mac","Outlive Agent.app"):join(product,"artifacts",process.arch==="arm64"?"win-arm64-unpacked":"win-unpacked");
  const resources=process.platform==="darwin"?join(appRoot,"Contents","Resources"):join(appRoot,"resources");
  const executable=process.platform==="darwin"?join(appRoot,"Contents","MacOS","Outlive Agent"):join(appRoot,"Outlive Agent.exe");
  const cli=join(resources,"bin",process.platform==="win32"?"outlive.cmd":"outlive");await stat(executable);await stat(cli);
  const isolated=await mkdtemp(join(tmpdir(),"outlive-installed-smoke-")),profile=join(isolated,"profile"),userData=join(isolated,"electron");
  const systemPath=process.platform==="win32"?`${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`:"/usr/bin:/bin";
  const environment={...process.env,PATH:systemPath,NODE_OPTIONS:"",NODE_PATH:"",ELECTRON_RUN_AS_NODE:"",OUTLIVE_PROFILE_ROOT:profile,OUTLIVE_CREDENTIAL_BACKEND:"private-file"};
  const assertions=[];const children=[];let cdp,held,hold=false;let providerCalls=0;const logs=[];
  const report={schema_version:"outlive.product-smoke.v1",status:"running",platform:process.platform,arch:process.arch,product_build_id:release.product_build_id,provider:"isolated deterministic loopback fixture",external_node_on_child_path:false,external_pnpm_on_child_path:false,assertions,cleanup:{owner_stopped:false,apps_exited:false,isolated_profile_removed:false}};
  const check=(id,evidence)=>assertions.push({id,...evidence,status:"passed"});
  async function cliCall(args){const result=process.platform==="win32"?await promisify(execFile)(process.env.ComSpec??"cmd.exe",["/d","/s","/c",`"${cli}" ${args.map(value=>`"${value}"`).join(" ")}`],{env:environment,timeout:25_000,maxBuffer:1024*1024,windowsHide:true}):await promisify(execFile)(cli,args,{env:{...environment,NODE_OPTIONS:"--require /must-not-be-loaded-by-installed-cli"},timeout:25_000,maxBuffer:1024*1024});return JSON.parse(result.stdout);}
  const provider=createServer(async(request,response)=>{let raw="";for await(const chunk of request)raw+=String(chunk);let payload;try{payload=JSON.parse(raw);}catch{response.writeHead(400);response.end();return;}if(request.headers.authorization!=="Bearer isolated-installed-fixture-key"){response.writeHead(401);response.end();return;}const extracting=String(payload.messages?.[0]?.content??"").startsWith("You extract");const send=()=>{if(response.writableEnded)return;response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(extracting?{summary:"No reusable fixture facts",candidates:[]}:{decision_id:"decision:installed-finish",kind:"finish",public_reason:"Installed fixture completed",evidence_refs:[],risk:"none",final_answer:"Installed runtime fixture response"})}}]}));};if(extracting){send();return;}providerCalls++;if(hold){hold=false;held=send;}else send();});
  await new Promise(resolve=>provider.listen(0,"127.0.0.1",resolve));const providerAddress=provider.address();
  async function launch(){const port=await freePort();const child=spawn(executable,[`--user-data-dir=${userData}`,`--remote-debugging-port=${port}`],{env:environment,stdio:["ignore","pipe","pipe"]});children.push(child);child.stdout.on("data",chunk=>logs.push(String(chunk)));child.stderr.on("data",chunk=>logs.push(String(chunk)));child.once("error",error=>logs.push(error.message));const target=await poll(async()=>{const response=await fetch(`http://127.0.0.1:${port}/json/list`);return (await response.json()).find(item=>item.type==="page"&&item.url.startsWith("file:"));},Boolean,25_000);const client=await Cdp.connect(target.webSocketDebuggerUrl);await poll(()=>client.evaluate("Boolean(window.tracegraphDesktop)"),Boolean);await poll(()=>client.call("getHostStatus"),value=>value.state==="ready");return client;}
  async function terminateApp(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill("SIGTERM");try{await poll(async()=>child.exitCode!==null||child.signalCode!==null,Boolean,5_000);}catch{child.kill("SIGKILL");await poll(async()=>child.exitCode!==null||child.signalCode!==null,Boolean,5_000);}}
  try{
    const graphModule=pathToFileURL(join(resources,"app","node_modules","@tracegraph","codegraph","dist","index.js")).href;
    const graphCode=`const{analyzeCodeGraph}=await import(${JSON.stringify(graphModule)});const result=await analyzeCodeGraph({project_id:"project:installed-native-test",workspace_root:${JSON.stringify(join(resources,"app","examples","failing-typescript-repo"))}});if(result.coverage.indexed_file_count!==3)throw new Error("Installed TypeScript fixture modules missing");process.stdout.write(JSON.stringify({indexed_file_count:result.coverage.indexed_file_count,nodes:result.snapshot.nodes.length}));`;
    const native=await promisify(execFile)(join(resources,"runtime",process.platform==="win32"?"node.exe":"bin/node"),["--input-type=module","--eval",graphCode],{env:environment,timeout:25_000,maxBuffer:1024*1024,windowsHide:true});
    check("bundled-typescript-codegraph",JSON.parse(native.stdout));
    cdp=await launch();const first=await cliCall(["host","status","--json"]);assert.equal(first.product_build_id,release.product_build_id);check("bundled-main-owner",{pid:first.pid,boot_nonce:first.boot_nonce,gateway:first.http_address});
    const screenshot=await cdp.send("Page.captureScreenshot",{format:"png"});await writeFile(join(output,"first-window.png"),Buffer.from(screenshot.data,"base64"));check("actual-packaged-window",{screenshot:"first-window.png"});
    const page=await fetch(first.http_address);assert.equal(page.status,200);assert.match(await page.text(),/Outlive/u);const bootstrap=await fetch(`${first.http_address}/api/bootstrap`,{headers:{"sec-fetch-site":"same-origin","sec-fetch-mode":"cors"}});assert.equal(bootstrap.status,200);check("same-owner-packaged-web",{gateway:first.http_address});
    const config=await cdp.call("configureModel",[{provider:"custom",protocol:"openai-chat-completions",base_url:`http://127.0.0.1:${providerAddress.port}/v1`,model:"installed-fixture",api_key:"isolated-installed-fixture-key"}]);assert.equal(config.has_key,true);assert.equal(config.configured,true);check("model-save",{configured:true});
    const tested=await cdp.call("testModel",[{command_id:"installed:model-test"}]);assert.equal(tested.status,"passed");check("explicit-model-test",{status:tested.status});
    const cliModel=await cliCall(["model","get","--json"]);assert.equal(cliModel.model,"installed-fixture");assert.equal(cliModel.has_key,true);check("bundled-cli-shared-model",{model:cliModel.model,has_key:true});
    const project=await cdp.call("createProject",[{name:"installed-smoke-project",template:"typescript"}]);assert.ok(project.project_id);check("managed-project-create",{project_id:project.project_id});
    const capabilities=await cdp.call("getCapabilities");const terminalCap=capabilities.capabilities.find(item=>item.operation==="terminal.create");
    if(terminalCap?.state==="available"){
      const terminal=await cdp.call("workbenchCommand",[{type:"terminal.create",command_id:"installed:terminal",project_id:project.project_id,cols:100,rows:30}]);await cdp.call("workbenchCommand",[{type:"terminal.input",command_id:"installed:node-child",terminal_id:terminal.terminal.terminal_id,text:"node --version\r"}]);
      const resourcesSnapshot=await poll(()=>cdp.call("getWorkbenchResources"),value=>value.terminals.some(item=>item.transcript.includes("v24.21.0")));assert.ok(resourcesSnapshot.terminals.some(item=>item.transcript.includes("v24.21.0")));await cdp.call("workbenchCommand",[{type:"terminal.close",command_id:"installed:terminal-close",terminal_id:terminal.terminal.terminal_id}]);check("bundled-node-child-pty",{version:"24.21.0",closed:true});
    }else assertions.push({id:"bundled-node-child-pty",status:"not-available",reason:terminalCap?.reason??"Native sandbox unavailable on this platform"});
    hold=true;const run=await cdp.call("startChat",[{command_id:"installed:background-chat",task:"Complete the installed runtime fixture"}]);await poll(async()=>Boolean(held),Boolean);assert.equal((await cdp.call("getRun",[run.run_id])).status,"running");
    await cdp.send("Page.close").catch(()=>undefined);cdp.close();cdp=undefined;await terminateApp(children.at(-1));const afterClose=await cliCall(["host","status","--json"]);assert.equal(afterClose.boot_nonce,first.boot_nonce);check("window-close-keeps-owner",{boot_nonce:afterClose.boot_nonce});
    held();held=undefined;const completed=await poll(()=>cliCall(["run","get",run.run_id,"--json"]),value=>value.status==="completed");assert.equal(completed.status,"completed");check("background-run-completes",{run_id:run.run_id,run_status:completed.status});
    cdp=await launch();const reopened=await cliCall(["host","status","--json"]);assert.equal(reopened.boot_nonce,first.boot_nonce);assert.equal((await cdp.call("getRun",[run.run_id])).status,"completed");check("reopen-reuses-owner",{boot_nonce:reopened.boot_nonce});
    const settings=await cdp.call("getWorkbenchSettings");await cdp.call("updateWorkbenchSettings",[{command_id:"installed:restart-settings",expected_revision:settings.revision,patch:{tools:{...settings.settings.tools,disabled_extensions:["@tracegraph/builtin-artifact-tools"]}}}]);
    await poll(()=>cdp.call("getWorkbenchResources"),value=>value.runs.length===0);await new Promise(resolve=>setTimeout(resolve,300));
    const requested=await cdp.call("workbenchCommand",[{type:"host.restart",command_id:"installed:settings-restart"}]);assert.equal(requested.code,"restart_requested");const restarted=await cliCall(["host","status","--json"]);assert.notEqual(restarted.boot_nonce,first.boot_nonce);assert.deepEqual((await cdp.call("getWorkbenchSettings")).pending_restart,[]);assert.equal((await cdp.call("getRun",[run.run_id])).status,"completed");check("idle-settings-restart-rebind",{boot_nonce:restarted.boot_nonce,pending_restart:[]});
    // macOS deliberately retains Main after its last window closes. Close the
    // actual window before terminating this test-owned client process; process
    // signals are cleanup evidence rather than an application-quit assertion.
    await cdp.send("Page.close").catch(()=>undefined);cdp.close();cdp=undefined;
    report.provider_calls=providerCalls;report.status="passed";
  }catch(error){report.status="failed";report.error=error.message;}
  finally{
    held?.();cdp?.close();for(const child of children)await terminateApp(child);report.cleanup.apps_exited=children.every(child=>child.exitCode!==null||child.signalCode!==null);
    try{await cliCall(["host","stop","--json"]);await poll(async()=>{try{await readFile(join(profile,"discovery.json"));return false;}catch{return true;}},Boolean);report.cleanup.owner_stopped=true;}catch(error){report.cleanup.error=error.message;}
    await new Promise(resolve=>provider.close(resolve));await writeFile(join(output,"app-process.log"),logs.join(""));
    report.cleanup.app_processes=children.map(child=>({pid:child.pid,exit_code:child.exitCode,signal:child.signalCode}));
    if(report.cleanup.owner_stopped&&report.cleanup.apps_exited){await rm(isolated,{recursive:true,force:true});report.cleanup.isolated_profile_removed=true;}
    else report.status="failed";
    await writeFile(join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
  }
  if(report.status!=="passed")throw new Error(`Installed product smoke failed; inspect ${join(output,"report.json")}`);
  return report;
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){const args=process.argv.slice(2),get=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};if(!get("--product")||!get("--output")||args.length!==4)throw new Error("Usage: node scripts/smoke-desktop-product.mjs --product PRODUCT_DIRECTORY --output EVIDENCE_DIRECTORY");process.stdout.write(JSON.stringify(await smokeDesktopProduct(get("--product"),get("--output")),null,2)+"\n");}
