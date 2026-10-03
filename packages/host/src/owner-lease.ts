import {tmpdir} from "node:os";
import {createHash,randomUUID} from "node:crypto";
import {open,readFile,rename,unlink} from "node:fs/promises";
import {join} from "node:path";
import {privateDirectory} from "./local-profile.js";
import {z} from "zod";
const OwnerSchema=z.object({schema_version:z.literal("outlive.owner.v1"),pid:z.number().int().positive(),nonce:z.string().uuid(),started_at:z.string()}).strict();
export class LocalHostOwnedError extends Error {constructor(){super("A local Host already owns this profile");this.name="LocalHostOwnedError";}}
export async function acquireOwnerLease(root:string,fileName="owner.json") {
  await privateDirectory(root);
  const path=join(root,fileName);
  for(let attempt=0;attempt<4;attempt++) {
    const nonce=randomUUID();
    try {
      const handle=await open(path,"wx",0o600);
      const identity=await handle.stat();
      try { await handle.writeFile(JSON.stringify({schema_version:"outlive.owner.v1",pid:process.pid,nonce,started_at:new Date().toISOString()}));await handle.sync(); }
      catch(error){await handle.close();throw error;}
      return {nonce,path,async release(){
        try { const current=OwnerSchema.parse(JSON.parse(await readFile(path,"utf8")));const stat=await (await import("node:fs/promises")).stat(path); if(current.nonce===nonce && stat.ino===identity.ino && stat.dev===identity.dev) await unlink(path); }
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
        finally {await handle.close();}
      }};
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      let owner:z.infer<typeof OwnerSchema>;
      try {owner=OwnerSchema.parse(JSON.parse(await readFile(path,"utf8")));}
      catch {throw new LocalHostOwnedError();} // In-progress or corrupted records never confer takeover authority.
      if(processExists(owner.pid)) throw new LocalHostOwnedError();
      // Atomically quarantine an abandoned lease; never unlink a racing new owner.
      const quarantine=`${path}.stale-${owner.nonce}-${randomUUID()}`;
      const snapshot=await readFile(path,"utf8");
      if(OwnerSchema.parse(JSON.parse(snapshot)).nonce!==owner.nonce) continue;
      try {await rename(path,quarantine);} catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
    }
  }
  throw new LocalHostOwnedError();
}
export function processExists(pid:number):boolean {try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=="ESRCH";}}

/** Stable lock location survives atomic replacement of a data/session directory. */
export async function acquireRuntimeRootLease(root:string) {
  const canonical=await privateDirectory(root);
  const digest=createHash("sha256").update(canonical).digest("hex");
  const lockRoot=await privateDirectory(join(tmpdir(),`outlive-owners-${process.getuid?.() ?? "user"}`));
  const global=await acquireOwnerLease(lockRoot,`${digest}.json`);
  try{const marker=await acquireOwnerLease(canonical,"runtime-owner.json");return {nonce:global.nonce,path:global.path,async release(){try{await marker.release();}finally{await global.release();}}};}
  catch(error){await global.release();throw error;}
}
