import {createHash,randomUUID} from "node:crypto";
import {chmod,copyFile,lstat,mkdir,readdir,readFile,rename,rm} from "node:fs/promises";
import {basename,dirname,join,relative,resolve} from "node:path";
import {atomicPrivateJson,defaultLocalProfileRoot,privateDirectory} from "./local-profile.js";
import {acquireOwnerLease,acquireRuntimeRootLease,processExists} from "./owner-lease.js";

export interface LegacyMigrationSource {readonly id:string;readonly dataRoot:string;readonly sessionRoot?:string|undefined;readonly modelConfigPath?:string|undefined;readonly permissionConfigPath?:string|undefined;readonly credentialFile?:string|undefined;}
export interface LegacyMigrationOptions {readonly profileRoot?:string|undefined;readonly sources:readonly LegacyMigrationSource[];readonly selectedSourceId?:string|undefined;}
export interface MigrationInventoryFile {source_id:string;scope:"data"|"sessions"|"model"|"permission"|"credentials";path:string;relative_path:string;bytes:number;sha256:string;}
export interface LegacyMigrationPreview {profile_root:string;selected_source_id:string|null;requires_source_selection:boolean;files:MigrationInventoryFile[];conflicts:{scope:string;relative_path:string;source_ids:string[]}[];active_writer_sources:string[];warnings:string[];}
const forbidden=new Set(["owner.json","runtime-owner.json","discovery.json"]);
/** Explicit source paths only. Inventory never parses or returns credential values. */
export async function previewLegacyMigration(options:LegacyMigrationOptions):Promise<LegacyMigrationPreview> {
  const ids=new Set<string>();const files:MigrationInventoryFile[]=[];const active:string[]=[];
  for(const source of options.sources){if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(source.id)||ids.has(source.id))throw new Error("Migration source identifiers must be unique safe names");ids.add(source.id);
    for(const [scope,path] of [["data",source.dataRoot],["sessions",source.sessionRoot],["model",source.modelConfigPath],["permission",source.permissionConfigPath],["credentials",source.credentialFile]] as const){if(!path)continue;await inventory(resolve(path),resolve(path),scope,source.id,files,active);}
  }
  if(options.selectedSourceId && !ids.has(options.selectedSourceId))throw new Error("Selected migration source does not exist");
  const groups=new Map<string,MigrationInventoryFile[]>();
  for(const file of files){const key=`${file.scope}:${file.relative_path}`;const group=groups.get(key)??[];group.push(file);groups.set(key,group);}
  const conflicts=[...groups].filter(([,items])=>new Set(items.map(x=>x.sha256)).size>1).map(([key,items])=>({scope:key.slice(0,key.indexOf(":")),relative_path:items[0]!.relative_path,source_ids:items.map(x=>x.source_id)}));
  return {profile_root:resolve(options.profileRoot ?? defaultLocalProfileRoot()),selected_source_id:options.selectedSourceId ?? (options.sources.length===1?options.sources[0]!.id:null),requires_source_selection:options.sources.length>1&&!options.selectedSourceId,files,conflicts,active_writer_sources:[...new Set(active)],warnings:["Original source directories are preserved","Imported linked paths and managed projects remain quarantined until explicitly registered","Only the selected source is canonical; other sources remain isolated","Credential references unavailable in this profile must be reconfigured"]};
}
async function inventory(path:string,root:string,scope:MigrationInventoryFile["scope"],id:string,files:MigrationInventoryFile[],active:string[]):Promise<void> {
  let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(info.isSymbolicLink())throw new Error(`Migration refuses symbolic links in source ${id}`);
  if(info.isDirectory()){for(const child of await readdir(path))await inventory(join(path,child),root,scope,id,files,active);return;}
  if(!info.isFile())return;
  if(forbidden.has(basename(path)) || path.endsWith(".lock")){
    try{const value=JSON.parse(await readFile(path,"utf8")) as {pid?:unknown};if(typeof value.pid==="number"&&processExists(value.pid))active.push(id);}catch{/* opaque/incomplete writer markers are handled by unchanged-source inventory */}
    return;
  }
  const content=await readFile(path);files.push({source_id:id,scope,path,relative_path:relative(root,path)||basename(path),bytes:info.size,sha256:createHash("sha256").update(content).digest("hex")});
}
/** Backup-first commit with an exclusive target owner. Does not execute or replay imported facts. */
export async function commitLegacyMigration(options:LegacyMigrationOptions):Promise<{profile_root:string;backup_root:string;selected_source_id:string;copied_files:number;quarantined_source_ids:string[]}> {
  const preview=await previewLegacyMigration(options);
  if(preview.requires_source_selection || !preview.selected_source_id)throw new Error("Choose one migration source before committing");
  if(preview.active_writer_sources.length)throw new Error("Stop legacy writers before migration; source data remains unchanged");
  const root=await privateDirectory(preview.profile_root);
  const lease=await acquireOwnerLease(root);
  const migrationId=randomUUID();const staging=await privateDirectory(join(root,`.migration-${migrationId}`));const backup=await privateDirectory(join(dirname(root),`${basename(root)}-backup-${migrationId}`));
  const installed:string[]=[];const replaced:string[]=[];
  let previousProfile:{profile_id:string;data_root:string;session_root:string}|undefined;
  try{previousProfile=JSON.parse(await readFile(join(root,"profile.json"),"utf8")) as typeof previousProfile;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const targetData=previousProfile?.data_root ?? join(root,"data"),targetSessions=previousProfile?.session_root ?? join(root,"sessions");
  const runtimeLeases:Awaited<ReturnType<typeof acquireRuntimeRootLease>>[]=[];
  const externalInstalled:Array<{root:string;backup:string}>=[];
  try{
    for(const target of [...new Set([targetData,targetSessions])].sort())runtimeLeases.push(await acquireRuntimeRootLease(target));
    for(const entry of await readdir(root)){if(entry==="owner.json"||entry.startsWith(".migration-"))continue;await copyTree(join(root,entry),join(backup,entry));}
    let copied=0;
    for(const file of preview.files){const selected=file.source_id===preview.selected_source_id;let destination:string;
      if(!selected)destination=join(staging,"migration-conflicts",file.source_id,file.scope,file.relative_path);
      else if(file.scope==="data"){
        // Preserve project evidence without inheriting its execution authority.
        if(file.relative_path==="local-projects.json" || file.relative_path==="projects.json")destination=join(staging,"migration-conflicts",file.source_id,file.relative_path);
        else if(file.relative_path==="credentials.json")destination=join(staging,"credentials.json");
        else if(file.relative_path==="harness-config.json")destination=join(staging,"config","harness-config.json");
        else if(file.relative_path.startsWith("sessions/"))destination=join(staging,"sessions",file.relative_path.slice("sessions/".length));
        else if(file.relative_path.startsWith("sessions-trash/"))destination=join(staging,"sessions-trash",file.relative_path.slice("sessions-trash/".length));
        else if(file.relative_path.startsWith("projects/"))destination=join(staging,"data","legacy-projects",file.relative_path.slice("projects/".length));
        else destination=join(staging,"data",file.relative_path);
      }else if(file.scope==="sessions")destination=join(staging,"sessions",file.relative_path);
      else if(file.scope==="model")destination=join(staging,"data","model-config.json");
      else if(file.scope==="permission")destination=join(staging,"config","harness-config.json");
      else destination=join(staging,"credentials.json");
      const current=await readFile(file.path);if(createHash("sha256").update(current).digest("hex")!==file.sha256)throw new Error("A migration source changed after inventory; retry dry-run");
      const sourceBackup=join(backup,"sources",file.source_id,file.scope,file.relative_path);await privateDirectory(dirname(sourceBackup));await copyFile(file.path,sourceBackup);await chmod(sourceBackup,0o600);
      await privateDirectory(dirname(destination));await copyFile(file.path,destination);await chmod(destination,0o600);copied++;
    }
    await privateDirectory(join(staging,"data"));await privateDirectory(join(staging,"sessions"));
    await atomicPrivateJson(join(staging,"migration-report.json"),{schema_version:"outlive.migration.v1",migration_id:migrationId,selected_source_id:preview.selected_source_id,source_ids:options.sources.map(x=>x.id),conflicts:preview.conflicts,warnings:preview.warnings,committed_at:new Date().toISOString()});
    // Profile identity is published last; leases prevent a Runtime observing partial installation.
    for(const entry of await readdir(staging)){
      const target=entry==="data"?targetData:entry==="sessions"?targetSessions:join(root,entry);
      if(target!==join(root,entry)){
        const externalBackup=join(backup,`${entry}-external`);await copyTree(target,externalBackup);
        const displaced=`${target}.migration-backup-${migrationId}`;
        await rename(target,displaced);externalInstalled.push({root:target,backup:displaced});
        await rename(join(staging,entry),target);continue;
      }
      try{await rename(target,join(backup,`${entry}.replaced`));replaced.push(entry);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      await rename(join(staging,entry),join(root,entry));installed.push(entry);
    }
    const profileId=previousProfile?.profile_id ?? randomUUID();
    await atomicPrivateJson(join(root,"profile.json"),{schema_version:"outlive.profile.v1",profile_id:profileId,created_at:new Date().toISOString(),data_root:targetData,session_root:targetSessions});
    return {profile_root:root,backup_root:backup,selected_source_id:preview.selected_source_id,copied_files:copied,quarantined_source_ids:options.sources.filter(x=>x.id!==preview.selected_source_id).map(x=>x.id)};
  }catch(error){for(const external of externalInstalled.reverse()){await rm(external.root,{recursive:true,force:true});await rename(external.backup,external.root);}for(const entry of installed.reverse())await rm(join(root,entry),{recursive:true,force:true});for(const entry of replaced.reverse())await rename(join(backup,`${entry}.replaced`),join(root,entry));throw error;}
  finally{await rm(staging,{recursive:true,force:true});for(const runtimeLease of runtimeLeases.reverse())await runtimeLease.release();await lease.release();}
}
async function copyTree(source:string,destination:string):Promise<void>{const info=await lstat(source);if(info.isSymbolicLink())throw new Error("Backup refuses symbolic links");if(info.isDirectory()){await privateDirectory(destination);for(const entry of await readdir(source)){if(forbidden.has(entry))continue;await copyTree(join(source,entry),join(destination,entry));}}else if(info.isFile()){await mkdir(dirname(destination),{recursive:true,mode:0o700});await copyFile(source,destination);await chmod(destination,0o600);}}
