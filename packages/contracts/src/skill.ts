import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema, ToolNameSchema } from "./common.js";

/** Agent Skills metadata is intentionally smaller than the executable body. */
export const SkillNameSchema = z.string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u, "skill name must be a lowercase identifier");
export type SkillName = z.infer<typeof SkillNameSchema>;

export const SkillVersionSchema = NonEmptyStringSchema.max(64);
export const SkillSourceSchema = z.enum(["project", "user"]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillCatalogEntrySchema = z.object({
  name: SkillNameSchema,
  description: NonEmptyStringSchema.max(1_000),
  version: SkillVersionSchema,
  allowed_tools: z.array(ToolNameSchema).max(256).default([]),
  source: SkillSourceSchema,
}).strict();
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;

export const SkillConflictSchema = z.object({
  name: SkillNameSchema,
  winner: SkillSourceSchema,
  loser: SkillSourceSchema,
  winner_path: NonEmptyStringSchema.max(1_000),
  loser_path: NonEmptyStringSchema.max(1_000),
  reason: NonEmptyStringSchema.max(240),
}).strict();
export type SkillConflict = z.infer<typeof SkillConflictSchema>;

export const SkillDiagnosticSchema = z.object({
  source: SkillSourceSchema,
  path: NonEmptyStringSchema.max(1_000),
  code: z.enum(["missing_frontmatter", "invalid_frontmatter", "invalid_body", "unsafe_path", "read_failed"]),
  message: NonEmptyStringSchema.max(500),
}).strict();
export type SkillDiagnostic = z.infer<typeof SkillDiagnosticSchema>;

export const SkillRegistrySnapshotSchema = z.object({
  registry_digest: Sha256Schema,
  skills: z.array(SkillCatalogEntrySchema).max(256),
  conflicts: z.array(SkillConflictSchema).max(256),
  diagnostics: z.array(SkillDiagnosticSchema).max(512),
}).strict();
export type SkillRegistrySnapshot = z.infer<typeof SkillRegistrySnapshotSchema>;

export const SkillLoadInputSchema = z.object({
  name: SkillNameSchema,
}).strict();
export type SkillLoadInput = z.infer<typeof SkillLoadInputSchema>;

export const SkillRegistryLoadedDataSchema = z.object({
  registry_digest: Sha256Schema,
  skill_names: z.array(SkillNameSchema).max(256),
  loaded_count: z.number().int().nonnegative().max(256),
  conflict_count: z.number().int().nonnegative().max(256),
  diagnostic_count: z.number().int().nonnegative().max(512),
}).strict();
export type SkillRegistryLoadedData = z.infer<typeof SkillRegistryLoadedDataSchema>;

export const SkillConflictDataSchema = SkillConflictSchema;
export const SkillLoadFailedDataSchema = SkillDiagnosticSchema.extend({
  skill_name: SkillNameSchema.optional(),
}).strict();
export type SkillLoadFailedData = z.infer<typeof SkillLoadFailedDataSchema>;

/** Public Host inspection response groups skills by the registered project. */
export const SkillProjectInspectionSchema = z.object({
  project_id: IdentifierSchema,
  label: NonEmptyStringSchema.max(200),
  registry: SkillRegistrySnapshotSchema,
}).strict();
export type SkillProjectInspection = z.infer<typeof SkillProjectInspectionSchema>;
