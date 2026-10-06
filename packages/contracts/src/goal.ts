import {z} from "zod";
import {IdentifierSchema,IsoDateTimeSchema} from "./common.js";
import {SessionRunOptionsOverrideSchema} from "./conversation-options.js";

export const GoalBudgetLimitsSchema=z.object({max_tokens:z.number().int().min(1).max(100_000_000).optional(),max_time_ms:z.number().int().min(100).max(604_800_000).optional()}).strict().refine(value=>value.max_tokens!==undefined||value.max_time_ms!==undefined,"A Goal requires a finite token or time ceiling");
export type GoalBudgetLimits=z.infer<typeof GoalBudgetLimitsSchema>;
export const GoalBudgetSnapshotSchema=z.object({limits:GoalBudgetLimitsSchema,charged_tokens:z.number().int().nonnegative(),held_tokens:z.number().int().nonnegative(),held_request_count:z.number().int().nonnegative().default(0),reported_input_tokens:z.number().int().nonnegative(),reported_output_tokens:z.number().int().nonnegative(),elapsed_ms:z.number().int().nonnegative(),request_count:z.number().int().nonnegative(),unknown_request_count:z.number().int().nonnegative(),stop_reason:z.enum(["token_limit","time_limit","usage_unknown","usage_overrun","paused","cancelled","recovery_required","persistence_failed"]).nullable()}).strict();
export type GoalBudgetSnapshot=z.infer<typeof GoalBudgetSnapshotSchema>;
export const GoalProposalSchema=z.object({project_id:IdentifierSchema,session_id:IdentifierSchema.optional(),title:z.string().trim().min(1).max(200),objective:z.string().trim().min(1).max(8_000),done_conditions:z.array(z.string().trim().min(1).max(500)).min(1).max(20).refine(value=>new Set(value).size===value.length,"Done conditions must be distinct"),budget:GoalBudgetLimitsSchema,run_options:SessionRunOptionsOverrideSchema.optional()}).strict().refine(value=>value.objective.length+value.done_conditions.reduce((sum,condition)=>sum+condition.length,0)<=7_000,"Goal objective and all done conditions must fit the bounded execution context");
export type GoalProposal=z.infer<typeof GoalProposalSchema>;
export const GoalCreateRequestSchema=GoalProposalSchema.safeExtend({command_id:IdentifierSchema}).strict();
export type GoalCreateRequest=z.infer<typeof GoalCreateRequestSchema>;
export const GoalSnapshotSchema=z.object({schema_version:z.literal("outlive.goal.v1"),goal_id:IdentifierSchema,revision:z.number().int().positive(),proposal_revision:z.number().int().positive(),approved_proposal_revision:z.number().int().positive().nullable(),proposal:GoalProposalSchema,execution_session_id:IdentifierSchema.nullable().default(null),status:z.enum(["awaiting_approval","approved","running","paused","blocked","awaiting_final_acceptance","completed","cancelled"]),created_at:IsoDateTimeSchema,updated_at:IsoDateTimeSchema,run_ids:z.array(IdentifierSchema).max(1_000),active_run_id:IdentifierSchema.nullable(),budget:GoalBudgetSnapshotSchema,last_run_status:z.string().max(100).nullable(),final_accepted_at:IsoDateTimeSchema.nullable(),receipt_event_id:IdentifierSchema}).strict();
export type GoalSnapshot=z.infer<typeof GoalSnapshotSchema>;
const CommandBase={command_id:IdentifierSchema,expected_revision:z.number().int().positive()};
export const GoalCommandRequestSchema=z.discriminatedUnion("operation",[
 z.object({...CommandBase,operation:z.literal("approve"),proposal_revision:z.number().int().positive()}).strict(),
 z.object({...CommandBase,operation:z.literal("start")}).strict(),
 z.object({...CommandBase,operation:z.literal("pause")}).strict(),
 z.object({...CommandBase,operation:z.literal("resume"),acknowledge_unknown_usage:z.boolean().optional()}).strict(),
 z.object({...CommandBase,operation:z.literal("accept"),accepted_conditions:z.array(z.string().trim().min(1).max(500)).min(1).max(20),confirmed:z.literal(true)}).strict(),
 z.object({...CommandBase,operation:z.literal("cancel")}).strict(),
 z.object({...CommandBase,operation:z.literal("revise"),proposal:GoalProposalSchema}).strict(),
]);
export type GoalCommandRequest=z.infer<typeof GoalCommandRequestSchema>;
export const GoalListResponseSchema=z.object({goals:z.array(GoalSnapshotSchema).max(1_000)}).strict();
export type GoalListResponse=z.infer<typeof GoalListResponseSchema>;
export const GoalCommandReceiptSchema=z.object({goal_id:IdentifierSchema,command_id:IdentifierSchema,state:z.enum(["not_found","unknown","failed","completed"]),operation:z.enum(["create","approve","start","pause","resume","accept","cancel","revise"]).optional(),code:z.string().regex(/^[a-z][a-z0-9_]{0,100}$/u).optional(),result:GoalSnapshotSchema.optional()}).strict().superRefine((value,ctx)=>{if(value.state==="completed"&&(!value.result||value.result.goal_id!==value.goal_id))ctx.addIssue({code:"custom",message:"Completed receipt must bind the exact Goal snapshot"});if(value.state!=="completed"&&value.result)ctx.addIssue({code:"custom",message:"Unsettled receipt cannot assert a result"});});
export type GoalCommandReceipt=z.infer<typeof GoalCommandReceiptSchema>;
export const GoalCreationReceiptSchema=z.object({command_id:IdentifierSchema,state:z.enum(["not_found","unknown","failed","completed"]),goal_id:IdentifierSchema.optional(),code:z.string().regex(/^[a-z][a-z0-9_]{0,100}$/u).optional(),result:GoalSnapshotSchema.optional()}).strict().superRefine((value,ctx)=>{if(value.state==="completed"&&(!value.result||value.goal_id!==value.result.goal_id))ctx.addIssue({code:"custom",message:"Creation receipt must bind its Goal result"});if(value.state!=="completed"&&(value.result||value.goal_id))ctx.addIssue({code:"custom",message:"Unsettled creation cannot assert a Goal locator"});});
export type GoalCreationReceipt=z.infer<typeof GoalCreationReceiptSchema>;
