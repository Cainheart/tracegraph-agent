import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./node-executable.js", async original=>({ ...await original<typeof import("./node-executable.js")>(), verifyStandaloneNodeExecutable:vi.fn(async (path:string)=>path) }));
import { verifyStandaloneNodeExecutable } from "./node-executable.js";
import { resolveBundledRuntime } from "./bundled-runtime.js";
let root:string|undefined;
afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root=undefined;vi.clearAllMocks();});
async function fixture(patch:Record<string,unknown>={}){
  root=await mkdtemp(join(tmpdir(),"outlive-runtime-manifest-"));const executable=process.platform==="win32"?"node.exe":"bin/node";
  await mkdir(join(root,"bin"));await writeFile(join(root,executable),"isolated executable fixture");
  await writeFile(join(root,"runtime-manifest.json"),JSON.stringify({schema_version:"outlive.bundled-runtime.v1",node_version:"24.21.0",platform:process.platform,arch:process.arch,executable,sha256:createHash("sha256").update("isolated executable fixture").digest("hex"),product_build_id:"1".repeat(64),...patch}));
  return root;
}
describe("fixed bundled runtime",()=>{
  it("verifies one packaged binary and its pinned version",async()=>{const directory=await fixture();const result=await resolveBundledRuntime(directory);expect(result.runtimeDirectory).toBe(await realpath(directory));expect(verifyStandaloneNodeExecutable).toHaveBeenCalledWith(result.executable,process.env,"24.21.0");});
  it("rejects corrupt bytes before launching any binary",async()=>{const directory=await fixture({sha256:"0".repeat(64)});await expect(resolveBundledRuntime(directory)).rejects.toThrow("Reinstall");expect(verifyStandaloneNodeExecutable).not.toHaveBeenCalled();});
  it("rejects another platform without PATH fallback",async()=>{const directory=await fixture({platform:process.platform==="win32"?"darwin":"win32"});await expect(resolveBundledRuntime(directory)).rejects.toThrow("external PATH runtimes are not used");expect(verifyStandaloneNodeExecutable).not.toHaveBeenCalled();});
  it("rejects executable symlinks",async()=>{const directory=await fixture();const executable=process.platform==="win32"?"node.exe":"bin/node";await rm(join(directory,executable));await writeFile(join(directory,"outside"),"isolated executable fixture");await symlink(join(directory,"outside"),join(directory,executable));await expect(resolveBundledRuntime(directory)).rejects.toThrow("bundled runtime");expect(verifyStandaloneNodeExecutable).not.toHaveBeenCalled();});
  it("does not retry with external Node after an identity probe fails",async()=>{const directory=await fixture();vi.mocked(verifyStandaloneNodeExecutable).mockRejectedValueOnce(new Error("unsupported or Electron"));await expect(resolveBundledRuntime(directory)).rejects.toThrow("incompatible");expect(verifyStandaloneNodeExecutable).toHaveBeenCalledOnce();});
});
