#!/usr/bin/env node
// Delivery assembly only. Host behavior belongs to packages/host.
import { cp, copyFile, mkdir, readFile, readdir, realpath, stat, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {buildBrandIcons} from "./build-brand-icons.mjs";

export const NODE_VERSION = "24.21.0";
const NODE_ARCHIVES = {
  "darwin-arm64": {file:`node-v${NODE_VERSION}-darwin-arm64.tar.gz`,sha256:"bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"},
  "darwin-x64": {file:`node-v${NODE_VERSION}-darwin-x64.tar.gz`,sha256:"1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"},
  "win32-x64": {file:`node-v${NODE_VERSION}-win-x64.zip`,sha256:"158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"},
  "win32-arm64": {file:`node-v${NODE_VERSION}-win-arm64.zip`,sha256:"8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921"},
};
const sha256 = bytes=>createHash("sha256").update(bytes).digest("hex");
const command = async (file,args,cwd)=>{const child=spawn(file,args,{cwd,stdio:"inherit",env:{...process.env,NODE_OPTIONS:"",CSC_IDENTITY_AUTO_DISCOVERY:"false",COPYFILE_DISABLE:"1"}});await new Promise((done,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?done():reject(new Error(`${file} exited ${code}`)));});};
export function runtimeArchive(platform,arch) {const archive=NODE_ARCHIVES[`${platform}-${arch}`];if(!archive)throw new Error(`Unsupported distribution target: ${platform}/${arch}`);return archive;}

