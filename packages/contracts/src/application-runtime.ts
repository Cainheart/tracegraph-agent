import {z} from "zod";
import {IdentifierSchema} from "./common.js";
/** Read-only native notification navigation; it conveys no execution authority. */
export const NativeRunNavigationSchema=z.object({event_id:IdentifierSchema,run_id:IdentifierSchema,project_id:IdentifierSchema,session_id:IdentifierSchema.optional(),connection_generation:z.number().int().nonnegative()}).strict();
export type NativeRunNavigation=z.infer<typeof NativeRunNavigationSchema>;
