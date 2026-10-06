import {z} from "zod";
import {IdentifierSchema,IsoDateTimeSchema} from "./common.js";
import {SessionRunOptionsOverrideSchema,SessionRunOptionsSchema,ResolvedRunOptionFieldSchema} from "./conversation-options.js";
import {WorkbenchSettingsValuesSchema,WorkbenchSettingsSnapshotSchema} from "./local-workbench.js";

export const ProjectRunDefaultsSnapshotSchema=z.object({project_id:IdentifierSchema,revision:z.number().int().nonnegative(),overrides:SessionRunOptionsOverrideSchema,options:SessionRunOptionsSchema,fields:z.array(ResolvedRunOptionFieldSchema).max(5)}).strict();
export type ProjectRunDefaultsSnapshot=z.infer<typeof ProjectRunDefaultsSnapshotSchema>;
/** Replace explicit overrides; an empty object restores inheritance. */
export const ProjectRunDefaultsUpdateRequestSchema=z.object({command_id:IdentifierSchema,expected_revision:z.number().int().nonnegative(),overrides:SessionRunOptionsOverrideSchema}).strict();
export type ProjectRunDefaultsUpdateRequest=z.infer<typeof ProjectRunDefaultsUpdateRequestSchema>;
export const WorkbenchSettingsHistoryEntrySchema=z.object({revision:z.number().int().nonnegative(),command_id:IdentifierSchema,operation:z.enum(["checkpoint","update","restore"]),occurred_at:IsoDateTimeSchema,restored_from_revision:z.number().int().nonnegative().optional(),settings:z.record(z.string(),z.unknown()).refine(value=>JSON.stringify(value).length<=1_048_576,"History snapshot exceeds byte limit"),redacted_paths:z.array(z.string().min(1).max(512)).max(8192)}).strict();
export type WorkbenchSettingsHistoryEntry=z.infer<typeof WorkbenchSettingsHistoryEntrySchema>;
export const WorkbenchSettingsHistorySchema=z.object({profile_id:IdentifierSchema,current_revision:z.number().int().nonnegative(),entries:z.array(WorkbenchSettingsHistoryEntrySchema).max(200),has_more:z.boolean()}).strict();
export type WorkbenchSettingsHistory=z.infer<typeof WorkbenchSettingsHistorySchema>;
export const RestoreWorkbenchSettingsRequestSchema=z.object({command_id:IdentifierSchema,expected_revision:z.number().int().nonnegative(),target_revision:z.number().int().nonnegative()}).strict();
export type RestoreWorkbenchSettingsRequest=z.infer<typeof RestoreWorkbenchSettingsRequestSchema>;
export const RestoreWorkbenchSettingsResultSchema=z.object({snapshot:WorkbenchSettingsSnapshotSchema,restored_from_revision:z.number().int().nonnegative(),preserved_sections:z.array(z.enum(["general","appearance","model","memory","developer","tools","telemetry"])).max(7)}).strict();
export type RestoreWorkbenchSettingsResult=z.infer<typeof RestoreWorkbenchSettingsResultSchema>;