async function packagePath(name,from) {
  let cursor=from;
  while(true){const path=join(cursor,"node_modules",name);try{return await realpath(path);}catch(error){if(error.code!=="ENOENT")throw error;}const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
  throw new Error(`Missing installed production dependency: ${name}`);
}
async function productionGraph(root,platform,arch) {
  const graph=new Map();
  async function visit(directory){directory=await realpath(directory);if(graph.has(directory))return graph.get(directory);const manifest=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));const node={directory,manifest,dependencies:new Map()};graph.set(directory,node);
    for(const name of Object.keys({...manifest.dependencies,...manifest.optionalDependencies})){if(name.startsWith("@typescript/typescript-")&&name!==`@typescript/typescript-${platform}-${arch}`)continue;let dependency;try{dependency=await packagePath(name,directory);}catch(error){if(manifest.optionalDependencies?.[name])continue;throw error;}node.dependencies.set(name,await visit(dependency));}return node;
  }
  for(const app of ["desktop","cli"])await visit(join(root,"apps",app));
  return graph;
}
async function copyPackage(node,target,root) {
  await mkdir(target,{recursive:true});const location=relative(root,node.directory).split(sep),workspace=["apps","packages"].includes(location[0])&&!location.includes("node_modules");
  if(workspace){for(const entry of node.manifest.files??["dist"]){if(entry.includes("*")||entry.includes("..")||entry.startsWith("/"))throw new Error(`Unsupported workspace file rule: ${entry}`);await cp(join(node.directory,entry),join(target,entry),{recursive:true,dereference:true,filter:path=>!path.endsWith(".tsbuildinfo")});}for(const entry of ["README.md","LICENSE"]){try{await copyFile(join(node.directory,entry),join(target,entry));}catch(error){if(error.code!=="ENOENT")throw error;}}}
  else await cp(node.directory,target,{recursive:true,dereference:true,filter:path=>basename(path)!=="node_modules"&&basename(path)!==".git"});
  const dependencies=Object.fromEntries([...node.dependencies].map(([name,dependency])=>[name,dependency.manifest.version]));
  await writeFile(join(target,"package.json"),JSON.stringify({...node.manifest,dependencies,optionalDependencies:undefined,devDependencies:undefined,packageManager:undefined,scripts:undefined},null,2)+"\n");
}
async function stageDependencies(root,app,platform,arch) {
  const graph=await productionGraph(root,platform,arch),primary=new Map();
  for(const node of graph.values())if(!primary.has(node.manifest.name))primary.set(node.manifest.name,node);
  async function copyWithConflicts(node,target,ancestors=new Set()){
    await copyPackage(node,target,root);const next=new Set(ancestors).add(node.directory);
    for(const [name,dependency]of node.dependencies){if(primary.get(name)===dependency)continue;if(next.has(dependency.directory))throw new Error(`Conflicting dependency cycle: ${name}`);await copyWithConflicts(dependency,join(target,"node_modules",name),next);}
  }
  for(const [name,node]of primary)await copyWithConflicts(node,join(app,"node_modules",name));
  return {dependencies:Object.fromEntries([...primary].map(([name,node])=>[name,node.manifest.version])),packages:[...graph.values()].map(node=>({name:node.manifest.name,version:node.manifest.version})).sort((a,b)=>a.name.localeCompare(b.name))};
}
export function targetTypeScriptPackage(manifest,lock,platform,arch){
  runtimeArchive(platform,arch);
  const name=`@typescript/typescript-${platform}-${arch}`,version=manifest.optionalDependencies?.[name];
  if(typeof version!=="string"||!/^\d+\.\d+\.\d+$/u.test(version))throw new Error("TypeScript target native dependency must be exactly pinned");
  const integrity=lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
  if(typeof integrity!=="string"||!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity))throw new Error("TypeScript target native dependency lacks a pinned SHA-512 integrity");
  return {name,version,integrity};
}
export async function validateNativeTypeScript(directory,expected,platform,arch){
  const manifest=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
  if(manifest.name!==expected.name||manifest.version!==expected.version||!manifest.os?.includes(platform)||!manifest.cpu?.includes(arch)||Object.keys({...manifest.dependencies,...manifest.optionalDependencies}).length!==0)throw new Error("TypeScript native package identity or target mismatch");
  await stat(join(directory,"lib","lib.d.ts"));
  const executable=join(directory,"lib",platform==="win32"?"tsc.exe":"tsc"),bytes=await readFile(executable);
  if(platform==="win32"){
    if(bytes.length<64||bytes.toString("ascii",0,2)!=="MZ")throw new Error("TypeScript target executable is not a PE binary");const offset=bytes.readUInt32LE(0x3c);
    if(offset+6>bytes.length||bytes.toString("ascii",offset,offset+4)!=="PE\0\0"||bytes.readUInt16LE(offset+4)!==(arch==="arm64"?0xaa64:0x8664))throw new Error("TypeScript target executable architecture mismatch");
  }else{
    if(bytes.length<8||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==(arch==="arm64"?0x100000c:0x1000007))throw new Error("TypeScript target executable architecture mismatch");await chmod(executable,0o755);
  }
}
async function stageTargetTypeScript(root,app,graph,platform,arch){
  const installed=await packagePath("typescript",root),manifest=JSON.parse(await readFile(join(installed,"package.json"),"utf8"));
  const {parse}=createRequire(import.meta.url)("yaml"),lock=parse(await readFile(join(root,"pnpm-lock.yaml"),"utf8"));
  const expected=targetTypeScriptPackage(manifest,lock,platform,arch),destination=join(app,"node_modules",expected.name);
  try{await stat(destination);}catch(error){
    if(error.code!=="ENOENT")throw error;
    const cache=join(root,"_tmp_release","runtime-cache");await mkdir(cache,{recursive:true});
    const archive=join(cache,`typescript-${platform}-${arch}-${expected.version}.tgz`);let bytes;
    try{bytes=await readFile(archive);}catch(readError){if(readError.code!=="ENOENT")throw readError;const response=await fetch(`https://registry.npmjs.org/${expected.name}/-/typescript-${platform}-${arch}-${expected.version}.tgz`);if(!response.ok)throw new Error(`Pinned TypeScript native download failed: ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());}
    if(`sha512-${createHash("sha512").update(bytes).digest("base64")}`!==expected.integrity)throw new Error("TypeScript native archive checksum mismatch");await writeFile(archive,bytes);
    const listing=await promisify(execFile)("tar",["-tzf",archive],{timeout:10_000,maxBuffer:64*1024});
    for(const entry of listing.stdout.trim().split("\n")){if(!entry.startsWith("package/")||entry.split("/").includes("..")||entry.includes("\\"))throw new Error("Pinned TypeScript archive has an unsafe entry");}
    const extracted=join(cache,`typescript-${platform}-${arch}-${expected.version}`);await mkdir(extracted,{recursive:true});await command("tar",["-xzf",archive,"-C",extracted],root);
    await validateNativeTypeScript(join(extracted,"package"),expected,platform,arch);
    await copyPackage({directory:join(extracted,"package"),manifest:JSON.parse(await readFile(join(extracted,"package","package.json"),"utf8")),dependencies:new Map()},destination,root);
    graph.packages.push({name:expected.name,version:expected.version});
  }
  await validateNativeTypeScript(destination,expected,platform,arch);
  graph.dependencies[expected.name]=expected.version;graph.packages.sort((a,b)=>a.name.localeCompare(b.name));
  const stagedManifestPath=join(app,"node_modules","typescript","package.json"),stagedManifest=JSON.parse(await readFile(stagedManifestPath,"utf8"));
  stagedManifest.dependencies={...stagedManifest.dependencies,[expected.name]:expected.version};await writeFile(stagedManifestPath,JSON.stringify(stagedManifest,null,2)+"\n");
}
async function stageRuntime(root,destination,platform,arch,productBuildId) {
  const archive=runtimeArchive(platform,arch),cache=join(root,"_tmp_release","runtime-cache");await mkdir(cache,{recursive:true});const path=join(cache,archive.file);
  let bytes;try{bytes=await readFile(path);}catch(error){if(error.code!=="ENOENT")throw error;const response=await fetch(`https://nodejs.org/download/release/v${NODE_VERSION}/${archive.file}`);if(!response.ok)throw new Error(`Official Node download failed: ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());}
  if(sha256(bytes)!==archive.sha256)throw new Error("Official Node archive checksum mismatch");await writeFile(path,bytes);
  const extracted=join(cache,`${platform}-${arch}`);await mkdir(extracted,{recursive:true});
  if(archive.file.endsWith(".zip")){if(process.platform==="win32")await command("tar",["-xf",path,"-C",extracted],root);else await command("/usr/bin/unzip",["-oq",path,"-d",extracted],root);}
  else await command("tar",["-xzf",path,"-C",extracted],root);
  const folder=join(extracted,archive.file.replace(/\.(tar\.gz|zip)$/u,""));await mkdir(destination,{recursive:true});
  const executable=platform==="win32"?"node.exe":"bin/node";await mkdir(dirname(join(destination,executable)),{recursive:true});await copyFile(join(folder,executable),join(destination,executable));if(platform!=="win32")await chmod(join(destination,executable),0o755);
  await copyFile(join(folder,"LICENSE"),join(destination,"LICENSE"));
  await writeFile(join(destination,"runtime-manifest.json"),JSON.stringify({schema_version:"outlive.bundled-runtime.v1",node_version:NODE_VERSION,platform,arch,executable,sha256:sha256(await readFile(join(destination,executable))),product_build_id:productBuildId},null,2)+"\n");
  return {node_version:NODE_VERSION,archive:archive.file,archive_sha256:archive.sha256,executable_sha256:sha256(await readFile(join(destination,executable)))};
}
export async function validateNativePrebuild(app,platform,arch) {
  const directory=join(app,"node_modules","node-pty","prebuilds",`${platform}-${arch}`);
  const bytes=await readFile(join(directory,platform==="win32"?"conpty.node":"pty.node"));
  if(platform==="win32"){
    if(bytes.length<64||bytes.toString("ascii",0,2)!=="MZ")throw new Error("Windows PTY prebuild is not a PE binary");const offset=bytes.readUInt32LE(0x3c);
    if(offset+6>bytes.length||bytes.toString("ascii",offset,offset+4)!=="PE\0\0"||bytes.readUInt16LE(offset+4)!==(arch==="arm64"?0xaa64:0x8664))throw new Error("Windows PTY prebuild architecture mismatch");
    for(const file of ["OpenConsole.exe","conpty.dll"])await stat(join(directory,"conpty",file));
  }else{if(bytes.length<8||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==(arch==="arm64"?0x100000c:0x1000007))throw new Error("macOS PTY prebuild architecture mismatch");await chmod(join(directory,"spawn-helper"),0o755);}
}
async function hashTree(root,prefix=""){const inventory=[];for(const entry of (await readdir(join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(prefix,entry.name);if(entry.isDirectory())inventory.push(...await hashTree(root,path));else if(entry.isFile()){const bytes=await readFile(join(root,path));inventory.push({path:path.split(sep).join("/"),byte_length:bytes.length,sha256:sha256(bytes)});}else throw new Error("Product stage must contain actual files and directories");}return inventory;}
export async function validateInstalledDependencyGraph(application){
  const root=await realpath(application),seen=new Set(),edges=[];
  async function locate(name,directory){
    if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)||name.split("/").some(part=>part===".."))throw new Error("Installed dependency has an invalid package identity");
    let cursor=directory;
    while(true){try{const target=await realpath(join(cursor,"node_modules",name)),within=relative(root,target);if(within===".."||within.startsWith(`..${sep}`))throw new Error("Installed dependency escapes the packaged application");return target;}catch(error){if(error.code!=="ENOENT")throw error;}if(cursor===root)throw new Error(`Installed dependency is missing: ${name}`);cursor=dirname(cursor);}
  }
  async function visit(directory){
    if(seen.has(directory))return;seen.add(directory);const manifest=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
    for(const[name,version]of Object.entries(manifest.dependencies??{})){const target=await locate(name,directory),dependency=JSON.parse(await readFile(join(target,"package.json"),"utf8"));if(dependency.name!==name||dependency.version!==version)throw new Error(`Installed dependency version mismatch: ${name}`);edges.push({owner:manifest.name,dependency:name,version,path:relative(root,target).split(sep).join("/")});await visit(target);}
  }
  await visit(root);return {status:"passed",packages:seen.size,edges};
}
export async function recordPackagedInventory(output,platform,arch,productBuildId){
  const bundle=platform==="darwin"?join(output,"artifacts",arch==="arm64"?"mac-arm64":"mac","Outlive Agent.app"):join(output,"artifacts",arch==="arm64"?"win-arm64-unpacked":"win-unpacked");
  const resources=platform==="darwin"?join(bundle,"Contents","Resources"):join(bundle,"resources");
  const executable=platform==="darwin"?join(bundle,"Contents","MacOS","Outlive Agent"):join(bundle,"Outlive Agent.exe"),bytes=await readFile(executable);
  const dependencyGraph=await validateInstalledDependencyGraph(join(resources,"app"));
  const inventory={schema_version:"outlive.packaged-inventory.v1",product_build_id:productBuildId,platform,arch,application_files:await hashTree(join(resources,"app")),runtime_files:await hashTree(join(resources,"runtime")),launcher_files:await hashTree(join(resources,"bin")),main_executable:{path:relative(bundle,executable).split(sep).join("/"),byte_length:bytes.length,sha256:sha256(bytes)},dependency_graph:dependencyGraph,boundary:"Actual packaged resources after electron-builder pruning/manifest normalization. The product build identity names the pre-builder stage and runtime resource policy; container checksums name delivered archive bytes."};
  await writeFile(join(output,"packaged-inventory.json"),JSON.stringify(inventory,null,2)+"\n");return inventory;
}

export async function stageDesktopProduct(root,output,platform=process.platform,arch=process.arch) {
  root=await realpath(resolve(root));output=resolve(output);runtimeArchive(platform,arch);
  await mkdir(dirname(output),{recursive:true});await mkdir(output,{recursive:false});
  await buildBrandIcons(root,{check:true});
  const app=join(output,"app"),runtime=join(output,"runtime"),bin=join(output,"bin");await mkdir(app,{recursive:true});
  const original=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
  const graph=await stageDependencies(root,app,platform,arch);await stageTargetTypeScript(root,app,graph,platform,arch);
  for(const surface of ["desktop","cli","web"]){await cp(join(root,"apps",surface,"dist"),join(app,"apps",surface,"dist"),{recursive:true,dereference:true,filter:path=>!path.endsWith(".tsbuildinfo")});}
  for(const file of ["package.json","README.md","README.zh.md","tsconfig.json","src/add.ts","src/index.ts","test/run.mjs"]){const relativePath=`examples/failing-typescript-repo/${file}`;await mkdir(dirname(join(app,relativePath)),{recursive:true});await copyFile(join(root,relativePath),join(app,relativePath));}
  await copyFile(join(root,"LICENSE"),join(app,"LICENSE"));
  await writeFile(join(app,"package.json"),JSON.stringify({name:"outlive-agent",version:original.version,private:true,type:"module",main:"apps/desktop/dist/main.js",description:"Outlive Agent local workbench",author:"Outlive Agent contributors",license:"MIT",dependencies:graph.dependencies},null,2)+"\n");
  await validateNativePrebuild(app,platform,arch);
  const appInventory=await hashTree(app);const productBuildId=sha256(Buffer.from(JSON.stringify({layout_version:2,platform,arch,node_version:NODE_VERSION,runtime_resource_policy:"preserve-target-typescript-standard-libraries",files:appInventory})));
  const bundled=await stageRuntime(root,runtime,platform,arch,productBuildId);await mkdir(bin,{recursive:true});
  await copyFile(join(root,"apps","desktop","resources","bin",platform==="win32"?"outlive.cmd":"outlive"),join(bin,platform==="win32"?"outlive.cmd":"outlive"));if(platform!=="win32")await chmod(join(bin,"outlive"),0o755);
  const receipt={schema_version:"outlive.product-stage.v1",version:original.version,platform,arch,product_build_id:productBuildId,runtime:bundled,packages:graph.packages,external_node_required:false,external_pnpm_required:false,signed:false};
  await writeFile(join(output,"stage-inventory.json"),JSON.stringify({schema_version:"outlive.product-inventory.v1",product_build_id:productBuildId,app_files:appInventory,runtime_files:await hashTree(runtime),launcher_files:await hashTree(bin)},null,2)+"\n");
  await writeFile(join(output,"stage-receipt.json"),JSON.stringify(receipt,null,2)+"\n");
  return {app,runtime,bin,receipt};
}

export function validateSigningRequest(platform,signing,environment=process.env){
  if(signing.notarize&&!signing.sign)throw new Error("Notarization requires explicit signing");
  if(signing.sign&&platform!==process.platform)throw new Error("Signing verification requires a native platform runner");
  if(signing.notarize&&platform!=="darwin")throw new Error("Notarization is macOS only");
  if(signing.sign&&!environment.CSC_LINK&&!environment.CSC_NAME)throw new Error("Explicit signing requires a configured certificate identity");
  if(signing.notarize&&!((environment.APPLE_ID&&environment.APPLE_APP_SPECIFIC_PASSWORD&&environment.APPLE_TEAM_ID)||(environment.APPLE_API_KEY&&environment.APPLE_API_KEY_ID&&environment.APPLE_API_ISSUER)))throw new Error("Explicit notarization requires configured Apple credentials");
}
export async function buildDesktopProduct(root,output,platform=process.platform,arch=process.arch,directoryOnly=false,signing={sign:false,notarize:false}) {
  validateSigningRequest(platform,signing);
  const staged=await stageDesktopProduct(root,join(output,"stage"),platform,arch);
  const require=createRequire(import.meta.url),{build,Platform,Arch}=require("electron-builder");
  const target=platform==="darwin"?Platform.MAC:Platform.WINDOWS;
  const architecture=arch==="arm64"?Arch.arm64:Arch.x64;
  const config={appId:"com.outlive.agent",productName:"Outlive Agent",electronVersion:"44.5.1",asar:false,npmRebuild:false,nodeGypRebuild:false,buildDependenciesFromSource:false,removePackageScripts:false,directories:{app:staged.app,output:resolve(output,"artifacts")},files:["**/*"],extraResources:[{from:staged.runtime,to:"runtime"},{from:staged.bin,to:"bin"}],artifactName:"Outlive-Agent-${version}-${os}-${arch}.${ext}",mac:{category:"public.app-category.developer-tools",identity:null,notarize:false,target:["dmg","zip"]},win:{target:["nsis","zip"],signAndEditExecutable:true,signExecutable:signing.sign},nsis:{oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,deleteAppDataOnUninstall:false},publish:null};
  config.afterPack=async context=>{
    const resources=platform==="darwin"?join(context.appOutDir,"Outlive Agent.app","Contents","Resources"):join(context.appOutDir,"resources");
    const name=`@typescript/typescript-${platform}-${arch}`,source=join(staged.app,"node_modules",name),destination=join(resources,"app","node_modules",name);
    // These declarations are read by the native compiler at runtime. The
    // packager's default *.d.ts pruning must not remove this fixed library tree.
    await cp(join(source,"lib"),join(destination,"lib"),{recursive:true,dereference:true});
    const manifest=JSON.parse(await readFile(join(source,"package.json"),"utf8"));await validateNativeTypeScript(destination,{name,version:manifest.version},platform,arch);
    await validateInstalledDependencyGraph(join(resources,"app"));
  };
  try{await stat(join(root,"apps/desktop/build/icon.icns"));config.mac.icon=join(root,"apps/desktop/build/icon.icns");}catch{try{await stat(join(root,"apps/desktop/build/icon.png"));config.mac.icon=join(root,"apps/desktop/build/icon.png");}catch{/* default Electron artwork is declared until a selected logo exists */}}
  try{await stat(join(root,"apps/desktop/build/icon.ico"));config.win.icon=join(root,"apps/desktop/build/icon.ico");}catch{/* no Windows artwork claim without an ICO */}
  if(config.win.icon){config.nsis.installerIcon=config.win.icon;config.nsis.uninstallerIcon=config.win.icon;config.nsis.installerHeaderIcon=config.win.icon;}
  if(signing.sign){config.forceCodeSigning=true;config.mac.identity=process.env.CSC_NAME;config.mac.notarize=signing.notarize;config.win.signAndEditExecutable=true;}
  if(platform===process.platform&&arch===process.arch){try{config.electronDist=await realpath(join(root,"apps","desktop","node_modules","electron","dist"));}catch(error){if(error.code!=="ENOENT")throw error;}}
  const privateBuildKeys=["CSC_LINK","CSC_KEY_PASSWORD","CSC_NAME","WIN_CSC_LINK","WIN_CSC_KEY_PASSWORD","APPLE_ID","APPLE_APP_SPECIFIC_PASSWORD","APPLE_TEAM_ID","APPLE_API_KEY","APPLE_API_KEY_ID","APPLE_API_ISSUER"];
  const preserved=Object.fromEntries(privateBuildKeys.map(key=>[key,process.env[key]]));
  if(!signing.sign)for(const key of privateBuildKeys)delete process.env[key];
  let artifacts;try{artifacts=await build({config,targets:target.createTarget(directoryOnly?["dir"]:undefined,architecture)});}finally{for(const key of privateBuildKeys){if(preserved[key]===undefined)delete process.env[key];else process.env[key]=preserved[key];}}
  let signatureStatus="not-requested";
  if(signing.sign){
    if(platform==="darwin"){const bundle=join(output,"artifacts",arch==="arm64"?"mac-arm64":"mac","Outlive Agent.app");await command("/usr/bin/codesign",["--verify","--deep","--strict",bundle],root);if(signing.notarize)await command("xcrun",["stapler","validate",bundle],root);}
    else{for(const artifact of artifacts.filter(file=>file.endsWith(".exe"))){await command("powershell.exe",["-NoProfile","-NonInteractive","-Command",`if ((Get-AuthenticodeSignature -LiteralPath '${artifact.replaceAll("'","''")}').Status -ne 'Valid') { exit 1 }`],root);}}
    signatureStatus="verified";
  }
  const hashes=[];for(const artifact of artifacts){const info=await stat(artifact);if(info.isFile())hashes.push({file:basename(artifact),byte_length:info.size,sha256:sha256(await readFile(artifact))});}
  await recordPackagedInventory(output,platform,arch,staged.receipt.product_build_id);
  await writeFile(join(output,"product-release.json"),JSON.stringify({...staged.receipt,signed:signatureStatus==="verified",signature_status:signatureStatus,notarization_requested:signing.notarize,artifacts:hashes,packaged_inventory:"packaged-inventory.json",verification:"Build output only. Actual launch and independent platform acceptance require separate evidence; signatures are verified only when explicitly requested."},null,2)+"\n");
  await writeFile(join(output,"artifacts","SHA256SUMS"),hashes.map(item=>`${item.sha256}  ${item.file}`).join("\n")+"\n");
  return {output:resolve(output),artifacts:hashes,...staged.receipt,signed:signatureStatus==="verified",signature_status:signatureStatus,notarization_requested:signing.notarize};
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);const value=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  for(let i=0;i<args.length;i++){if(["--dir","--sign","--notarize"].includes(args[i]))continue;if(!["--platform","--arch","--output"].includes(args[i])||args[i+1]===undefined)throw new Error("Usage: node scripts/build-desktop-product.mjs [--platform darwin|win32] [--arch arm64|x64] [--output DIRECTORY] [--dir] [--sign] [--notarize]");i++;}
  process.stdout.write(JSON.stringify(await buildDesktopProduct(process.cwd(),resolve(value("--output")??"_tmp_release/desktop-product"),value("--platform")??process.platform,value("--arch")??process.arch,args.includes("--dir"),{sign:args.includes("--sign"),notarize:args.includes("--notarize")}),null,2)+"\n");
}
