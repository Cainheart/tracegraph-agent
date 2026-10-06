import {z} from "zod";
import {IdentifierSchema} from "./common.js";
import {ModelConfigUpdateRequestSchema, PublicModelConfigResponseSchema} from "./credentials.js";
import {ModelConnectionTestResultSchema} from "./local-workbench.js";
import {ModelCapabilityTestResultSchema} from "./model-capability-tests.js";
const CatalogEffortSchema=z.enum(["none","low","medium","high","xhigh","max"]);
const CatalogModalitySchema=z.enum(["text","image","audio","video"]);
export const ModelCatalogEntrySchema=z.object({id:z.string().trim().min(1).max(200),name:z.string().trim().min(1).max(200).optional(),capability_status:z.enum(["confirmed","partial","unknown"]),source:z.enum(["provider_response","official_catalog","model_id_only"]),context_window_tokens:z.number().int().positive().max(2_000_000).optional(),max_output_tokens:z.number().int().positive().max(1_000_000).optional(),input_modalities:z.array(CatalogModalitySchema).max(4).optional(),output_modalities:z.array(CatalogModalitySchema).max(4).optional(),reasoning_efforts:z.array(CatalogEffortSchema).max(6).optional(),reasoning_default:CatalogEffortSchema.optional()}).strict().superRefine((value,context)=>{if(value.reasoning_default&&value.reasoning_efforts&&!value.reasoning_efforts.includes(value.reasoning_default)){context.addIssue({code:"custom",path:["reasoning_default"],message:"default reasoning must be supported by this model"});}});
export type ModelCatalogEntry=z.infer<typeof ModelCatalogEntrySchema>;

/**
 * DeepSeek's live model catalog uses canonical IDs while existing profiles may
 * still select documented compatibility aliases. Reuse the live catalog facts
 * only for aliases confirmed by DeepSeek and only against its official API.
 */
const OFFICIAL_DEEPSEEK_MODEL_ALIASES:Readonly<Record<string,string>>={"deepseek-v4-flash":"deepseek-flash"};
export function resolveModelCatalogEntry(model:string,catalog:readonly ModelCatalogEntry[]|undefined,provider:string,baseUrl:string):ModelCatalogEntry|undefined{
 if(!catalog?.length)return undefined;
 const exact=catalog.find(item=>item.id===model);if(exact)return exact;
 if(provider!=="deepseek")return undefined;
 let url:URL;try{url=new URL(baseUrl);}catch{return undefined;}
 if(url.protocol!=="https:"||url.hostname!=="api.deepseek.com")return undefined;
 const canonical=OFFICIAL_DEEPSEEK_MODEL_ALIASES[model];return canonical?catalog.find(item=>item.id===canonical):undefined;
}

