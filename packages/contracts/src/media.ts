import {z} from "zod";
import {IdentifierSchema,NonEmptyStringSchema} from "./common.js";

export const MAX_GENERATED_IMAGE_BYTES=20*1024*1024;
export const MediaMimeTypeSchema=z.enum(["image/png","image/jpeg","image/webp","image/svg+xml"]);
export type MediaMimeType=z.infer<typeof MediaMimeTypeSchema>;
export const ImageProviderProtocolSchema=z.enum(["openai-images","openai-responses","openai-chat-images"]);
export const ImageProviderConfigUpdateSchema=z.object({
  protocol:ImageProviderProtocolSchema,
  base_url:z.url().max(2000).refine(value=>{const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==="https:"||(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)));},"Use HTTPS or a loopback HTTP endpoint without credentials/query/fragment"),
  model:NonEmptyStringSchema.max(200),image_model:NonEmptyStringSchema.max(200).optional(),
  api_key:z.string().min(8).max(4096).optional(),
}).strict();
export type ImageProviderConfigUpdate=z.infer<typeof ImageProviderConfigUpdateSchema>;
export const ImageProviderConfigSnapshotSchema=ImageProviderConfigUpdateSchema.omit({api_key:true}).extend({configured:z.boolean(),has_key:z.boolean()}).strict();
export type ImageProviderConfigSnapshot=z.infer<typeof ImageProviderConfigSnapshotSchema>;
export const GenerateImageInputSchema=z.object({
  prompt:NonEmptyStringSchema.max(4000),format:z.literal("png").default("png"),
  size:z.enum(["1024x1024","1536x1024","1024x1536"]).default("1024x1024"),
  quality:z.enum(["auto","low","medium","high"]).default("auto"),
}).strict();
export type GenerateImageInput=z.infer<typeof GenerateImageInputSchema>;
const Label=z.string().min(1).max(120).refine(value=>!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value),"Labels must contain valid XML 1.0 characters");
const NodeId=z.string().regex(/^[A-Za-z0-9_-]{1,48}$/u);
export const RenderDiagramInputSchema=z.object({
  title:Label,nodes:z.array(z.object({id:NodeId,label:Label}).strict()).min(1).max(16),
  edges:z.array(z.object({from:NodeId,to:NodeId,label:Label.optional()}).strict()).max(32).default([]),
}).strict().superRefine((value,context)=>{
  const ids=new Set(value.nodes.map(node=>node.id));
  if(ids.size!==value.nodes.length)context.addIssue({code:"custom",message:"Diagram node identifiers must be unique"});
  if(value.edges.some(edge=>!ids.has(edge.from)||!ids.has(edge.to)))context.addIssue({code:"custom",message:"Diagram edges must reference known nodes"});
});
export type RenderDiagramInput=z.infer<typeof RenderDiagramInputSchema>;
export const RenderChartInputSchema=z.object({
  title:Label,chart_type:z.enum(["bar","line"]),labels:z.array(Label).min(1).max(24),
  values:z.array(z.number().finite().min(-1e9).max(1e9)).min(1).max(24),
}).strict().refine(value=>value.labels.length===value.values.length,"Chart labels and values must have equal length");
export type RenderChartInput=z.infer<typeof RenderChartInputSchema>;
export const MediaOperationSchema=z.union([
  GenerateImageInputSchema.extend({kind:z.literal("generate")}),
  RenderDiagramInputSchema.safeExtend({kind:z.literal("diagram")}),
  RenderChartInputSchema.safeExtend({kind:z.literal("chart")}),
]);
export type MediaOperation=z.infer<typeof MediaOperationSchema>;
export const StartMediaRunRequestSchema=z.object({command_id:IdentifierSchema,project_id:IdentifierSchema.optional(),operation:MediaOperationSchema}).strict();
export type StartMediaRunRequest=z.infer<typeof StartMediaRunRequestSchema>;
