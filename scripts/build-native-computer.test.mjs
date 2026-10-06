import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildNativeComputer,validateNativeComputerBinary} from "./build-native-computer.mjs";
test("native computer delivery rejects mismatched platform and architecture headers",()=>{
 const mac=Buffer.alloc(16);mac.writeUInt32LE(0xfeedfacf,0);mac.writeUInt32LE(0x100000c,4);validateNativeComputerBinary(mac,"darwin","arm64");assert.throws(()=>validateNativeComputerBinary(mac,"darwin","x64"),/architecture mismatch/u);assert.throws(()=>validateNativeComputerBinary(mac,"win32","x64"),/PE binary/u);
 const win=Buffer.alloc(128);win.write("MZ");win.writeUInt32LE(64,0x3c);win.write("PE\0\0",64);win.writeUInt16LE(0xaa64,68);validateNativeComputerBinary(win,"win32","arm64");assert.throws(()=>validateNativeComputerBinary(win,"win32","x64"),/architecture mismatch/u);
});
test("non-native assembly reports unavailable and removes a stale foreign executable",async()=>{
 const output=await mkdtemp(join(tmpdir(),"outlive-computer-cross-")),platform=process.platform==="win32"?"darwin":"win32",executable=platform==="win32"?"outlive-computer.exe":"outlive-computer";
 try{await writeFile(join(output,executable),"foreign binary must never ship");const manifest=await buildNativeComputer(process.cwd(),output,platform,"x64");assert.equal(manifest.available,false);assert.equal(manifest.reason,"native-runner-required");assert.equal(manifest.executable,undefined);assert.equal(manifest.sha256,undefined);assert.match(manifest.source_sha256,/^[a-f0-9]{64}$/u);await assert.rejects(readFile(join(output,executable)),error=>error.code==="ENOENT");assert.deepEqual(JSON.parse(await readFile(join(output,"computer-manifest.json"),"utf8")),manifest);}finally{await rm(output,{recursive:true,force:true});}
});
