import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./common.js";

export const CredentialBackendSchema = z.enum([
  "macos_keychain",
  "private_file",
  "environment",
]);
export type CredentialBackend = z.infer<typeof CredentialBackendSchema>;

/**
 * Credential names are identifiers, never secret values. Keeping the grammar
 * environment-variable compatible also makes `${secret:NAME}` references
 * unambiguous across config files and storage backends.
 */
export const CredentialNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u, "credential name must use uppercase letters, digits, and underscores");
export type CredentialName = z.infer<typeof CredentialNameSchema>;

/** A safe, serializable pointer to a secret. Plaintext credentials never parse. */
export const SecretReferenceSchema = z
  .string()
  .max(138)
  .regex(/^\$\{secret:[A-Z][A-Z0-9_]{0,127}\}$/u, "expected a ${secret:NAME} reference");
export type SecretReference = z.infer<typeof SecretReferenceSchema>;

/** Browser-safe credential information. This contract intentionally has no value field. */
export const SafeCredentialMetadataSchema = z.object({
  name: CredentialNameSchema,
  backend: CredentialBackendSchema,
  writable: z.boolean(),
  last_updated_at: IsoDateTimeSchema.optional(),
}).strict();
export type SafeCredentialMetadata = z.infer<typeof SafeCredentialMetadataSchema>;

/** Durable, non-secret outbox entry used until migration audit evidence commits. */
export const CredentialMigrationMarkerSchema = z.object({
  migration_id: z.string().uuid(),
  credential: SafeCredentialMetadataSchema,
  secret_reference: SecretReferenceSchema,
  migrated_at: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  const referencedName = value.secret_reference.slice("${secret:".length, -1);
  if (referencedName !== value.credential.name) {
    context.addIssue({
      code: "custom",
      message: "credential metadata must match the secret reference",
      path: ["credential", "name"],
    });
  }
});
export type CredentialMigrationMarker = z.infer<typeof CredentialMigrationMarkerSchema>;

export const ModelProviderSchema = z.enum([
  "openai",
  "deepseek",
  "glm",
  "qwen",
  "minimax",
  "anthropic",
  "custom",
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelProtocolSchema = z.enum([
  "openai-chat-completions",
  "anthropic-messages",
]);
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>;

/** Host -> browser. Unknown keys are rejected so an api_key cannot be accidentally exposed. */
export const PublicModelConfigResponseSchema = z.object({
  provider: ModelProviderSchema,
  protocol: ModelProtocolSchema,
  configured: z.boolean(),
  base_url: z.string().url().max(500),
  model: NonEmptyStringSchema.max(200),
  has_key: z.boolean(),
  credential: SafeCredentialMetadataSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.has_key !== (value.credential !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "credential metadata must be present exactly when has_key is true",
      path: ["credential"],
    });
  }
});
export type PublicModelConfigResponse = z.infer<typeof PublicModelConfigResponseSchema>;

/** Browser -> Host. The write-only api_key is accepted but is never part of a public response. */
export const ModelConfigUpdateRequestSchema = z.object({
  provider: ModelProviderSchema,
  protocol: ModelProtocolSchema,
  base_url: z.string().url().max(500),
  model: NonEmptyStringSchema.max(200),
  api_key: z.string().trim().min(8).max(2_000).optional(),
}).strict();
export type ModelConfigUpdateRequest = z.infer<typeof ModelConfigUpdateRequestSchema>;
