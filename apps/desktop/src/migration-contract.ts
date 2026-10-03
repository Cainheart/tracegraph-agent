import { MigrationCommitReceiptSchema } from "@tracegraph/contracts";
import { z } from "zod";

/** Client-local query authority is Main's pending operation, never a renderer path or ID. */
export const DesktopMigrationOutcomeSchema = z.object({
  state: z.enum(["queued", "failed", "succeeded"]),
  operation_id: z.string().regex(/^[A-Za-z0-9:._-]{1,256}$/u),
  receipt: MigrationCommitReceiptSchema.optional(),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/u).optional(),
  message: z.string().max(1000).optional(),
}).strict();
export type DesktopMigrationOutcome = z.infer<typeof DesktopMigrationOutcomeSchema>;
