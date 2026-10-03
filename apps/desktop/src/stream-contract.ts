import { IdentifierSchema, LivePublicActivitySchema, ModelSurfaceEventSchema, WireSessionEventSchema } from "@tracegraph/contracts";
import { z } from "zod";

export const DesktopStreamOpenSchema = z.object({
  kind: z.enum(["ledger", "activity", "model_surface"]), run_id: IdentifierSchema,
  after: z.number().int().nonnegative().default(0), reconnect: z.boolean().default(true),
  generation:z.number().int().nonnegative().optional(),
}).strict();
export const DesktopStreamIdSchema = z.string().uuid();
export const DesktopStreamPacketSchema = z.discriminatedUnion("state", [
  z.discriminatedUnion("kind", [
    z.object({ state: z.literal("event"), kind: z.literal("ledger"), value: WireSessionEventSchema,generation:z.number().int().nonnegative().optional() }).strict(),
    z.object({ state: z.literal("event"), kind: z.literal("activity"), value: LivePublicActivitySchema,generation:z.number().int().nonnegative().optional() }).strict(),
    z.object({ state: z.literal("event"), kind: z.literal("model_surface"), value: ModelSurfaceEventSchema,generation:z.number().int().nonnegative().optional() }).strict(),
  ]),
  z.object({ state: z.literal("end"),generation:z.number().int().nonnegative().optional() }).strict(),
  z.object({ state: z.literal("error"), message: z.string().min(1).max(500),generation:z.number().int().nonnegative().optional() }).strict(),
]);
export type DesktopStreamPacket = z.infer<typeof DesktopStreamPacketSchema>;
export type DesktopStreamOpenInput = z.input<typeof DesktopStreamOpenSchema>;
