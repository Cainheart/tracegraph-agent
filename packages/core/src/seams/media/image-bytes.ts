import {inflateSync} from "node:zlib";
import {MAX_GENERATED_IMAGE_BYTES,type MediaMimeType} from "@tracegraph/contracts";

export interface VerifiedImage {bytes:Uint8Array;mimeType:MediaMimeType;width:number;height:number}
const bad=()=>new TypeError("Image output is not a valid bounded image");
export function strictImageBase64(value:unknown):Uint8Array {
  if(typeof value!=="string"||value.length===0||value.length>Math.ceil(MAX_GENERATED_IMAGE_BYTES/3)*4||value.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/u.test(value))throw bad();
  const bytes=Buffer.from(value,"base64");if(bytes.byteLength===0||bytes.byteLength>MAX_GENERATED_IMAGE_BYTES||bytes.toString("base64")!==value)throw bad();return bytes;
}
function dimensions(width:number,height:number){if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>16_777_216)throw bad();return {width,height};}
export function verifyRasterImage(input:Uint8Array,expected?:string):VerifiedImage {
  const bytes=Buffer.from(input);if(bytes.length<12||bytes.length>MAX_GENERATED_IMAGE_BYTES)throw bad();
  let mimeType:MediaMimeType,size:{width:number;height:number};
  if(bytes.subarray(0,8).toString("hex")==="89504e470d0a1a0a"){
    mimeType="image/png";let offset=8,header=false,ended=false;let width=0,height=0,channels=0,depth=0;const idat:Buffer[]=[];
    while(offset<bytes.length){if(offset+12>bytes.length)throw bad();const length=bytes.readUInt32BE(offset),type=bytes.toString("ascii",offset+4,offset+8);if(length>MAX_GENERATED_IMAGE_BYTES||offset+12+length>bytes.length)throw bad();const chunk=bytes.subarray(offset+4,offset+8+length);if(crc32(chunk)!==bytes.readUInt32BE(offset+8+length))throw bad();const data=bytes.subarray(offset+8,offset+8+length);
      if(!header){if(type!=="IHDR"||length!==13)throw bad();width=data.readUInt32BE(0);height=data.readUInt32BE(4);depth=data[8]!;channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[data[9]!]??0;if(!channels||depth!==8||data[10]!==0||data[11]!==0||data[12]!==0)throw bad();dimensions(width,height);header=true;}
      else if(type==="IHDR")throw bad();
      if(!["IHDR","IDAT","IEND","PLTE"].includes(type)&&/^[A-Z]/u.test(type))throw bad();
      if(type==="PLTE"&&(idat.length>0||length<3||length>768||length%3!==0))throw bad();
      if(type==="IDAT")idat.push(data);
      if(type==="IEND"){if(length!==0||!idat.length||offset+12!==bytes.length)throw bad();ended=true;break;}
      offset+=length+12;
    }
    if(!ended)throw bad();const row=width*channels+1,total=row*height;let pixels:Buffer;try{pixels=inflateSync(Buffer.concat(idat),{maxOutputLength:total});}catch{throw bad();}if(pixels.length!==total)throw bad();for(let index=0;index<height;index++)if(pixels[index*row]!>4)throw bad();size={width,height};
  }else throw new TypeError("Unsupported generated image format; request PNG output");
  if(expected!==undefined&&mimeType!==expected)throw bad();return {bytes,mimeType,...size};
}
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
