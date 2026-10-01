import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema } from "./common.js";
import { ExperienceCaseStatusSchema } from "./experience-case.js";
import { MemoryRunEvidenceRefSchema } from "./memory.js";

export const ExperienceLifecycleActionSchema = z.enum([
  "validate",
  "reject",
  "dispute",
  "resolve",
  "retire",
]);
export type ExperienceLifecycleAction = z.infer<typeof ExperienceLifecycleActionSchema>;

export const EXPERIENCE_LIFECYCLE_TRANSITIONS: Readonly<Record<
  ExperienceLifecycleAction,
  { readonly from: readonly z.infer<typeof ExperienceCaseStatusSchema>[]; readonly to: z.infer<typeof ExperienceCaseStatusSchema> }
>> = Object.freeze({
  validate: { from: ["candidate"], to: "validated" },
  reject: { from: ["candidate"], to: "retired" },
  dispute: { from: ["validated"], to: "disputed" },
  resolve: { from: ["disputed"], to: "validated" },
  retire: { from: ["candidate", "validated", "disputed"], to: "retired" },
});

const lifecycleFields = {
  schemaVersion: z.literal("tracegraph.experience-lifecycle-event.v1"),
  eventType: z.literal("experience.lifecycle.transitioned"),
  ownerId: IdentifierSchema,
  caseId: IdentifierSchema,
  caseVersion: z.number().int().positive(),
  action: ExperienceLifecycleActionSchema,
  fromStatus: ExperienceCaseStatusSchema,
  toStatus: ExperienceCaseStatusSchema,
  actor: z.object({ type: z.literal("user"), id: IdentifierSchema }).strict(),
  reasonCode: z.enum([
    "review_accepted",
    "review_rejected",
    "user_challenge",
    "resolution_confirmed",
    "user_requested_retirement",
  ]),
  idempotencyKey: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
};

function refineLifecycleIntent(
  value: Pick<z.infer<z.ZodObject<typeof lifecycleFields>>, "action" | "fromStatus" | "toStatus" | "reasonCode">,
  context: z.RefinementCtx,
): void {
  const transition = EXPERIENCE_LIFECYCLE_TRANSITIONS[value.action];
  if (!transition.from.includes(value.fromStatus) || transition.to !== value.toStatus) {
    context.addIssue({ code: "custom", path: ["action"], message: "action does not match the Experience status transition" });
  }
  const reasons: Record<ExperienceLifecycleAction, readonly string[]> = {
    validate: ["review_accepted"],
    reject: ["review_rejected"],
    dispute: ["user_challenge"],
    resolve: ["resolution_confirmed"],
    retire: ["user_requested_retirement"],
  };
  if (!reasons[value.action].includes(value.reasonCode)) {
    context.addIssue({ code: "custom", path: ["reasonCode"], message: "reason code does not match the Experience lifecycle action" });
  }
}

export const ExperienceLifecycleCommandSchema = z.object({
  ownerId: IdentifierSchema,
  caseId: IdentifierSchema,
  caseVersion: z.number().int().positive(),
  expectedSequence: z.number().int().nonnegative(),
  action: ExperienceLifecycleActionSchema,
  actor: lifecycleFields.actor,
  reasonCode: lifecycleFields.reasonCode,
  idempotencyKey: IdentifierSchema,
}).strict();
export type ExperienceLifecycleCommand = z.infer<typeof ExperienceLifecycleCommandSchema>;

export const ExperienceLifecycleEventDraftSchema = z.object({
  ...lifecycleFields,
  expectedSequence: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => refineLifecycleIntent(value, context));
export type ExperienceLifecycleEventDraft = z.infer<typeof ExperienceLifecycleEventDraftSchema>;

export const ExperienceLifecycleEventSchema = z.object({
  ...lifecycleFields,
  eventId: IdentifierSchema,
  sequence: z.number().int().positive(),
  previousEventHash: Sha256Schema.optional(),
  eventHash: Sha256Schema,
}).strict().superRefine((value, context) => refineLifecycleIntent(value, context));
export type ExperienceLifecycleEvent = z.infer<typeof ExperienceLifecycleEventSchema>;

export const ExperienceRetrievalAttributionSchema = z.object({
  rank: z.number().int().positive(),
  hitId: IdentifierSchema,
  caseId: IdentifierSchema,
  caseVersion: z.number().int().positive(),
  contentHash: Sha256Schema,
  score: z.number().finite().nonnegative(),
  sourcePath: z.string().trim().min(1).max(2_048),
  evidenceRefs: z.array(MemoryRunEvidenceRefSchema).min(1).max(128),
  injectedTokens: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.sourcePath !== `experience/${encodeURIComponent(value.caseId)}.md`) {
    context.addIssue({ code: "custom", path: ["sourcePath"], message: "Experience attribution requires the canonical Case path" });
  }
});
export type ExperienceRetrievalAttribution = z.infer<typeof ExperienceRetrievalAttributionSchema>;

export const RetrievedExperienceHitSchema = z.object({
  content: z.string().trim().min(1).max(12_000),
  attribution: ExperienceRetrievalAttributionSchema,
}).strict();
export type RetrievedExperienceHit = z.infer<typeof RetrievedExperienceHitSchema>;
