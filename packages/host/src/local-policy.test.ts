import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {describe,it,expect} from "vitest";
import {connectLocalHost,startLocalHost} from "./local-host.js";
describe("private Host startup policy",()=>{
 it("advertises disabled rollback and carries only trusted explicit policy overrides into shared composition",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-local-policy-"));
  for(const enabled of [false,true]){const profileRoot=join(root,String(enabled));const owner=await startLocalHost({profileRoot,httpPort:0,credentialBackend:"private-file",environment:{TRACEGRAPH_PERMISSION_PRESET:"read-only",TRACEGRAPH_ROLLBACK_ENABLED:String(enabled),TRACEGRAPH_ROLLBACK_ALLOW_FORCE:"false"}});const connection=await connectLocalHost({profileRoot});try{expect((await connection.client.getPermissionConfig()).ceiling).toBe("read-only");const capability=(await connection.client.getCapabilities()).capabilities.find(x=>x.operation==="rollback.write");expect(capability?.state).toBe(enabled?"available":"policy-denied");if(enabled)expect(capability?.reason).toContain("force policy is disabled");}finally{await connection.close();await owner.close();}}
  await rm(root,{recursive:true,force:true});
 });
});
