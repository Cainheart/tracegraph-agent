import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash} from "node:crypto";
import {access,lstat,readFile,realpath,stat} from "node:fs/promises";
import {constants} from "node:fs";
import {isAbsolute,join} from "node:path";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import {ComputerElementSchema,ComputerNativeStatusSchema,ComputerTargetSchema,type ComputerAction,type ComputerNativeStatus,type ComputerTarget} from "@tracegraph/contracts";
import type {NativeComputerBackend} from "./computer-control.js";
import {workbenchError} from "./workbench-journal.js";
import {discoverCurrentBundledRuntime} from "./composition/bundled-runtime.js";

type WatchEvent="user-input"|"locked"|"target-changed"|"monitor-unavailable";
const ResponseSchema=z.discriminatedUnion("ok",[
 z.object({ok:z.literal(true),result:z.unknown()}).strict(),
 z.object({ok:z.literal(false),code:z.string().regex(/^computer_[a-z_]+$/u),message:z.string().max(1000)}).strict(),
]);
const WatchSchema=z.union([z.object({ready:z.literal(true)}).strict(),z.object({event:z.enum(["user-input","locked","target-changed","monitor-unavailable"])}).strict()]);
const MAX_HELPER_BYTES=256*1024*1024,MAX_OUTPUT_BYTES=24*1024*1024;

