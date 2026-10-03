import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startLocalHost, connectLocalHost } from "../dist/local-host.js";
import { defaultLocalProfileRoot } from "./local-profile.js";

describe("installed local gateway",()=>{
  it("uses a dynamic port and seals Web assets while retaining private-owner identity",async()=>{
    const root=await mkdtemp(join(tmpdir(),"outlive-packaged-gateway-"));
    const web=join(root,"web");await mkdir(join(web,"assets"),{recursive:true});await writeFile(join(web,"index.html"),"<!doctype html><title>Outlive</title>");await writeFile(join(web,"assets","fixture.js"),"console.log('fixture')");await writeFile(join(web,"not-served.json"),"private inventory");
    const owner=await startLocalHost({profileRoot:join(root,"profile"),credentialBackend:"private-file",webAssetRoot:web});
    const privateClient=await connectLocalHost({profileRoot:join(root,"profile")});
    try {
      expect(Number(new URL(owner.status.http_address).port)).toBeGreaterThan(0);
      expect(privateClient.status.boot_nonce).toBe(owner.status.boot_nonce);
      const page=await fetch(owner.status.http_address);expect(page.status).toBe(200);expect(await page.text()).toContain("Outlive");expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect((await fetch(`${owner.status.http_address}/not-served.json`)).status).toBe(404);
      expect((await fetch(`${owner.status.http_address}/assets/%2e%2e%2fprofile%2fdiscovery.json`)).status).toBe(404);
      const bootstrap=await fetch(`${owner.status.http_address}/api/bootstrap`,{headers:{"sec-fetch-site":"same-origin","sec-fetch-mode":"cors"}});expect(bootstrap.status).toBe(200);
      const token=(await bootstrap.json() as {token:string}).token;
      const configure=await fetch(`${owner.status.http_address}/api/model-config`,{method:"POST",headers:{origin:owner.status.http_address,authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({provider:"custom",protocol:"openai-chat-completions",model:"installed-fixture",base_url:"http://127.0.0.1:9/v1",api_key:"isolated-fixture-key"})});expect(configure.status).toBe(200);
      expect((await privateClient.client.getModelConfig()).model).toBe("installed-fixture");
      expect((await fetch(`${owner.status.http_address}/api/bootstrap`)).status).toBe(403);
      expect((await fetch(`${owner.status.http_address}/api/bootstrap`,{headers:{origin:"https://foreign.invalid","sec-fetch-site":"same-origin","sec-fetch-mode":"cors"}})).status).toBe(403);
      expect((await owner.composition.host.app.inject({method:"GET",url:"/api/bootstrap",headers:{host:"foreign.invalid","sec-fetch-site":"same-origin","sec-fetch-mode":"cors"}})).statusCode).toBe(403);
    }finally{await privateClient.close();await owner.close();await rm(root,{recursive:true,force:true});}
  },20_000);
  it("uses the branded default without inspecting or silently importing legacy data",()=>{
    expect(defaultLocalProfileRoot({})).toBe(join(homedir(),".outlive","profiles","default"));
    expect(defaultLocalProfileRoot({OUTLIVE_PROFILE_ROOT:"/explicit/legacy/profile"})).toBe("/explicit/legacy/profile");
  });
  it("rejects a different installed build without stopping its owner or changing shared state",async()=>{
    const root=await mkdtemp(join(tmpdir(),"outlive-build-compat-"));
    const owner=await startLocalHost({profileRoot:root,credentialBackend:"private-file",productBuildId:"1".repeat(64)});
    try{
      const {ensureLocalHost}=await import("../dist/local-host.js");
      await expect(ensureLocalHost({profileRoot:root,productBuildId:"2".repeat(64)})).rejects.toMatchObject({code:"local_host_upgrade_required"});
      const attached=await connectLocalHost({profileRoot:root});expect(attached.status.boot_nonce).toBe(owner.status.boot_nonce);expect(attached.status.product_build_id).toBe("1".repeat(64));await attached.close();
      const compatible=await ensureLocalHost({profileRoot:root,productBuildId:"1".repeat(64)});expect(compatible.status.pid).toBe(owner.status.pid);await compatible.close();
    }finally{await owner.close();await rm(root,{recursive:true,force:true});}
  });
});
