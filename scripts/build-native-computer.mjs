#!/usr/bin/env node
// Delivery assembly only. Native behavior belongs to packages/host/native/computer.
import {createHash} from "node:crypto";
import {mkdir,readFile,writeFile,copyFile,chmod,rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const command=(file,args,cwd)=>new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd,stdio:"inherit",env:{...process.env,NODE_OPTIONS:""},windowsHide:true});child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error(`Native computer build command exited ${code}`)));});
export function validateNativeComputerBinary(bytes,platform,arch){
 if(platform==="darwin"){if(bytes.length<8||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==(arch==="arm64"?0x100000c:0x1000007))throw new Error("Native computer helper Mach-O architecture mismatch");}
 else{if(bytes.length<64||bytes.toString("ascii",0,2)!=="MZ")throw new Error("Native computer helper is not a PE binary");const offset=bytes.readUInt32LE(0x3c);if(offset+6>bytes.length||bytes.toString("ascii",offset,offset+4)!=="PE\0\0"||bytes.readUInt16LE(offset+4)!==(arch==="arm64"?0xaa64:0x8664))throw new Error("Native computer helper PE architecture mismatch");}
}
/** Non-native builds are explicitly unavailable; no borrowed platform binary is staged. */
export async function buildNativeComputer(root,output,platform=process.platform,arch=process.arch){
 if(!["darwin","win32"].includes(platform)||!["arm64","x64"].includes(arch))throw new Error("Unsupported native computer helper target");
 root=resolve(root);output=resolve(output);await mkdir(output,{recursive:true});
 const source=join(root,"packages","host","native","computer"),inputs=platform==="darwin"?["mac-helper.swift"]:["Program.cs","OutliveComputer.csproj"];
 const source_sha256=sha(Buffer.concat(await Promise.all(inputs.map(async path=>Buffer.concat([Buffer.from(path+"\0"),await readFile(join(source,path))])))));
 const executable=platform==="darwin"?"outlive-computer":"outlive-computer.exe",destination=join(output,executable);
 let manifest={schema_version:"outlive.native-computer.v1",platform,arch,available:false,source_sha256,reason:"native-runner-required"};
 if(process.platform===platform){
  if(platform==="darwin"){await command("xcrun",["swiftc","-swift-version","5","-O","-target",`${arch==="arm64"?"arm64":"x86_64"}-apple-macosx14.0`,"-framework","AppKit","-framework","ApplicationServices","-framework","ScreenCaptureKit",join(source,"mac-helper.swift"),"-o",destination],root);await command("/usr/bin/codesign",["--force","--sign","-","--identifier","com.outlive.agent.computer",destination],root);await chmod(destination,0o755);}
  else{const publish=join(output,"publish");await command("dotnet",["publish",join(source,"OutliveComputer.csproj"),"-c","Release","-r",`win-${arch}`,"--self-contained","true","-p:PublishSingleFile=true","-p:IncludeNativeLibrariesForSelfExtract=true","-o",publish],root);await copyFile(join(publish,executable),destination);await rm(publish,{recursive:true,force:true});}
  const bytes=await readFile(destination);validateNativeComputerBinary(bytes,platform,arch);manifest={schema_version:"outlive.native-computer.v1",platform,arch,available:true,executable,sha256:sha(bytes),source_sha256};
 }else{await rm(destination,{force:true});}
 await writeFile(join(output,"computer-manifest.json"),JSON.stringify(manifest,null,2)+"\n");return manifest;
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
 for(let index=0;index<args.length;index++){if(!["--platform","--arch","--output"].includes(args[index])||args[index+1]===undefined)throw new Error("Usage: node scripts/build-native-computer.mjs [--platform darwin|win32] [--arch arm64|x64] [--output DIRECTORY]");index++;}
 const platform=value("--platform")??process.platform,arch=value("--arch")??process.arch;
 console.log(JSON.stringify(await buildNativeComputer(process.cwd(),value("--output")??join(process.cwd(),"packages/host/native/computer/build",`${platform}-${arch}`),platform,arch),null,2));
}
