import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NODE_VERSION, runtimeArchive, stageDesktopProduct, targetTypeScriptPackage, validateInstalledDependencyGraph, validateNativeTypeScript, validateSigningRequest } from "./build-desktop-product.mjs";

test("runtime downloads have pinned official archive hashes for each supported installer target",()=>{
  assert.equal(NODE_VERSION,"24.21.0");
  for(const platform of ["darwin","win32"])for(const arch of ["arm64","x64"]){const entry=runtimeArchive(platform,arch);assert.match(entry.sha256,/^[a-f0-9]{64}$/u);assert.ok(entry.file.includes(NODE_VERSION));}
  assert.throws(()=>runtimeArchive("linux","x64"),/Unsupported distribution/u);
  assert.throws(()=>runtimeArchive("darwin","ia32"),/Unsupported distribution/u);
});
test("assembly refuses to mix a new build into a preexisting stage",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-stage-negative-"));const stage=join(root,"stage");await mkdir(stage);
  try{await assert.rejects(stageDesktopProduct(root,stage,"darwin","arm64"),error=>error.code==="EEXIST");}finally{await rm(root,{recursive:true,force:true});}
});
test("CLI launchers select fixed bundled resources and clear Node injection options",async()=>{
  const shell=await readFile(new URL("../apps/desktop/resources/bin/outlive",import.meta.url),"utf8");const windows=await readFile(new URL("../apps/desktop/resources/bin/outlive.cmd",import.meta.url),"utf8");
  assert.match(shell,/unset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE/u);assert.match(shell,/runtime\/bin\/node/u);assert.doesNotMatch(shell,/pnpm|npx|\/usr\/bin\/node/u);
  assert.match(windows,/set "NODE_OPTIONS="/u);assert.match(windows,/runtime\\node\.exe/u);assert.doesNotMatch(windows,/pnpm|npx/u);
});
test("unsigned builds ignore certificate configuration and requested signing fails closed without credentials",()=>{
  assert.doesNotThrow(()=>validateSigningRequest(process.platform,{sign:false,notarize:false},{}));
  assert.throws(()=>validateSigningRequest(process.platform,{sign:true,notarize:false},{}),/configured certificate/u);
  assert.throws(()=>validateSigningRequest("darwin",{sign:false,notarize:true},{}),/requires explicit signing/u);
});
test("cross-platform native TypeScript selection requires the exact target and lockfile integrity",()=>{
  const name="@typescript/typescript-win32-x64",manifest={optionalDependencies:{[name]:"7.0.2"}},lock={packages:{[`${name}@7.0.2`]:{resolution:{integrity:`sha512-${"a".repeat(86)}==`}}}};
  assert.equal(targetTypeScriptPackage(manifest,lock,"win32","x64").name,name);
  assert.throws(()=>targetTypeScriptPackage(manifest,lock,"darwin","arm64"),/exactly pinned/u);
  assert.throws(()=>targetTypeScriptPackage({...manifest,optionalDependencies:{[name]:"^7.0.2"}},lock,"win32","x64"),/exactly pinned/u);
  assert.throws(()=>targetTypeScriptPackage(manifest,{packages:{}},"win32","x64"),/SHA-512/u);
});
test("a correct native manifest cannot hide a binary for the wrong Windows CPU",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"outlive-native-negative-")),expected={name:"@typescript/typescript-win32-x64",version:"7.0.2"};
  try{
    await mkdir(join(directory,"lib"));await writeFile(join(directory,"lib","lib.d.ts"),"/// reference runtime standard library\n");await writeFile(join(directory,"package.json"),JSON.stringify({...expected,os:["win32"],cpu:["x64"]}));
    const binary=Buffer.alloc(128);binary.write("MZ");binary.writeUInt32LE(64,0x3c);binary.write("PE\0\0",64);binary.writeUInt16LE(0xaa64,68);await writeFile(join(directory,"lib","tsc.exe"),binary);
    await assert.rejects(validateNativeTypeScript(directory,expected,"win32","x64"),/architecture mismatch/u);
    binary.writeUInt16LE(0x8664,68);await writeFile(join(directory,"lib","tsc.exe"),binary);await validateNativeTypeScript(directory,expected,"win32","x64");
    await rm(join(directory,"lib","lib.d.ts"));await assert.rejects(validateNativeTypeScript(directory,expected,"win32","x64"),error=>error.code==="ENOENT");
  }finally{await rm(directory,{recursive:true,force:true});}
});
test("post-pack dependency relocation must preserve every exact dependency version",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"outlive-dependency-negative-"));
  try{
    await writeFile(join(directory,"package.json"),JSON.stringify({name:"installed-root",dependencies:{"native-engine":"1.2.3"}}));
    await assert.rejects(validateInstalledDependencyGraph(directory),/is missing/u);
    await mkdir(join(directory,"node_modules","native-engine"),{recursive:true});await writeFile(join(directory,"node_modules","native-engine","package.json"),JSON.stringify({name:"native-engine",version:"1.2.2"}));
    await assert.rejects(validateInstalledDependencyGraph(directory),/version mismatch/u);
    await writeFile(join(directory,"node_modules","native-engine","package.json"),JSON.stringify({name:"native-engine",version:"1.2.3"}));assert.equal((await validateInstalledDependencyGraph(directory)).packages,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});
