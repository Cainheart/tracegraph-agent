import {z} from "zod";
import {IdentifierSchema,Sha256Schema} from "./common.js";
/** Public provenance identifies a private Host workspace; no path or authority is accepted from the model. */
export const SubagentWorkspaceBindingSchema=z.object({binding_id:IdentifierSchema,baseline_digest:Sha256Schema,source_head:z.string().regex(/^[a-f0-9]{40,64}$/u),source_index_hash:Sha256Schema,source_tree_hash:Sha256Schema}).strict();
export type SubagentWorkspaceBinding=z.infer<typeof SubagentWorkspaceBindingSchema>;
