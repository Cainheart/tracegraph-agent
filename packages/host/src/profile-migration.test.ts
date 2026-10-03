import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect} from "vitest";
import {previewLegacyMigration,commitLegacyMigration} from "./profile-migration.js";
import {initializeLocalProfile} from "./local-profile.js";

describe("explicit shared profile migration",()=>{
 it("previews conflict and commits one source with backup and quarantined project authority",async()=>{
  const scratch=await mkdtemp(join(tmpdir(),"outlive-migrate-"));try{
   const a=join(scratch,"legacy-a"),b=join(scratch,"legacy-b"),profileRoot=join(scratch,"profile");await mkdir(join(a,"events"),{recursive:true});await mkdir(join(b,"events"),{recursive:true});await mkdir(join(a,"projects","fixture"),{recursive:true});
   const canonical='{"run_id":"run:original","event_id":"event:original"}\n';await writeFile(join(a,"events","run.jsonl"),canonical);await writeFile(join(b,"events","run.jsonl"),'{"run_id":"run:conflict"}\n');await writeFile(join(a,"local-projects.json"),'{"version":1,"projects":[{"real_root":"/untrusted/imported-path"}]}');await writeFile(join(a,"projects","fixture","source.ts"),'export const fixture=true;');
   const sources=[{id:"web",dataRoot:a},{id:"desktop",dataRoot:b}];const preview=await previewLegacyMigration({profileRoot,sources});expect(preview.requires_source_selection).toBe(true);expect(preview.conflicts).toHaveLength(1);await expect(commitLegacyMigration({profileRoot,sources})).rejects.toThrow("Choose one");
   await initializeLocalProfile({profileRoot});await writeFile(join(profileRoot,"data","existing.jsonl"),'existing evidence');const result=await commitLegacyMigration({profileRoot,sources,selectedSourceId:"web"});expect(await readFile(join(profileRoot,"data","events","run.jsonl"),"utf8")).toBe(canonical);expect(await readFile(join(a,"events","run.jsonl"),"utf8")).toBe(canonical);expect(await readFile(join(result.backup_root,"data","existing.jsonl"),"utf8")).toBe("existing evidence");
   expect(await readFile(join(profileRoot,"migration-conflicts","desktop","data","events","run.jsonl"),"utf8")).toContain("run:conflict");expect(await readFile(join(profileRoot,"migration-conflicts","web","local-projects.json"),"utf8")).toContain("untrusted");expect(await readFile(join(profileRoot,"data","legacy-projects","fixture","source.ts"),"utf8")).toContain("fixture");await expect(readFile(join(profileRoot,"data","local-projects.json"))).rejects.toMatchObject({code:"ENOENT"});
  }finally{await rm(scratch,{recursive:true,force:true});}
 });
 it("refuses live writers, symlinks and leaves source bytes untouched",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-migrate-deny-"));try{const data=join(root,"legacy");await mkdir(data);await writeFile(join(data,"runtime-owner.json"),JSON.stringify({pid:process.pid}));await writeFile(join(data,"evidence.jsonl"),"original");const input={profileRoot:join(root,"profile"),sources:[{id:"legacy",dataRoot:data}]};expect((await previewLegacyMigration(input)).active_writer_sources).toEqual(["legacy"]);await expect(commitLegacyMigration(input)).rejects.toThrow("Stop legacy writers");expect(await readFile(join(data,"evidence.jsonl"),"utf8")).toBe("original");await rm(join(data,"runtime-owner.json"));await symlink(join(data,"evidence.jsonl"),join(data,"alias"));await expect(previewLegacyMigration(input)).rejects.toThrow("symbolic links");}finally{await rm(root,{recursive:true,force:true});}
 });
 it("keeps custom roots and backup bytes while adopting Desktop credential-reference syntax",async()=>{
  const root=await mkdtemp(join(tmpdir(),"outlive-model-migrate-"));try{
   const profileRoot=join(root,"profile"),dataRoot=join(root,"shared-data"),sessionRoot=join(root,"shared-sessions"),source=join(root,"desktop");await mkdir(source,{mode:0o700});
   const {PrivateFileCredentialStore,createSecretReference}=await import("@tracegraph/core");const {readPersistedModelConfig}=await import("./composition/model-config.js");
   const store=new PrivateFileCredentialStore(join(source,"credentials.json"));await store.set("TRACEGRAPH_DESKTOP_TEST_KEY","isolated-import-key");const desktop={provider:"custom",protocol:"openai-chat-completions",base_url:"http://127.0.0.1:12345/v1",model:"migrated-model",credential_ref:createSecretReference("TRACEGRAPH_DESKTOP_TEST_KEY")};const original=JSON.stringify(desktop);await writeFile(join(source,"model-config.json"),original);
   await mkdir(join(source,"sessions"),{recursive:true});await writeFile(join(source,"sessions","proof.jsonl"),"retained session evidence");await initializeLocalProfile({profileRoot,dataRoot,sessionRoot});
   const receipt=await commitLegacyMigration({profileRoot,sources:[{id:"desktop",dataRoot:source}]});expect(await readFile(join(receipt.backup_root,"sources","desktop","data","model-config.json"),"utf8")).toBe(original);expect(await readFile(join(source,"model-config.json"),"utf8")).toBe(original);
   const importedStore=new PrivateFileCredentialStore(join(profileRoot,"credentials.json"));const loaded=await readPersistedModelConfig(join(dataRoot,"model-config.json"),importedStore);expect(loaded).toMatchObject({hasKey:true,config:{baseUrl:desktop.base_url,model:desktop.model,credentialRef:desktop.credential_ref}});expect(await importedStore.get("TRACEGRAPH_DESKTOP_TEST_KEY")).toBe("isolated-import-key");expect(await readFile(join(sessionRoot,"proof.jsonl"),"utf8")).toBe("retained session evidence");
   const manifest=JSON.parse(await readFile(join(profileRoot,"profile.json"),"utf8")) as {data_root:string;session_root:string};expect(manifest).toMatchObject({data_root:await (await import("node:fs/promises")).realpath(dataRoot),session_root:await (await import("node:fs/promises")).realpath(sessionRoot)});
  }finally{await rm(root,{recursive:true,force:true});}
 });

});
