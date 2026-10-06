import {describe,expect,it} from "vitest";
import {SubagentWorkspaceBindingSchema} from "./subagent-workspace.js";
const binding={binding_id:"child:fixture",baseline_digest:`sha256:${"a".repeat(64)}`,source_head:"b".repeat(40),source_index_hash:`sha256:${"c".repeat(64)}`,source_tree_hash:`sha256:${"d".repeat(64)}`};
describe("Closed child workspace provenance",()=>{
 it("keeps only opaque identity and verified-source digests",()=>{expect(SubagentWorkspaceBindingSchema.parse(binding)).toEqual(binding);});
 it.each([{root:"/tmp/arbitrary-model-root"},{permission:{sandbox_mode:"danger-full-access"}},{credentials:"model-secret"}])("rejects paths, authority and credentials in public bindings",extra=>{expect(SubagentWorkspaceBindingSchema.safeParse({...binding,...extra}).success).toBe(false);});
 it("rejects corrupt source digests",()=>{expect(SubagentWorkspaceBindingSchema.safeParse({...binding,source_index_hash:"not-a-hash"}).success).toBe(false);});
});
