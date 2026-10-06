import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "./common.js";

export const BrowserOriginSchema = z.string().max(2_048).refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin === value; } catch { return false; }
}, "Browser authority must name an exact HTTP(S) origin");
const BrowserUrlSchema = z.url().max(4_096).refine(value => {
  const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Only HTTP(S) browser URLs without credentials are accepted");
export const BrowserGrantSchema = z.object({
  grant_id: IdentifierSchema, revision: z.number().int().nonnegative(), label: z.string().trim().min(1).max(256),
  project_id: IdentifierSchema, origins: z.array(BrowserOriginSchema).min(1).max(32),
  duration: z.enum(["once", "always"]), state: z.enum(["active", "consumed", "revoked"]), created_at: z.iso.datetime(),
}).strict();
export type BrowserGrant = z.infer<typeof BrowserGrantSchema>;
export const BrowserGrantRequestSchema = z.object({ command_id: IdentifierSchema, label: BrowserGrantSchema.shape.label, project_id: IdentifierSchema, origins: BrowserGrantSchema.shape.origins, duration: BrowserGrantSchema.shape.duration }).strict();
export type BrowserGrantRequest = z.infer<typeof BrowserGrantRequestSchema>;
export const BrowserTabSchema = z.object({ tab_id: IdentifierSchema, project_id: IdentifierSchema, grant_id: IdentifierSchema,
  url: z.string().max(4_096), title: z.string().max(512), state: z.enum(["agent", "human", "closed", "interrupted"]), revision: z.number().int().nonnegative(),
}).strict();
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
export const BrowserStatusSchema = z.object({ available: z.boolean(), human_grant_available: z.boolean(), runtime: z.enum(["bundled", "development", "unavailable"]), reason: z.string().max(1_000).optional(), grants: z.array(BrowserGrantSchema).max(128), tabs: z.array(BrowserTabSchema).max(8) }).strict();
export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;
export const BrowserObservationSchema = z.object({ tab: BrowserTabSchema, elements: z.array(z.object({ ref: IdentifierSchema, role: z.string().max(64), text: z.string().max(512), input_type: z.string().max(64).optional() }).strict()).max(200),
  evidence: z.object({ evidence_id: IdentifierSchema, sha256: Sha256Schema, mime_type: z.literal("image/png"), byte_length: z.number().int().positive().max(8 * 1024 * 1024) }).strict(),
}).strict();
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;
const Base = { command_id: IdentifierSchema };
const Target = { ...Base, tab_id: IdentifierSchema, expected_revision: z.number().int().nonnegative() };
export const BrowserCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...Base, type: z.literal("open"), grant_id: IdentifierSchema, url: BrowserUrlSchema }).strict(),
  z.object({ ...Target, type: z.literal("navigate"), url: BrowserUrlSchema }).strict(),
  z.object({ ...Target, type: z.literal("click"), ref: IdentifierSchema }).strict(),
  z.object({ ...Target, type: z.literal("fill"), ref: IdentifierSchema, text: z.string().max(32_768) }).strict(),
  z.object({ ...Target, type: z.literal("key"), key: z.enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }).strict(),
  z.object({ ...Base, type: z.literal("close"), tab_id: IdentifierSchema }).strict(),
  z.object({ ...Base, type: z.literal("takeover"), tab_id: IdentifierSchema }).strict(),
  z.object({ ...Target, type: z.literal("return-control") }).strict(),
  z.object({ ...Base, type: z.literal("revoke"), grant_id: IdentifierSchema, expected_revision: z.number().int().nonnegative() }).strict(),
]);
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export const BrowserCommandResultSchema = z.object({ command_id: IdentifierSchema, status: z.literal("succeeded"), tab: BrowserTabSchema.optional(), grant: BrowserGrantSchema.optional() }).strict();
export type BrowserCommandResult = z.infer<typeof BrowserCommandResultSchema>;
export const BrowserCommandReceiptSchema = z.object({command_id:IdentifierSchema,state:z.enum(["not_found","unknown","failed","completed"]),code:z.string().max(160).optional(),result:BrowserCommandResultSchema.optional()}).strict();
export type BrowserCommandReceipt = z.infer<typeof BrowserCommandReceiptSchema>;
