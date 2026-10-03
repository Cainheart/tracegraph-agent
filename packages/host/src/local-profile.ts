import {randomUUID,createHash} from "node:crypto";
import {chmod,lstat,mkdir,readFile,realpath,rename,writeFile} from "node:fs/promises";
import {homedir,tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {z} from "zod";

export const LOCAL_HOST_PROTOCOL_VERSION = "outlive.local-host.v1" as const;
const ProfileSchema = z.object({schema_version:z.literal("outlive.profile.v1"),profile_id:z.string().uuid(),created_at:z.string(),data_root:z.string(),session_root:z.string()}).strict();
export type LocalProfile = z.infer<typeof ProfileSchema> & {profile_root:string};
export interface LocalProfileOptions {readonly profileRoot?:string;readonly dataRoot?:string;readonly sessionRoot?:string;}
export function defaultLocalProfileRoot(environment:NodeJS.ProcessEnv=process.env):string {
  return resolve(environment.OUTLIVE_PROFILE_ROOT ?? join(homedir(),".outlive","profiles","default"));
}
export async function privateDirectory(path:string):Promise<string> {
  await mkdir(path,{recursive:true,mode:0o700});
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Local profile directory must be an actual directory");
  if (process.platform !== "win32" && metadata.uid !== process.getuid?.()) throw new Error("Local profile belongs to another user");
  await chmod(path,0o700);
  return realpath(path);
}
export async function readLocalProfile(options:LocalProfileOptions={}):Promise<LocalProfile> {
  const profileRoot=await realpath(resolve(options.profileRoot ?? defaultLocalProfileRoot()));
  const profile=ProfileSchema.parse(JSON.parse(await readFile(join(profileRoot,"profile.json"),"utf8")));
  if (options.dataRoot && await realpath(resolve(options.dataRoot))!==profile.data_root) throw new Error("Profile data root cannot change while connecting");
  if (options.sessionRoot && await realpath(resolve(options.sessionRoot))!==profile.session_root) throw new Error("Profile session root cannot change while connecting");
  return {...profile,profile_root:profileRoot};
}
/** Called only while the exclusive owner lease is held. */
export async function initializeLocalProfile(options:LocalProfileOptions={}):Promise<LocalProfile> {
  const profileRoot=await privateDirectory(resolve(options.profileRoot ?? defaultLocalProfileRoot()));
  try { return await readLocalProfile({...options,profileRoot}); }
  catch(error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  const dataRoot=await privateDirectory(resolve(options.dataRoot ?? join(profileRoot,"data")));
  const sessionRoot=await privateDirectory(resolve(options.sessionRoot ?? join(profileRoot,"sessions")));
  const profile=ProfileSchema.parse({schema_version:"outlive.profile.v1",profile_id:randomUUID(),created_at:new Date().toISOString(),data_root:dataRoot,session_root:sessionRoot});
  await atomicPrivateJson(join(profileRoot,"profile.json"),profile);
  return {...profile,profile_root:profileRoot};
}
export async function atomicPrivateJson(path:string,value:unknown):Promise<void> {
  const temporary=`${path}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(value,null,2)+"\n",{mode:0o600,flag:"wx"});
  await rename(temporary,path);
  await chmod(path,0o600);
}
export function localSocketPath(profileRoot:string,nonce:string):string {
  const digest=createHash("sha256").update(profileRoot).digest("hex").slice(0,20);
  return process.platform === "win32" ? `\\\\.\\pipe\\outlive-${digest}-${nonce}` : join(tmpdir(),`outlive-host-${process.getuid?.() ?? "user"}`,`${digest}-${nonce.slice(0,12)}.sock`);
}
