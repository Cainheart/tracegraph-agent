import {z} from "zod";
import {ArtifactRefSchema,IdentifierSchema,IsoDateTimeSchema,Sha256Schema} from "./common.js";

export const ComputerApplicationSchema=z.object({application_id:IdentifierSchema,pid:z.number().int().positive(),title:z.string().max(300),identity:Sha256Schema}).strict();
export type ComputerApplication=z.infer<typeof ComputerApplicationSchema>;
export const ComputerTargetSchema=ComputerApplicationSchema.extend({window_id:IdentifierSchema}).strict();
export type ComputerTarget=z.infer<typeof ComputerTargetSchema>;
export const ComputerNativeStatusSchema=z.object({platform:z.enum(["darwin","win32","unsupported"]),backend_available:z.boolean(),accessibility:z.boolean(),screen_capture:z.boolean(),input_monitoring:z.boolean(),locked:z.boolean(),reason:z.string().max(1000).optional()}).strict();
export type ComputerNativeStatus=z.infer<typeof ComputerNativeStatusSchema>;
export const ComputerGrantSchema=z.object({grant_id:IdentifierSchema,application_id:IdentifierSchema,identity:Sha256Schema,duration:z.enum(["once","always"]),state:z.enum(["active","revoked"]),granted_at:IsoDateTimeSchema,revoked_at:IsoDateTimeSchema.optional()}).strict();
export type ComputerGrant=z.infer<typeof ComputerGrantSchema>;
export const ComputerPauseReasonSchema=z.enum(["user-input","locked","target-changed","monitor-unavailable","revoked","expired","owner-restarted","run-cancelled"]);
export const ComputerLeaseSchema=z.object({lease_id:IdentifierSchema,grant_id:IdentifierSchema,target:ComputerTargetSchema,state:z.enum(["active","paused","released"]),generation:z.number().int().nonnegative(),created_at:IsoDateTimeSchema,expires_at:IsoDateTimeSchema,pause_reason:ComputerPauseReasonSchema.optional()}).strict();
export type ComputerLease=z.infer<typeof ComputerLeaseSchema>;
export const ComputerStatusSchema=ComputerNativeStatusSchema.extend({grants:z.array(ComputerGrantSchema).max(128),lease:ComputerLeaseSchema.nullable(),human_grant_available:z.boolean()}).strict();
export type ComputerStatus=z.infer<typeof ComputerStatusSchema>;
export const ComputerGrantRequestSchema=z.object({command_id:IdentifierSchema,target:ComputerTargetSchema,duration:z.enum(["once","always"])}).strict();
export type ComputerGrantRequest=z.infer<typeof ComputerGrantRequestSchema>;
export const ComputerRevokeGrantRequestSchema=z.object({command_id:IdentifierSchema,grant_id:IdentifierSchema}).strict();
export type ComputerRevokeGrantRequest=z.infer<typeof ComputerRevokeGrantRequestSchema>;
export const ComputerLeaseRequestSchema=z.object({command_id:IdentifierSchema,grant_id:IdentifierSchema,target:ComputerTargetSchema,seconds:z.number().int().min(15).max(600).default(300)}).strict();
export type ComputerLeaseRequest=z.infer<typeof ComputerLeaseRequestSchema>;
export const ComputerLeaseResumeRequestSchema=z.object({command_id:IdentifierSchema,lease_id:IdentifierSchema,expected_generation:z.number().int().nonnegative()}).strict();
export type ComputerLeaseResumeRequest=z.infer<typeof ComputerLeaseResumeRequestSchema>;
export const ComputerLeaseReleaseRequestSchema=z.object({command_id:IdentifierSchema,lease_id:IdentifierSchema}).strict();
export type ComputerLeaseReleaseRequest=z.infer<typeof ComputerLeaseReleaseRequestSchema>;
export const ComputerActionSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("click"),x:z.number().finite(),y:z.number().finite(),button:z.enum(["left","right"]).default("left")}).strict(),
 z.object({kind:z.literal("type"),text:z.string().min(1).max(4000)}).strict(),
 z.object({kind:z.literal("key"),key:z.enum(["Enter","Escape","Tab","Backspace","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"]),modifiers:z.array(z.enum(["shift","control","alt","meta"])).max(4).default([])}).strict(),
 z.object({kind:z.literal("scroll"),delta_x:z.number().int().min(-2000).max(2000),delta_y:z.number().int().min(-2000).max(2000)}).strict(),
]);
export type ComputerAction=z.infer<typeof ComputerActionSchema>;
export const ComputerActionRequestSchema=z.object({command_id:IdentifierSchema,lease_id:IdentifierSchema,expected_generation:z.number().int().nonnegative(),action:ComputerActionSchema}).strict();
export type ComputerActionRequest=z.infer<typeof ComputerActionRequestSchema>;
export const ComputerObserveRequestSchema=z.object({command_id:IdentifierSchema,grant_id:IdentifierSchema,target:ComputerTargetSchema,capture:z.boolean().default(false)}).strict();
export type ComputerObserveRequest=z.infer<typeof ComputerObserveRequestSchema>;
export const ComputerElementSchema=z.object({element_id:IdentifierSchema,role:z.string().max(100),title:z.string().max(512).optional(),value:z.string().max(1024).optional(),bounds:z.object({x:z.number(),y:z.number(),width:z.number().nonnegative(),height:z.number().nonnegative()}).strict().optional(),enabled:z.boolean().optional()}).strict();
export type ComputerElement=z.infer<typeof ComputerElementSchema>;
export const ComputerObservationSchema=z.object({target:ComputerTargetSchema,source:z.literal("native-accessibility"),elements:z.array(ComputerElementSchema).max(256),truncated:z.boolean(),captured_at:IsoDateTimeSchema,artifact:ArtifactRefSchema,capture_artifact:ArtifactRefSchema.optional()}).strict();
export type ComputerObservation=z.infer<typeof ComputerObservationSchema>;
export const ComputerCaptureContentRequestSchema=z.object({grant_id:IdentifierSchema,target:ComputerTargetSchema,artifact:ArtifactRefSchema}).strict();
export type ComputerCaptureContentRequest=z.infer<typeof ComputerCaptureContentRequestSchema>;
export const ComputerActionResultSchema=z.object({command_id:IdentifierSchema,status:z.enum(["posted","unknown"]),code:IdentifierSchema,target:ComputerTargetSchema,lease_generation:z.number().int().nonnegative(),message:z.string().max(1000)}).strict();
export type ComputerActionResult=z.infer<typeof ComputerActionResultSchema>;
export const ComputerCommandReceiptSchema=z.object({command_id:IdentifierSchema,state:z.enum(["not_found","unknown","failed","completed"]),code:z.string().max(160).optional(),result:z.union([ComputerGrantSchema,ComputerLeaseSchema,ComputerObservationSchema,ComputerActionResultSchema]).optional()}).strict();
export type ComputerCommandReceipt=z.infer<typeof ComputerCommandReceiptSchema>;
