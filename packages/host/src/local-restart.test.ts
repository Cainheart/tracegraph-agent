import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startLocalHost, connectLocalHost } from "../dist/local-host.js";

async function eventually<T>(read:()=>Promise<T>,accept:(value:T)=>boolean):Promise<T>{const until=Date.now()+10_000;while(Date.now()<until){try{const value=await read();if(accept(value))return value;}catch{/* restart temporarily removes discovery */}await new Promise(resolve=>setTimeout(resolve,25));}throw new Error("Replacement owner did not become ready");}
async function stop(root:string){try{const connection=await connectLocalHost({profileRoot:root});await connection.stop();await eventually(async()=>{try{await readFile(join(root,"discovery.json"));return false;}catch{return true;}},x=>x);}catch{/* startup failure still closes original owner in finally */}}
describe("explicit idle Host restart",()=>{
  it("does not stop an active Run, blocks admission while idle restart is pending, and applies restart settings",async()=>{
    const root=await mkdtemp(join(tmpdir(),"outlive-restart-"));let release:(()=>void)|undefined,calls=0;
    const provider=createServer(async(request,response)=>{let raw="";for await(const chunk of request)raw+=String(chunk);const payload=JSON.parse(raw) as {messages?:Array<{content?:string}>};if(payload.messages?.[0]?.content?.startsWith("You extract")){response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:"Fixture has no reusable facts",candidates:[]})}}]}));return;}calls++;release=()=>{if(response.writableEnded)return;response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({decision_id:"decision:finish",kind:"finish",public_reason:"Fixture finished",evidence_refs:[],risk:"none",final_answer:"Fixture completed"})}}]}));};});
    await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));const address=provider.address();if(!address||typeof address==="string")throw new Error("Provider missing");
    const owner=await startLocalHost({profileRoot:root,credentialBackend:"private-file"});const connection=await connectLocalHost({profileRoot:root});let rebound:typeof connection|undefined;
    try{
      await connection.client.configureModel({provider:"custom",protocol:"openai-chat-completions",base_url:`http://127.0.0.1:${address.port}/v1`,model:"restart-fixture",api_key:"isolated-restart-key"});
      const run=await connection.client.startChat({command_id:"restart:active",task:"Wait for isolated provider"});await eventually(async()=>calls,x=>x===1);
      await expect(connection.client.workbenchCommand({type:"host.restart",command_id:"restart:busy"})).rejects.toMatchObject({body:{error:"restart_busy"}});expect((await connection.client.getRun(run.run_id)).status).toBe("running");
      release!();await eventually(()=>connection.client.getRun(run.run_id),x=>x.status==="completed");
      await eventually(async()=>owner.composition.workspaceCoordinator.list(),x=>x.length===0);
      const settings=await connection.client.getWorkbenchSettings();await connection.client.updateWorkbenchSettings({command_id:"restart:settings",expected_revision:settings.revision,patch:{tools:{...settings.settings.tools,disabled_extensions:["@tracegraph/builtin-artifact-tools"]}}});
      expect((await connection.client.getWorkbenchSettings()).pending_restart).toContain("tools");
      expect(await connection.client.workbenchCommand({type:"host.restart",command_id:"restart:idle"})).toMatchObject({code:"restart_requested"});
      await expect(connection.client.startChat({command_id:"restart:blocked",task:"Must not run during restart"})).rejects.toMatchObject({body:{error:"host_restarting"}});
      rebound=await eventually(()=>connectLocalHost({profileRoot:root}),x=>x.status.boot_nonce!==owner.status.boot_nonce);
      expect((await rebound.client.getWorkbenchSettings()).pending_restart).toEqual([]);expect((await rebound.client.listExtensions()).find(x=>x.name==="@tracegraph/builtin-artifact-tools")?.state).toBe("inactive");expect(calls).toBe(1);
    }finally{release?.();await connection.close();await rebound?.close();await stop(root);await owner.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
  },30_000);
  it.skipIf(process.platform!=="darwin")("keeps an owned PTY and its workspace lease when restart is busy",async()=>{
    const root=await mkdtemp(join(tmpdir(),"outlive-restart-pty-"));const owner=await startLocalHost({profileRoot:root,credentialBackend:"private-file"});const connection=await connectLocalHost({profileRoot:root});
    try{
      const workspace=join(root,"workspace");await mkdir(workspace);const project=await connection.native.registerProject({selectedPath:workspace,access:"read_write"});
      const created=await connection.client.workbenchCommand({type:"terminal.create",command_id:"restart:terminal",project_id:project.project_id,cols:100,rows:30});expect(created.terminal?.state).toBe("running");
      await expect(connection.client.workbenchCommand({type:"host.restart",command_id:"restart:pty-busy"})).rejects.toMatchObject({body:{error:"restart_busy"}});expect((await connection.client.getWorkbenchResources()).terminals[0]?.state).toBe("running");expect(owner.composition.workspaceCoordinator.list()).toHaveLength(1);
      await connection.client.workbenchCommand({type:"terminal.close",command_id:"restart:terminal-close",terminal_id:created.terminal!.terminal_id});
    }finally{await connection.close();await owner.close();await rm(root,{recursive:true,force:true});}
  },20_000);
});
