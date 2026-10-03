import { lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicPrivateJson, readLocalProfile, type LocalProfileOptions } from "./local-profile.js";

const StopIntentSchema = z.object({schema_version:z.literal("outlive.owner-stop.v1"),profile_id:z.string().uuid(),owner_nonce:z.string().uuid(),stopped_at:z.string().datetime()}).strict();
export class LocalHostStoppedError extends Error {
  readonly code="host_stopped";
  constructor(){super("The local Host was explicitly stopped. Start it explicitly to continue.");this.name="LocalHostStoppedError";}
}
/** Only explicit stop writes this marker. Crashes and client detachment never do. */
export async function readLocalOwnerStopIntent(options:LocalProfileOptions):Promise<boolean> {
  const path=join(options.profileRoot!,"owner-stop.json");
  try {
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||(process.platform!=="win32"&&(info.mode&0o077)!==0))throw new Error("Owner stop intent must be a private regular file");
    const intent=StopIntentSchema.parse(JSON.parse(await readFile(path,"utf8")));
    const profile=await readLocalProfile(options);
    if(intent.profile_id!==profile.profile_id)throw new Error("Owner stop intent profile identity is invalid");
    return true;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
}
export async function persistLocalOwnerStopIntent(profileRoot:string,profileId:string,ownerNonce:string):Promise<void> {
  await atomicPrivateJson(join(profileRoot,"owner-stop.json"),StopIntentSchema.parse({schema_version:"outlive.owner-stop.v1",profile_id:profileId,owner_nonce:ownerNonce,stopped_at:new Date().toISOString()}));
}
export async function clearLocalOwnerStopIntent(profileRoot:string):Promise<void> {
  // Validate an existing marker before an explicit start retires it.
  if(await readLocalOwnerStopIntent({profileRoot}))await unlink(join(profileRoot,"owner-stop.json")).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
}
