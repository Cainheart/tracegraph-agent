import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it,vi} from "vitest";
import {connectLocalHost,ensureLocalHost,stopLocalHost} from "../dist/local-host.js";
import {LocalHostConnectionSupervisor} from "../dist/local-connection-supervisor.js";
import {readLocalOwnerStopIntent} from "../dist/local-owner-intent.js";

describe("real private owner recovery",()=>{
  it("observes external restart and explicit stop; a second client cannot revive a stop",async()=>{
    const root=await mkdtemp(join(tmpdir(),"outlive-rebind-owner-"));const supervisor=new LocalHostConnectionSupervisor({profileRoot:root,credentialBackend:"private-file",httpPort:0,pollIntervalMs:50});let cli:Awaited<ReturnType<typeof connectLocalHost>>|undefined;let second:LocalHostConnectionSupervisor|undefined;
    try {
      await supervisor.initialize();const initial=await supervisor.connection();cli=await connectLocalHost({profileRoot:root});
      const initialSettings=await cli.client.getWorkbenchSettings();await cli.client.updateWorkbenchSettings({command_id:"fixture:shared-settings",expected_revision:initialSettings.revision,patch:{general:{...initialSettings.settings.general,language:"zh-CN"}}});
      expect(await cli.client.workbenchCommand({type:"host.restart",command_id:"fixture:external-restart"})).toMatchObject({code:"restart_requested"});
      await vi.waitFor(()=>expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:2}),{timeout:12_000});
      const replacement=await supervisor.connection();expect(replacement.status.boot_nonce).not.toBe(initial.status.boot_nonce);expect(replacement.status.profile_id).toBe(initial.status.profile_id);
      expect((await supervisor.read(connection=>connection.client.getWorkbenchSettings())).settings.general.language).toBe("zh-CN");
      const capabilities=await supervisor.read(connection=>connection.client.getCapabilities());expect(capabilities.capabilities.find(x=>x.operation==="permission.read")?.state).toBe("available");expect(capabilities.capabilities.find(x=>x.operation==="memory.read")?.state).toBe("available");
      await replacement.stop();await vi.waitFor(()=>expect(supervisor.getSnapshot().state).toBe("stopped"),{timeout:5_000});expect(await readLocalOwnerStopIntent({profileRoot:root})).toBe(true);
      second=new LocalHostConnectionSupervisor({profileRoot:root,credentialBackend:"private-file",pollIntervalMs:50});await second.initialize();expect(second.getSnapshot().state).toBe("stopped");await new Promise(resolve=>setTimeout(resolve,150));await expect(readFile(join(root,"discovery.json"))).rejects.toMatchObject({code:"ENOENT"});
      await supervisor.repair();expect(supervisor.getSnapshot()).toMatchObject({state:"connected",generation:3});expect(await readLocalOwnerStopIntent({profileRoot:root})).toBe(false);
    }finally{await second?.close();await supervisor.close();await cli?.close();await stopAndWait(root);await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
  },30_000);
  it("recovers one owner after an actual crash without executing a recovered Run",async()=>{
    const root=await mkdtemp(join(tmpdir(),"outlive-crash-owner-"));let calls=0;
    const provider=createServer((_req,response)=>{calls++;response.on("error",()=>undefined);});await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));const address=provider.address();if(!address||typeof address==="string")throw new Error("Fixture provider unavailable");
    const options={profileRoot:root,httpPort:0,credentialBackend:"private-file" as const,pollIntervalMs:50};const first=new LocalHostConnectionSupervisor(options),second=new LocalHostConnectionSupervisor(options);
    try {
      await Promise.all([first.initialize(),second.initialize()]);const owner=await first.connection();expect((await second.connection()).status.boot_nonce).toBe(owner.status.boot_nonce);
      await owner.client.configureModel({provider:"custom",protocol:"openai-chat-completions",base_url:`http://127.0.0.1:${address.port}/v1`,model:"isolated-crash-fixture",api_key:"isolated-crash-fixture-key"});
      const run=await owner.client.startChat({command_id:"fixture:held-chat",task:"Hold this isolated provider request"});await vi.waitFor(()=>expect(calls).toBe(1));
      expect(owner.status.pid).not.toBe(process.pid);process.kill(owner.status.pid,"SIGKILL");
      await vi.waitFor(()=>expect(first.getSnapshot()).toMatchObject({state:"connected",generation:2}),{timeout:15_000});await vi.waitFor(()=>expect(second.getSnapshot()).toMatchObject({state:"connected",generation:2}),{timeout:15_000});
      const replacement=await first.connection();expect(replacement.status.pid).not.toBe(owner.status.pid);expect((await second.connection()).status.pid).toBe(replacement.status.pid);
      const projection=await replacement.client.getRun(run.run_id);expect(projection.status).toBe("interrupted");await new Promise(resolve=>setTimeout(resolve,150));expect(calls).toBe(1);expect(await readLocalOwnerStopIntent({profileRoot:root})).toBe(false);
    }finally{await first.close();await second.close();await stopAndWait(root);provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
  },35_000);
});

async function stopAndWait(root:string){await stopLocalHost({profileRoot:root}).catch(()=>undefined);await vi.waitFor(async()=>{await expect(readFile(join(root,"discovery.json"))).rejects.toMatchObject({code:"ENOENT"});},{timeout:5000});}
