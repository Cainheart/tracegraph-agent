import {MAX_PROJECT_FILE_BYTES,type ProjectFileSnapshot,type ProjectFileSaveRequest,type ProjectFileSaveResult} from "@tracegraph/contracts";
const hash=async(bytes:Uint8Array)=>"sha256:"+Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes))),value=>value.toString(16).padStart(2,"0")).join("");
export async function verifyProjectFileSnapshot(snapshot:ProjectFileSnapshot,projectId:string,path:string):Promise<ProjectFileSnapshot>{
 if(snapshot.project_id!==projectId||snapshot.path!==path)throw new TypeError("Project file response has a different scope");
 let bytes:Uint8Array|undefined;
 if(snapshot.kind==="text")bytes=new TextEncoder().encode(snapshot.content!);
 else if(snapshot.image){const decoded=atob(snapshot.image.data_base64);if(btoa(decoded)!==snapshot.image.data_base64)throw new TypeError("Project image has invalid base64");bytes=Uint8Array.from(decoded,value=>value.charCodeAt(0));const mime=snapshot.image.media_type;const signature=mime==="image/png"?bytes.length>=8&&Array.from(bytes.subarray(0,8)).join(",")==="137,80,78,71,13,10,26,10":mime==="image/jpeg"?bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217:new TextDecoder("ascii").decode(bytes.subarray(0,4))==="RIFF"&&new TextDecoder("ascii").decode(bytes.subarray(8,12))==="WEBP";if(!signature)throw new TypeError("Project image signature differs from its media type");}
 if(bytes&&(bytes.length>MAX_PROJECT_FILE_BYTES||bytes.length!==snapshot.byte_length||await hash(bytes)!==snapshot.sha256))throw new TypeError("Project file bytes failed integrity verification");
 return snapshot;
}
export async function verifyProjectFileSaveResult(result:ProjectFileSaveResult,projectId:string,input:ProjectFileSaveRequest):Promise<ProjectFileSaveResult>{if(result.project_id!==projectId||result.path!==input.path||result.command_id!==input.command_id||result.expected_sha256!==input.expected_sha256||result.content_sha256!==await hash(new TextEncoder().encode(input.content)))throw new TypeError("Project save receipt differs from its bound intent");return result;}