export const ModelCatalogDiscoveryRequestSchema=z.object({command_id:IdentifierSchema,expected_revision:z.number().int().nonnegative()}).strict();
export type ModelCatalogDiscoveryRequest=z.infer<typeof ModelCatalogDiscoveryRequestSchema>;
export const ModelCatalogDiscoveryResultSchema=z.object({connection_id:IdentifierSchema,connection_revision:z.number().int().nonnegative(),status:z.enum(["succeeded","failed"]),discovered_at:z.string().datetime({offset:true}),models:z.array(ModelCatalogEntrySchema).max(1000),error_code:z.string().max(100).optional(),message:z.string().max(500).optional()}).strict();
export type ModelCatalogDiscoveryResult=z.infer<typeof ModelCatalogDiscoveryResultSchema>;
export const SessionRunOptionsSchema=z.object({connection_id:IdentifierSchema.optional(),model:z.string().trim().min(1).max(200).optional(),reasoning_effort:z.enum(["default","low","medium","high","xhigh","max"]).default("default"),mode:z.enum(["plan","execute"]).default("execute"),permission_preset:z.enum(["read-only","workspace-write","full-write"]).default("workspace-write")}).strict();
export type SessionRunOptions=z.infer<typeof SessionRunOptionsSchema>;
export const SessionRunOptionsOverrideSchema=z.object({...SessionRunOptionsSchema.shape,reasoning_effort:SessionRunOptionsSchema.shape.reasoning_effort.unwrap().optional(),mode:SessionRunOptionsSchema.shape.mode.unwrap().optional(),permission_preset:SessionRunOptionsSchema.shape.permission_preset.unwrap().optional()}).partial().strict();
export type SessionRunOptionsOverride=z.infer<typeof SessionRunOptionsOverrideSchema>;
export const RunOptionFieldSchema=z.enum(["connection_id","model","reasoning_effort","mode","permission_preset"]);
export const ResolvedRunOptionFieldSchema=z.object({path:RunOptionFieldSchema,source:z.enum(["default","profile","project","session","request"]),effective:z.literal("new-run")}).strict();
export const SessionRunOptionsSnapshotSchema=z.object({session_id:IdentifierSchema,revision:z.number().int().nonnegative(),options:SessionRunOptionsSchema,overrides:SessionRunOptionsOverrideSchema.optional(),fields:z.array(ResolvedRunOptionFieldSchema).max(5).optional()}).strict();
export type SessionRunOptionsSnapshot=z.infer<typeof SessionRunOptionsSnapshotSchema>;
export const SessionRunOptionsUpdateRequestSchema=z.object({command_id:IdentifierSchema,expected_revision:z.number().int().nonnegative(),options:SessionRunOptionsSchema.optional(),overrides:SessionRunOptionsOverrideSchema.optional()}).strict().refine(value=>(value.options===undefined)!==(value.overrides===undefined),{message:"Provide exactly one options or overrides"});
export type SessionRunOptionsUpdateRequest=z.infer<typeof SessionRunOptionsUpdateRequestSchema>;
export const SessionRunOptionsResetRequestSchema=z.object({command_id:IdentifierSchema,expected_revision:z.number().int().nonnegative(),fields:z.array(RunOptionFieldSchema).min(1).max(5).optional()}).strict();
export type SessionRunOptionsResetRequest=z.infer<typeof SessionRunOptionsResetRequestSchema>;
export const ModelConnectionSchema=z.object({connection_id:IdentifierSchema,label:z.string().trim().min(1).max(200),revision:z.number().int().nonnegative(),provider:PublicModelConfigResponseSchema.shape.provider,protocol:PublicModelConfigResponseSchema.shape.protocol,base_url:z.url().max(500),model:z.string().min(1).max(200),models:z.array(z.string().trim().min(1).max(200)).min(1).max(100),image_input_models:z.array(z.string().trim().min(1).max(200)).max(100).optional(),model_catalog:z.array(ModelCatalogEntrySchema).max(1000).optional(),model_catalog_status:z.enum(["succeeded","failed"]).optional(),model_catalog_checked_at:z.string().datetime({offset:true}).optional(),model_catalog_error_code:z.string().max(100).optional(),reasoning_by_model:z.record(z.string(),z.array(z.enum(["default","low","medium","high","xhigh","max"]))).optional(),has_key:z.boolean(),credential:PublicModelConfigResponseSchema.shape.credential,source:z.enum(["profile","environment"]),writable:z.boolean(),test:ModelConnectionTestResultSchema.optional(),capability_test:ModelCapabilityTestResultSchema.optional()}).strict();
export type ModelConnection=z.infer<typeof ModelConnectionSchema>;
export const ModelConnectionsSnapshotSchema=z.object({connections:z.array(ModelConnectionSchema).max(100),default_connection_id:IdentifierSchema.nullable()}).strict();
export type ModelConnectionsSnapshot=z.infer<typeof ModelConnectionsSnapshotSchema>;
export const ModelConnectionSaveRequestSchema=ModelConfigUpdateRequestSchema.extend({command_id:IdentifierSchema,connection_id:IdentifierSchema.optional(),expected_revision:z.number().int().nonnegative().optional(),label:z.string().trim().min(1).max(200),clear_key:z.boolean().optional(),image_input_models:z.array(z.string().trim().min(1).max(200)).max(100).optional(),models:z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional()}).strict();
export type ModelConnectionSaveRequest=z.infer<typeof ModelConnectionSaveRequestSchema>;
export const ModelConnectionRemoveRequestSchema=z.object({command_id:IdentifierSchema,expected_revision:z.number().int().nonnegative()}).strict();
export type ModelConnectionRemoveRequest=z.infer<typeof ModelConnectionRemoveRequestSchema>;
export const PermissionGrantSchema=z.object({enabled:z.boolean(),can_grant:z.boolean(),ceiling:z.enum(["read-only","workspace-write","full-write"]),source:z.string().max(100),pending_restart:z.boolean()}).strict();
export type PermissionGrant=z.infer<typeof PermissionGrantSchema>;
export const PermissionGrantUpdateRequestSchema=z.object({command_id:IdentifierSchema,enabled:z.boolean(),confirmed:z.literal(true)}).strict();
export type PermissionGrantUpdateRequest=z.infer<typeof PermissionGrantUpdateRequestSchema>;
