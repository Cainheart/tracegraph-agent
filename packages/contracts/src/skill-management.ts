import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "./common.js";
import { SkillNameSchema, SkillCatalogEntrySchema } from "./skill.js";

export const MAX_MANAGED_SKILL_BYTES = 256 * 1024;
export const ManagedSkillScopeSchema = z.discriminatedUnion("kind", [z.object({kind:z.literal("global")}).strict(),z.object({kind:z.literal("project"),project_id:IdentifierSchema}).strict()]);
export type ManagedSkillScope = z.infer<typeof ManagedSkillScopeSchema>;
export const ManagedSkillSelectorSchema = z.object({scope:ManagedSkillScopeSchema,name:SkillNameSchema}).strict();
export type ManagedSkillSelector = z.infer<typeof ManagedSkillSelectorSchema>;
export const ManagedSkillEntrySchema = z.object({name:SkillNameSchema,sha256:Sha256Schema,byte_length:z.number().int().nonnegative().max(MAX_MANAGED_SKILL_BYTES),enabled:z.boolean(),removed:z.boolean(),catalog:SkillCatalogEntrySchema.optional(),diagnostics:z.array(z.string().max(500)).max(16)}).strict();
export type ManagedSkillEntry = z.infer<typeof ManagedSkillEntrySchema>;
export const ManagedSkillsSnapshotSchema = z.object({scope:ManagedSkillScopeSchema,state_sha256:Sha256Schema,state_revision:z.number().int().nonnegative(),entries:z.array(ManagedSkillEntrySchema).max(256),conflicts:z.array(z.object({name:SkillNameSchema,winner:z.enum(["project","user"]),loser:z.enum(["project","user"]),reason:z.string().max(240)}).strict()).max(256),diagnostics:z.array(z.string().max(500)).max(512),effective:z.literal("new-run"),legacy_disabled_names:z.array(SkillNameSchema).max(256)}).strict();
export type ManagedSkillsSnapshot = z.infer<typeof ManagedSkillsSnapshotSchema>;
export const ManagedSkillDocumentSchema = ManagedSkillEntrySchema.extend({scope:ManagedSkillScopeSchema,content:z.string().max(MAX_MANAGED_SKILL_BYTES)}).strict();
export type ManagedSkillDocument = z.infer<typeof ManagedSkillDocumentSchema>;
export const ValidateManagedSkillRequestSchema = z.object({name:SkillNameSchema,content:z.string().max(MAX_MANAGED_SKILL_BYTES)}).strict();
export type ValidateManagedSkillRequest = z.infer<typeof ValidateManagedSkillRequestSchema>;
export const ManagedSkillValidationSchema = z.object({valid:z.boolean(),sha256:Sha256Schema,catalog:SkillCatalogEntrySchema.optional(),diagnostics:z.array(z.string().max(500)).max(16)}).strict();
export type ManagedSkillValidation = z.infer<typeof ManagedSkillValidationSchema>;
const Base={command_id:IdentifierSchema,scope:ManagedSkillScopeSchema,name:SkillNameSchema,expected_sha256:Sha256Schema.nullable(),approval:z.object({approval_id:IdentifierSchema,decision:z.enum(["approve","deny"])}).strict().optional()};
export const ManagedSkillCommandSchema=z.discriminatedUnion("type",[
 z.object({...Base,type:z.enum(["create","save","import"]),content:z.string().max(MAX_MANAGED_SKILL_BYTES)}).strict(),
 z.object({...Base,type:z.enum(["remove","restore"]),expected_state_sha256:Sha256Schema}).strict(),
 z.object({...Base,type:z.literal("set-enabled"),enabled:z.boolean(),expected_state_sha256:Sha256Schema}).strict(),
]);
export type ManagedSkillCommand = z.infer<typeof ManagedSkillCommandSchema>;
export const ManagedSkillCommandResultSchema=z.object({command_id:IdentifierSchema,scope:ManagedSkillScopeSchema,name:SkillNameSchema,status:z.enum(["succeeded","awaiting_approval","denied","conflict","failed","unknown"]),code:z.string().max(128),sha256:Sha256Schema.nullable(),state_sha256:Sha256Schema.optional(),approval_id:IdentifierSchema.optional(),receipt_event_id:IdentifierSchema.optional(),effective:z.literal("new-run")}).strict();
export type ManagedSkillCommandResult=z.infer<typeof ManagedSkillCommandResultSchema>;
export const ManagedSkillCommandReceiptSchema=z.object({command_id:IdentifierSchema,state:z.enum(["not_found","unknown","failed","completed"]),result:ManagedSkillCommandResultSchema.optional(),observed_sha256:Sha256Schema.nullable().optional(),code:z.string().max(128).optional()}).strict();
export type ManagedSkillCommandReceipt=z.infer<typeof ManagedSkillCommandReceiptSchema>;
