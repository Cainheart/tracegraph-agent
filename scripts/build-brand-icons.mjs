import {createHash} from "node:crypto";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Resvg} from "@resvg/resvg-js";

export const BRAND_RENDERER="@resvg/resvg-js@2.6.2";
export const BRAND_SOURCE="docs/brand/current.svg";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
export function readMark(source){
 if(!source.includes('viewBox="0 0 100 100"')||/<(?:image|use|script|foreignObject|mask|clipPath|filter)\b/u.test(source)||/\b(?:href|transform)=/u.test(source))throw new Error("Brand source must be the fixed standalone Current paths");
 const paths=[...source.matchAll(/<path d="([^"]+)" fill="(#[A-Fa-f0-9]{6})"\s*\/>/gu)].map(match=>({d:match[1],fill:match[2]}));
 if(paths.length!==3||paths.map(path=>path.fill).join(",")!=="#225C55,#79A388,#C5AA72")throw new Error("Brand source must preserve the selected Current geometry and palette");
 return paths;
}
export function appIconSvg(source){const paths=readMark(source).map(path=>`<path d="${path.d}" fill="${path.fill}"/>`).join("");return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="24" y="24" width="976" height="976" rx="220" fill="#F6F4ED"/><g transform="translate(112 112) scale(8)">${paths}</g></svg>\n`;}
export function renderBrand(svg,size){return new Resvg(svg,{fitTo:{mode:"width",value:size},font:{loadSystemFonts:false},logLevel:"off"}).render();}
export function packIcns(images){const entries=[["icp4",16],["icp5",32],["icp6",64],["ic07",128],["ic08",256],["ic09",512],["ic10",1024],["ic11",32],["ic12",64],["ic13",256],["ic14",512]].map(([type,size])=>{const png=images.get(size),header=Buffer.alloc(8);header.write(type,0,"ascii");header.writeUInt32BE(png.length+8,4);return Buffer.concat([header,png]);});const header=Buffer.alloc(8);header.write("icns",0,"ascii");header.writeUInt32BE(8+entries.reduce((total,entry)=>total+entry.length,0),4);return Buffer.concat([header,...entries]);}
export function packIco(images){const sizes=[16,24,32,48,64,128,256],header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;const parts=[];sizes.forEach((size,index)=>{const png=images.get(size),at=6+16*index;header[at]=size===256?0:size;header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(png.length,at+8);header.writeUInt32LE(offset,at+12);offset+=png.length;parts.push(png);});return Buffer.concat([header,...parts]);}
export function brandOutputs(source){const outputs=new Map(),paths=readMark(source),svg=appIconSvg(source),images=new Map([16,24,32,48,64,128,256,512,1024].map(size=>[size,renderBrand(svg,size).asPng()]));
 outputs.set("docs/brand/app-icon.svg",Buffer.from(svg));
 outputs.set("apps/desktop/build/icon.png",images.get(1024));
 for(const size of [16,32,128,256,512])for(const scale of [1,2])outputs.set(`apps/desktop/build/Outlive.iconset/icon_${size}x${size}${scale===2?"@2x":""}.png`,images.get(size*scale));
 outputs.set("apps/desktop/build/icon.icns",packIcns(images));outputs.set("apps/desktop/build/icon.ico",packIco(images));
 for(const directory of ["apps/web/public","apps/desktop/renderer/public","docs/public"]){outputs.set(`${directory}/brand-current.svg`,Buffer.from(source));outputs.set(`${directory}/favicon.ico`,packIco(images));}
 const generated=`// Generated from ${BRAND_SOURCE}; run node scripts/build-brand-icons.mjs.\nexport const CURRENT_MARK_SOURCE_SHA256=${JSON.stringify(sha(source))};\nexport const CURRENT_MARK_PATHS=${JSON.stringify(paths)} as const;\n`;
 outputs.set("packages/workbench/src/brand-current.generated.ts",Buffer.from(generated));
 const manifest={schema_version:"outlive.brand-assets.v1",selection:"B Current",source:BRAND_SOURCE,source_sha256:sha(source),renderer:BRAND_RENDERER,frame:{width:1024,height:1024,background_rect:{x:24,y:24,width:976,height:976,radius:220,fill:"#F6F4ED"},symbol_transform:"translate(112 112) scale(8)"},files:[...outputs].map(([path,bytes])=>({path,byte_length:bytes.length,sha256:sha(bytes)}))};
 outputs.set("docs/brand/assets-manifest.json",Buffer.from(JSON.stringify(manifest,null,2)+"\n"));return outputs;
}
export async function buildBrandIcons(repositoryRoot=root,{check=false}={}){const source=await readFile(join(repositoryRoot,BRAND_SOURCE),"utf8"),outputs=brandOutputs(source);for(const [path,bytes]of outputs){const target=join(repositoryRoot,path);if(check){let actual;try{actual=await readFile(target);}catch{throw new Error(`Missing derived brand asset: ${path}`);}if(!actual.equals(bytes))throw new Error(`Stale or malformed derived brand asset: ${path}`);}else{await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}}return {selection:"B Current",source_sha256:sha(source),files:outputs.size,mode:check?"verified":"generated"};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){console.log(JSON.stringify(await buildBrandIcons(root,{check:process.argv.includes("--check")})));}
