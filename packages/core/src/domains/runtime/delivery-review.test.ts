import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {BUILTIN_PERMISSION_PRESETS} from "@tracegraph/contracts";
import {createManagedWorkspaceHandle} from "../../kernel/workspace.js";
import {createEffectivePermissionPolicy} from "../tools/policy-engine.js";
import {readonlyReviewPolicy,snapshotDeliveryPaths} from "./delivery-review.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const full=createEffectivePermissionPolicy({preset:BUILTIN_PERMISSION_PRESETS["full-write"]});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"outlive-review-snapshot-"));roots.push(root);const project=join(root,"project");await mkdir(project);await writeFile(join(project,"value.mjs"),"export const value=1;\n");return{root,project,workspace:await createManagedWorkspaceHandle({projectId:"project:readonly-review",root:project})};}
describe("bounded authorized readonly review evidence",()=>{
 it("retains parent scopes/rules while stripping all mutating tools and sandbox authority",()=>{const policy=readonlyReviewPolicy(full);expect(policy.preset.sandbox_mode).toBe("read-only");expect(policy.preset.path_scope).toEqual(full.preset.path_scope);expect(policy.host_rules).toEqual(full.host_rules);expect(policy.project_rules).toEqual(full.project_rules);expect(policy.preset.allowed_tools).toContain("read_file");expect(policy.preset.allowed_tools).not.toContain("commit_patch");expect(policy.preset.allowed_tools).not.toContain("run_project_command");expect(policy.preset.allowed_tools).not.toContain("team_task_write");});
 it("bounds the fd read even when a real file grows after its size check",async()=>{const f=await fixture();await expect(snapshotDeliveryPaths(f.workspace,full,["value.mjs"],async path=>{await writeFile(path,Buffer.alloc(2*1024*1024,97));})).rejects.toMatchObject({code:"delivery_review_source_changed"});expect((await readFile(join(f.project,"value.mjs"))).length).toBe(2*1024*1024);});
 it("rejects sensitive aliases, escapes and over-limit source without deleting bytes",async()=>{const f=await fixture();await writeFile(join(f.project,".env"),"PRIVATE_SENTINEL");await symlink(join(f.project,".env"),join(f.project,"alias.mjs"));await expect(snapshotDeliveryPaths(f.workspace,full,["alias.mjs"])).rejects.toMatchObject({code:"delivery_review_read_denied"});await expect(snapshotDeliveryPaths(f.workspace,full,["../outside"])).rejects.toBeDefined();await writeFile(join(f.project,"large.mjs"),"a".repeat(65_537));await expect(snapshotDeliveryPaths(f.workspace,full,["large.mjs"])).rejects.toMatchObject({code:"delivery_review_file_limit"});expect(await readFile(join(f.project,".env"),"utf8")).toBe("PRIVATE_SENTINEL");});
});
