import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema } from "./common.js";

/** A bounded mailbox prevents an unreachable or paused Run from accepting an
 * unbounded amount of durable user input. */
export const MAX_PENDING_USER_INPUTS = 100;
export const MAX_USER_INPUT_BODY_CHARS = 8_000;
export const MAX_USER_INPUT_STEP = 1_000_000;

export const UserInputKindSchema = z.enum(["message", "cancel", "approve_hint"]);
export type UserInputKind = z.infer<typeof UserInputKindSchema>;

/** Browser routes always bind `user`; `parent_agent` is an internal child-Run sender. */
export const UserInputActorSchema = z.enum(["user", "parent_agent"]);
export type UserInputActor = z.infer<typeof UserInputActorSchema>;

const UserInputBodySchema = z.string().max(MAX_USER_INPUT_BODY_CHARS);

const SubmittedUserInputShape = {
  input_id: IdentifierSchema,
  run_id: IdentifierSchema,
  kind: UserInputKindSchema,
  body: UserInputBodySchema,
  actor: UserInputActorSchema,
  submitted_at: IsoDateTimeSchema,
};

function requireMessageBody(
  value: { kind: UserInputKind; body: string },
  context: z.RefinementCtx,
): void {
  if (value.kind !== "cancel" && value.body.trim().length === 0) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: `${value.kind} input body must not be empty`,
    });
  }
}

/** Durable, unconsumed mailbox item. Scope, actor and timestamps are supplied
 * by trusted Host/Core code, never by a browser request. */
export const PendingUserInputSchema = z.object(SubmittedUserInputShape)
  .strict()
  .superRefine(requireMessageBody);
export type PendingUserInput = z.infer<typeof PendingUserInputSchema>;

/** Canonical input state. Consumption fields are an atomic pair. */
export const UserInputSchema = z.object({
  ...SubmittedUserInputShape,
  consumed_at: IsoDateTimeSchema.optional(),
  consumed_at_step: z.number().int().positive().max(MAX_USER_INPUT_STEP).optional(),
}).strict().superRefine((value, context) => {
  requireMessageBody(value, context);
  if ((value.consumed_at === undefined) !== (value.consumed_at_step === undefined)) {
    context.addIssue({
      code: "custom",
      path: value.consumed_at === undefined ? ["consumed_at"] : ["consumed_at_step"],
      message: "consumed_at and consumed_at_step must be present together",
    });
  }
});
export type UserInput = z.infer<typeof UserInputSchema>;

/** Browser -> Host body. The route owns project/run scope and the Host owns
 * actor/timestamps, so none of those authority-bearing fields are accepted. */
export const SubmitUserInputRequestSchema = z.object({
  command_id: IdentifierSchema,
  input_id: IdentifierSchema,
  kind: UserInputKindSchema,
  body: UserInputBodySchema,
}).strict().superRefine(requireMessageBody);
export type SubmitUserInputRequest = z.infer<typeof SubmitUserInputRequestSchema>;

/** Host -> Core command after binding route scope. */
export const SubmitUserInputCommandSchema = z.object({
  type: z.literal("submit_user_input"),
  command_id: IdentifierSchema,
  input_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  kind: UserInputKindSchema,
  body: UserInputBodySchema,
  actor: UserInputActorSchema,
}).strict().superRefine(requireMessageBody);
export type SubmitUserInputCommand = z.infer<typeof SubmitUserInputCommandSchema>;

/** A duplicate is a successful idempotent replay of the canonical input. */
export const SubmitUserInputResultSchema = z.object({
  input: UserInputSchema,
  disposition: z.enum(["queued", "duplicate"]),
}).strict().superRefine((value, context) => {
  if (value.disposition === "queued" && value.input.consumed_at !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["input", "consumed_at"],
      message: "a newly queued input cannot already be consumed",
    });
  }
});
export type SubmitUserInputResult = z.infer<typeof SubmitUserInputResultSchema>;

export const UserInputQueuedDataSchema = z.object({
  input: PendingUserInputSchema,
  // Runtime writes this for command-id collision detection after restart. It
  // remains optional so partially rolled-out/local development ledgers replay.
  // The public wire projector removes every top-level `_internal_*` key.
  _internal_command_digest: Sha256Schema.optional(),
  _internal_input_digest: Sha256Schema.optional(),
}).strict();
export type UserInputQueuedData = z.infer<typeof UserInputQueuedDataSchema>;

export const UserInputConsumedDataSchema = z.object({
  input_id: IdentifierSchema,
  kind: UserInputKindSchema,
  consumed_at: IsoDateTimeSchema,
  at_step: z.number().int().positive().max(MAX_USER_INPUT_STEP),
  queued_event_id: IdentifierSchema,
}).strict();
export type UserInputConsumedData = z.infer<typeof UserInputConsumedDataSchema>;

export const ConsumedUserInputFactSchema = UserInputConsumedDataSchema;
export type ConsumedUserInputFact = z.infer<typeof ConsumedUserInputFactSchema>;

/** Public derived mailbox state. Older ledgers project to the empty default. */
export const InputQueueProjectionSchema = z.object({
  pending: z.array(PendingUserInputSchema).max(MAX_PENDING_USER_INPUTS),
  last_consumed: ConsumedUserInputFactSchema.optional(),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, input] of value.pending.entries()) {
    if (ids.has(input.input_id)) {
      context.addIssue({
        code: "custom",
        path: ["pending", index, "input_id"],
        message: "pending input_id values must be unique",
      });
    }
    ids.add(input.input_id);
  }
  if (value.last_consumed !== undefined && ids.has(value.last_consumed.input_id)) {
    context.addIssue({
      code: "custom",
      path: ["last_consumed", "input_id"],
      message: "last consumed input cannot remain pending",
    });
  }
});
export type InputQueueProjection = z.infer<typeof InputQueueProjectionSchema>;