/** Only the trusted installed helper manifest may provide this executable. */
export interface NativeComputerHelperOptions {executable?:string;sha256?:string;platform?:NodeJS.Platform;timeoutMs?:number;unavailableReason?:string;}
export class NativeComputerHelperBackend implements NativeComputerBackend {
 readonly #options:NativeComputerHelperOptions;readonly #children=new Set<ChildProcessWithoutNullStreams>();#closed=false;
 constructor(options:NativeComputerHelperOptions={}){this.#options=options;}
 #platform(){return this.#options.platform??process.platform;}
 async #executable(){
  if(this.#closed)throw workbenchError("computer_closed","Native computer helper is closed",503);
  const {executable,sha256}=this.#options;
  if(!executable||!isAbsolute(executable)||!sha256||!/^[a-f0-9]{64}$/u.test(sha256))throw workbenchError("computer_helper_missing","Install a build that includes the native computer helper",503);
  const path=await realpath(executable);const metadata=await stat(path);
  if(!metadata.isFile()||metadata.size>MAX_HELPER_BYTES)throw workbenchError("computer_helper_invalid","Native computer helper identity is invalid",503);
  await access(path,constants.X_OK);
  if(createHash("sha256").update(await readFile(path)).digest("hex")!==sha256)throw workbenchError("computer_helper_invalid","Native computer helper checksum does not match the installed build",503);
  return path;
 }
 #environment():NodeJS.ProcessEnv{const environment:NodeJS.ProcessEnv={PATH:"/usr/bin:/bin"};if(this.#platform()==="win32")for(const key of ["SystemRoot","WINDIR","TEMP","TMP"])if(process.env[key])environment[key]=process.env[key];return environment;}
 async #spawn(){const executable=await this.#executable();if(this.#closed)throw workbenchError("computer_closed","Native computer helper is closed",503);const child=spawn(executable,[],{stdio:["pipe","pipe","pipe"],env:this.#environment(),windowsHide:true});child.on("error",()=>undefined);this.#children.add(child);child.once("close",()=>this.#children.delete(child));return child;}
 #terminate(child:ChildProcessWithoutNullStreams){child.stdin.destroy();child.kill();const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");},500);timer.unref();child.once("close",()=>clearTimeout(timer));}
 async #request(operation:string,arguments_:Record<string,unknown>={},signal?:AbortSignal):Promise<unknown>{
  if(signal?.aborted)throw workbenchError("computer_input_aborted","Native input was cancelled",409);
  const child=await this.#spawn();return new Promise((resolve,reject)=>{
   const chunks:Buffer[]=[];let bytes=0,settled=false;
   const finish=(error?:unknown,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve(value);};
   const abort=()=>{this.#terminate(child);finish(workbenchError("computer_input_aborted","Native input was cancelled",409));};
   const timer=setTimeout(()=>{this.#terminate(child);finish(workbenchError("computer_helper_timeout","Native computer helper did not answer in time",503));},Math.min(10_000,Math.max(100,this.#options.timeoutMs??10_000)));timer.unref();
   signal?.addEventListener("abort",abort,{once:true});
   child.stdout.on("data",chunk=>{bytes+=chunk.length;if(bytes>MAX_OUTPUT_BYTES){this.#terminate(child);finish(workbenchError("computer_helper_output_limit","Native helper output exceeded its bound",503));}else chunks.push(Buffer.from(chunk));});
   // Native diagnostics must never become model-visible or disclose window contents.
   child.stderr.on("data",()=>undefined);
   child.once("error",()=>finish(workbenchError("computer_helper_failed","Native computer helper could not start",503)));
   child.once("close",code=>{if(settled)return;try{if(code!==0)throw workbenchError("computer_helper_failed","Native computer helper stopped before recording a response",503);const response=ResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));if(!response.ok)throw workbenchError(response.code,response.message,409);finish(undefined,response.result);}catch(error){finish(error);}});
   child.stdin.end(JSON.stringify({operation,...arguments_})+"\n");
   if(signal?.aborted)abort();
  });
 }
 async status():Promise<ComputerNativeStatus>{
  const platform=this.#platform();if(platform!=="darwin"&&platform!=="win32")return {platform:"unsupported",backend_available:false,accessibility:false,screen_capture:false,input_monitoring:false,locked:false,reason:"Native computer control is unavailable on this platform"};
  try{return ComputerNativeStatusSchema.parse(await this.#request("status"));}catch(error){const code=(error as {code?:string}).code;return {platform,backend_available:false,accessibility:false,screen_capture:false,input_monitoring:false,locked:false,reason:this.#options.unavailableReason??(code==="computer_helper_missing"?"Native computer helper is not installed":code==="computer_helper_invalid"?"Native computer helper does not match the installed build":"Native computer helper could not be reached")};}
 }
 async targets(){return z.array(ComputerTargetSchema).max(128).parse(await this.#request("targets"));}
 async validateTarget(target:ComputerTarget,foreground:boolean){await this.#request("validate",{target:ComputerTargetSchema.parse(target),foreground});}
 async focusTarget(target:ComputerTarget){await this.#request("focus",{target:ComputerTargetSchema.parse(target)});}
 async inspect(target:ComputerTarget){return z.object({elements:z.array(ComputerElementSchema).max(256),truncated:z.boolean()}).strict().parse(await this.#request("inspect",{target}));}
 async capture(target:ComputerTarget){const result=z.object({png_base64:z.string().max(23*1024*1024)}).strict().parse(await this.#request("capture",{target}));const bytes=Buffer.from(result.png_base64,"base64");if(bytes.byteLength>16*1024*1024||bytes.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")throw workbenchError("computer_capture_invalid","Native helper returned invalid window pixels",503);return bytes;}
 async act(target:ComputerTarget,action:ComputerAction,signal:AbortSignal){await this.#request("act",{target,action},signal);}
 async watch(target:ComputerTarget,onEvent:(event:WatchEvent)=>void):Promise<{close():Promise<void>}>{
  const child=await this.#spawn();let closed=false,ready=false,pending="",count=0;
  const closedPromise=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  const close=async()=>{if(closed)return;closed=true;this.#terminate(child);await closedPromise;};
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{void close();reject(workbenchError("computer_monitor_required","Native input observation could not be started",503));},3000);timer.unref();
   const failed=()=>{clearTimeout(timer);if(closed)return;if(ready)onEvent("monitor-unavailable");else reject(workbenchError("computer_monitor_required","Native input observation is unavailable",503));};
   child.once("error",failed);child.once("close",failed);child.stderr.on("data",()=>undefined);
   child.stdout.on("data",chunk=>{count+=chunk.length;pending+=chunk.toString("utf8");if(count>1024*1024||pending.length>8192){failed();void close();return;}let newline:number;while((newline=pending.indexOf("\n"))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);try{const event=WatchSchema.parse(JSON.parse(line));if("ready"in event){if(ready)throw new Error("Duplicate readiness");ready=true;clearTimeout(timer);resolve({close});}else{if(!ready)throw new Error("Event before readiness");onEvent(event.event);}}catch{failed();void close();return;}}});
   // Keep stdin open as the owner lifetime pipe. Its closure terminates the monitor.
   child.stdin.write(JSON.stringify({operation:"watch",target})+"\n");
  });
 }
 async close(){if(this.#closed)return;this.#closed=true;const children=[...this.#children];await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null){resolve();return;}child.once("close",()=>resolve());this.#terminate(child);})));}
}

const HelperManifestSchema=z.object({schema_version:z.literal("outlive.native-computer.v1"),platform:z.enum(["darwin","win32"]),arch:z.enum(["arm64","x64"]),available:z.boolean(),executable:z.enum(["outlive-computer","outlive-computer.exe"]).optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/u).optional(),source_sha256:z.string().regex(/^[a-f0-9]{64}$/u),reason:z.enum(["native-runner-required"]).optional()}).strict();
/** Fixed trusted delivery/source paths only. Project and environment values are never executable paths. */
export async function createNativeComputerBackend():Promise<NativeComputerHelperBackend>{
 if(!["darwin","win32"].includes(process.platform))return new NativeComputerHelperBackend();
 const bundled=await discoverCurrentBundledRuntime();
 const directory=bundled?join(bundled.runtimeDirectory,"computer"):fileURLToPath(new URL(`../native/computer/build/${process.platform}-${process.arch}/`,import.meta.url));
 try{const path=join(directory,"computer-manifest.json"),metadata=await lstat(path);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>4096)throw new Error("manifest");const manifest=HelperManifestSchema.parse(JSON.parse(await readFile(path,"utf8")));if(manifest.platform!==process.platform||manifest.arch!==process.arch)throw new Error("platform");if(!manifest.available)return new NativeComputerHelperBackend({unavailableReason:"This build has not included a helper compiled on the matching native operating system"});if(!manifest.sha256||manifest.executable!==(process.platform==="win32"?"outlive-computer.exe":"outlive-computer"))throw new Error("manifest");const executable=join(directory,manifest.executable),info=await lstat(executable);if(!info.isFile()||info.isSymbolicLink())throw new Error("executable");return new NativeComputerHelperBackend({executable,sha256:manifest.sha256});}
 catch(error){return new NativeComputerHelperBackend({unavailableReason:(error as NodeJS.ErrnoException).code==="ENOENT"?"Native computer helper is not installed":"Native computer helper installation is damaged or incompatible"});}
}
