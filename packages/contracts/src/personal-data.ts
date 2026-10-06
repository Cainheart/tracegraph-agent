import {z} from "zod";
import {IdentifierSchema,IsoDateTimeSchema,RelativePathSchema} from "./common.js";
import {RunStatusSchema} from "./projection.js";
import {UsageCostSchema} from "./usage.js";

export const PersonalProfileValuesSchema=z.object({display_name:z.string().trim().min(1).max(80),bio:z.string().max(1_000).default(""),avatar_color:z.enum(["slate","blue","green","amber","rose","violet"]).default("slate")}).strict();
export type PersonalProfileValues=z.infer<typeof PersonalProfileValuesSchema>;
export const PersonalProfileSnapshotSchema=z.object({schema_version:z.literal("outlive.personal-profile.v1"),profile_id:IdentifierSchema,revision:z.number().int().nonnegative(),updated_at:IsoDateTimeSchema.nullable(),last_command_id:IdentifierSchema.nullable(),source:z.literal("local"),model_transmission:z.literal(false),values:PersonalProfileValuesSchema}).strict();
export type PersonalProfileSnapshot=z.infer<typeof PersonalProfileSnapshotSchema>;
export const PersonalProfileUpdateRequestSchema=z.object({command_id:IdentifierSchema,expected_revision:z.number().int().nonnegative(),values:PersonalProfileValuesSchema}).strict();
export type PersonalProfileUpdateRequest=z.infer<typeof PersonalProfileUpdateRequestSchema>;
export const PersonalProfileCommandReceiptSchema=z.object({command_id:IdentifierSchema,state:z.enum(["not_found","unknown","failed","completed"]),code:z.string().regex(/^[a-z][a-z0-9_]{0,100}$/u).optional(),result:PersonalProfileSnapshotSchema.optional(),observed_profile:PersonalProfileSnapshotSchema.optional()}).strict().superRefine((value,ctx)=>{if(value.state==="completed"&&!value.result)ctx.addIssue({code:"custom",message:"Completed profile receipt requires its snapshot"});if(value.state!=="completed"&&value.result)ctx.addIssue({code:"custom",message:"Unsettled profile receipt cannot claim success"});if(value.observed_profile&&value.state!=="unknown")ctx.addIssue({code:"custom",message:"Uncertain external state remains distinct from a successful receipt"});});
export type PersonalProfileCommandReceipt=z.infer<typeof PersonalProfileCommandReceiptSchema>;

const Cursor=z.string().uuid();
export const PublicQueryPageSchema=z.object({as_of:IsoDateTimeSchema,complete:z.boolean(),inventory_complete:z.boolean(),scanned_runs:z.number().int().nonnegative().max(100),total_scanned_runs:z.number().int().nonnegative().max(5_000),skipped_runs:z.number().int().nonnegative(),skipped_events:z.number().int().nonnegative(),scan_limit_reached:z.boolean(),next_cursor:Cursor.optional()}).strict();
export type PublicQueryPage=z.infer<typeof PublicQueryPageSchema>;
const Day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value=>{const date=new Date(`${value}T00:00:00.000Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;},"Invalid UTC calendar day");
const UsageRange={from_day:Day,to_day:Day,project_id:IdentifierSchema.optional(),session_id:IdentifierSchema.optional(),cursor:Cursor.optional()};
export const PersonalUsageQuerySchema=z.object(UsageRange).strict().refine(value=>{const elapsed=Date.parse(value.to_day)-Date.parse(value.from_day);return elapsed>=0&&elapsed<366*86_400_000;},"Daily usage range must contain 1..366 UTC days");
export type PersonalUsageQuery=z.infer<typeof PersonalUsageQuerySchema>;
const Count=z.number().int().nonnegative().safe();
export const DailyUsageBucketSchema=z.object({day:Day,run_count:Count,completed_runs:Count,failed_runs:Count,cancelled_runs:Count,interrupted_runs:Count,active_runs:Count,model_call_count:Count,reported_request_count:Count,unreported_model_call_count:Count,input_tokens:Count,output_tokens:Count,cached_input_tokens:Count,reasoning_output_tokens:Count,total_tokens:Count,cost_status:z.enum(["reported","partial","unknown"]),costs:z.array(UsageCostSchema).max(16)}).strict();
export type DailyUsageBucket=z.infer<typeof DailyUsageBucketSchema>;
export const PersonalUsageSnapshotSchema=z.object({schema_version:z.literal("outlive.personal-usage.v1"),source:z.literal("ledger"),timezone:z.literal("UTC"),from_day:Day,to_day:Day,project_count:Count,session_count:Count,totals:DailyUsageBucketSchema.omit({day:true}),days:z.array(DailyUsageBucketSchema).max(366),page:PublicQueryPageSchema}).strict();
export type PersonalUsageSnapshot=z.infer<typeof PersonalUsageSnapshotSchema>;

export const PublicSessionSearchQuerySchema=z.object({q:z.string().trim().min(1).max(200),project_id:IdentifierSchema.optional(),session_id:IdentifierSchema.optional(),from:IsoDateTimeSchema.optional(),to:IsoDateTimeSchema.optional(),status:RunStatusSchema.optional(),archive:z.enum(["active","archived","all"]).default("active"),limit:z.number().int().min(1).max(50).default(20),cursor:Cursor.optional()}).strict().refine(value=>!value.from||!value.to||Date.parse(value.from)<=Date.parse(value.to),"Search end must follow start");
export type PublicSessionSearchQuery=z.infer<typeof PublicSessionSearchQuerySchema>;
export const PublicSessionSearchHitSchema=z.object({project_id:IdentifierSchema,session_id:IdentifierSchema,run_id:IdentifierSchema,turn_id:IdentifierSchema.optional(),event_id:IdentifierSchema,sequence:z.number().int().positive(),source:z.enum(["session-title","project","task","answer","file"]),occurred_at:IsoDateTimeSchema,status:RunStatusSchema,archived:z.boolean(),title:z.string().max(200),excerpt:z.string().max(400),path:RelativePathSchema.optional()}).strict();
export type PublicSessionSearchHit=z.infer<typeof PublicSessionSearchHitSchema>;
export const PublicSessionSearchResultSchema=z.object({schema_version:z.literal("outlive.public-search.v1"),query:z.string().max(200),order:z.literal("inventory-page"),hits:z.array(PublicSessionSearchHitSchema).max(50),page:PublicQueryPageSchema}).strict();
export type PublicSessionSearchResult=z.infer<typeof PublicSessionSearchResultSchema>;
