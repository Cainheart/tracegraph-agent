import {createHash} from "node:crypto";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it,vi} from "vitest";
const discovery=vi.hoisted(()=>({directory:""}));
vi.mock("./composition/bundled-runtime.js",()=>({discoverCurrentBundledRuntime:async()=>({runtimeDirectory:discovery.directory})}));
import {browserRuntimeForHost} from "./browser-runtime.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"outlive-browser-runtime-"));roots.push(root);discovery.directory=root;await mkdir(join(root,"browser"));return root;}
async function manifest(root:string, overrides:Record<string,unknown>={}){const bytes=Buffer.from("fixture integrity bytes - never launched");await writeFile(join(root,"browser","chromium-fixture"),bytes);await writeFile(join(root,"browser","browser-manifest.json"),JSON.stringify({schema_version:"outlive.browser-runtime.v1",platform:process.platform,arch:process.arch,playwright_version:"1.63.0",executable:"chromium-fixture",sha256:createHash("sha256").update(bytes).digest("hex"),...overrides}));}
describe("installed browser integrity and failure isolation",()=>{
 it("uses only a matched manifest executable and fails closed after tampering",async()=>{const root=await fixture();await manifest(root);expect(await browserRuntimeForHost()).toEqual({runtimeKind:"bundled",executablePath:join(root,"browser","chromium-fixture")});await writeFile(join(root,"browser","chromium-fixture"),"changed binary");expect(await browserRuntimeForHost()).toEqual({runtimeKind:"bundled",executablePath:join(root,"browser","unavailable-browser-runtime")});});
 it("never falls back to the user browser or cache when installed resources are absent or invalid",async()=>{const root=await fixture();expect((await browserRuntimeForHost()).executablePath).toBe(join(root,"browser","unavailable-browser-runtime"));for(const overrides of [{playwright_version:"0.0.1"},{platform:process.platform==="darwin"?"win32":"darwin"},{executable:"../outside"},{executable:"bad\\path"},{arch:"unsupported"}]){await manifest(root,overrides);expect(await browserRuntimeForHost()).toEqual({runtimeKind:"bundled",executablePath:join(root,"browser","unavailable-browser-runtime")});}});
});
