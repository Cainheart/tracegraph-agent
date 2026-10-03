import { z } from "zod";
import { IdentifierSchema, RelativePathSchema } from "./common.js";
import { ReasoningEffortSchema } from "./commands.js";
import { McpConfigSchema } from "./mcp.js";
import {UsageSnapshotSchema} from "./usage.js";
import { LspConfigSchema } from "./lsp.js";

export const WORKBENCH_CONFIG_VERSION = "outlive.workbench.v1" as const;
const ShortText = z.string().trim().min(1).max(512);
const Timestamp = z.iso.datetime({ offset: true });
export const WorkbenchSettingsValuesSchema = z.object({
  general: z.object({ language: z.enum(["en", "zh-CN"]).default("zh-CN"), enter_behavior: z.enum(["enter", "mod-enter"]).default("enter"), notify_completed: z.boolean().default(true), notify_failed: z.boolean().default(true), notify_approval: z.boolean().default(true) }).strict().default({ language: "zh-CN", enter_behavior: "enter", notify_completed: true, notify_failed: true, notify_approval: true }),
  appearance: z.object({ theme: z.enum(["system", "light", "dark"]).default("system"), ui_font_size: z.number().int().min(12).max(24).default(14), code_font_size: z.number().int().min(11).max(24).default(14), output_density: z.enum(["compact", "expanded"]).default("compact") }).strict().default({ theme: "system", ui_font_size: 14, code_font_size: 14, output_density: "compact" }),
  model: z.object({ reasoning_effort: ReasoningEffortSchema.default("default") }).strict().default({ reasoning_effort: "default" }),
  memory: z.object({ memory_recall: z.boolean().default(false), experience_recall: z.boolean().default(false), project_ids: z.array(IdentifierSchema).max(128).default([]) }).strict().default({ memory_recall: false, experience_recall: false, project_ids: [] }),
  developer: z.object({ editor: z.string().max(512).default(""), shell: z.string().max(512).default(""), worktree_directory: z.string().max(4_096).default(""), preview_open: z.enum(["panel", "browser"]).default("panel"), review_scope: z.enum(["workspace", "staged", "branch"]).default("workspace"), max_parallel_runs: z.number().int().min(1).max(16).default(4) }).strict().default({ editor: "", shell: "", worktree_directory: "", preview_open: "panel", review_scope: "workspace", max_parallel_runs: 4 }),
  tools: z.object({ disabled_skills: z.array(ShortText).max(256).default([]), disabled_extensions: z.array(ShortText).max(128).default([]), mcp: McpConfigSchema.default({ config_version: "tracegraph.mcp.v1", servers: [] }), lsp: LspConfigSchema.default({ config_version: "tracegraph.lsp.v1", servers: [] }) }).strict().default({ disabled_skills: [], disabled_extensions: [], mcp: { config_version: "tracegraph.mcp.v1", servers: [] }, lsp: { config_version: "tracegraph.lsp.v1", servers: [] } }),
  telemetry: z.object({ enabled: z.boolean().default(false), endpoint: z.string().max(2_048).default(""), authorization_ref: z.string().max(512).default("") }).strict().default({ enabled: false, endpoint: "", authorization_ref: "" }),
}).strict();
export type WorkbenchSettingsValues = z.infer<typeof WorkbenchSettingsValuesSchema>;
export const SettingFieldMetadataSchema = z.object({ path: ShortText, source: z.enum(["default", "profile", "environment", "policy"]), scope: z.enum(["profile", "project", "client"]), writable: z.boolean(), effective: z.enum(["immediate", "new-run", "restart"]), reason: z.string().max(1_000).optional() }).strict();
export const WorkbenchSettingsSnapshotSchema = z.object({ config_version: z.literal(WORKBENCH_CONFIG_VERSION), revision: z.number().int().nonnegative(), profile_id: IdentifierSchema, settings: WorkbenchSettingsValuesSchema, fields: z.array(SettingFieldMetadataSchema).max(256), pending_restart: z.array(ShortText).max(128), model_test: z.object({status:z.enum(["passed","failed"]),code:ShortText,message:z.string().max(1000),checked_at:Timestamp,model:z.string().max(512),duration_ms:z.number().int().nonnegative()}).strict().optional() }).strict();
export type WorkbenchSettingsSnapshot = z.infer<typeof WorkbenchSettingsSnapshotSchema>;
export const UpdateWorkbenchSettingsRequestSchema = z.object({ command_id: IdentifierSchema, expected_revision: z.number().int().nonnegative(), patch: z.object({general:WorkbenchSettingsValuesSchema.shape.general.unwrap().optional(),appearance:WorkbenchSettingsValuesSchema.shape.appearance.unwrap().optional(),model:WorkbenchSettingsValuesSchema.shape.model.unwrap().optional(),memory:WorkbenchSettingsValuesSchema.shape.memory.unwrap().optional(),developer:WorkbenchSettingsValuesSchema.shape.developer.unwrap().optional(),tools:WorkbenchSettingsValuesSchema.shape.tools.unwrap().optional(),telemetry:WorkbenchSettingsValuesSchema.shape.telemetry.unwrap().optional()}).strict() }).strict();
export type UpdateWorkbenchSettingsRequest = z.infer<typeof UpdateWorkbenchSettingsRequestSchema>;

export const HostCapabilitySchema = z.object({ operation: ShortText, state: z.enum(["available", "unconfigured", "readonly", "policy-denied", "unavailable"]), reason: z.string().max(1_000).optional(), scope: z.enum(["profile", "project", "run"]), requires_restart: z.boolean().default(false) }).strict();
export const HostCapabilitiesSchema = z.object({ profile_id: IdentifierSchema, protocol_version: ShortText, capabilities: z.array(HostCapabilitySchema).max(256) }).strict();
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;
export const ModelConnectionTestRequestSchema = z.object({ command_id: IdentifierSchema }).strict();
export const ModelConnectionTestResultSchema = z.object({ status: z.enum(["passed", "failed"]), code: ShortText, message: z.string().max(1_000), checked_at: Timestamp, model: z.string().max(512), duration_ms: z.number().int().nonnegative() }).strict();
export type ModelConnectionTestResult = z.infer<typeof ModelConnectionTestResultSchema>;

export const BackgroundRunSchema = z.object({ run_id: IdentifierSchema, session_id: IdentifierSchema.optional(), project_id: IdentifierSchema, task: z.string().max(8_000), status: ShortText, started_at: Timestamp.optional() }).strict();
export const TerminalSnapshotSchema = z.object({ terminal_id: IdentifierSchema, project_id: IdentifierSchema, title: ShortText, state: z.enum(["running", "closed", "interrupted"]), transcript: z.string().max(262_144), cursor: z.number().int().nonnegative(), exit_code: z.number().int().nullable(), created_at: Timestamp }).strict();
export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;
export const PreviewSnapshotSchema = z.object({ preview_id: IdentifierSchema, project_id: IdentifierSchema, url: z.url(), state: z.enum(["starting", "ready", "failed", "stopped"]), owned_process: z.boolean(), message: z.string().max(1_000).optional() }).strict();
export type PreviewSnapshot = z.infer<typeof PreviewSnapshotSchema>;
export const ScheduleTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: Timestamp }).strict(),
  z.object({ kind: z.literal("interval"), seconds: z.number().int().min(60).max(31_536_000) }).strict(),
  z.object({ kind: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u) }).strict(),
]);
export const ScheduleInputSchema = z.object({ title: ShortText, project_id: IdentifierSchema, task: z.string().trim().min(1).max(8_000), mode: z.enum(["plan", "execute"]).default("plan"), timing: ScheduleTimingSchema, timezone: ShortText, enabled: z.boolean().default(true) }).strict();
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export const ScheduleSnapshotSchema = ScheduleInputSchema.extend({ schedule_id: IdentifierSchema, revision: z.number().int().nonnegative(), next_at: Timestamp.nullable(), running_run_id: IdentifierSchema.nullable(), last_status: z.enum(["never", "started", "completed", "failed", "awaiting-approval", "missed", "overlap-skipped", "interrupted"]) }).strict();
export type ScheduleSnapshot = z.infer<typeof ScheduleSnapshotSchema>;
export const ScheduleOccurrenceSchema = z.object({ occurrence_id: IdentifierSchema, schedule_id: IdentifierSchema, scheduled_at: Timestamp, status: ScheduleSnapshotSchema.shape.last_status, run_id: IdentifierSchema.optional(), message: z.string().max(1_000).optional() }).strict();
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>;
export const WorkbenchNotificationSchema = z.object({ notification_id: IdentifierSchema, event_id: IdentifierSchema, run_id: IdentifierSchema, session_id: IdentifierSchema.optional(), project_id: IdentifierSchema, task: z.string().max(8_000), status: z.enum(["completed", "failed", "interrupted", "awaiting_approval", "awaiting_plan_approval"]), occurred_at: Timestamp }).strict();
export type WorkbenchNotification = z.infer<typeof WorkbenchNotificationSchema>;
export const WorkbenchResourcesSchema = z.object({ runs: z.array(BackgroundRunSchema).max(256), terminals: z.array(TerminalSnapshotSchema).max(32), previews: z.array(PreviewSnapshotSchema).max(32), schedules: z.array(ScheduleSnapshotSchema).max(128), archived_session_ids: z.array(IdentifierSchema).max(10_000), notifications: z.array(WorkbenchNotificationSchema).max(128).optional() }).strict();
export type WorkbenchResources = z.infer<typeof WorkbenchResourcesSchema>;
export const GitStatusSnapshotSchema = z.object({ project_id: IdentifierSchema, branch: z.string().max(512), head: z.string().max(128).optional(), files: z.array(z.object({ path: z.string().max(4_096), index_status: z.string().max(2), worktree_status: z.string().max(2) }).strict()).max(10_000), worktrees: z.array(z.object({ path: z.string().max(4_096), branch: z.string().max(512), head: z.string().max(128), locked: z.boolean() }).strict()).max(128), diff: z.string().max(1_048_576).optional() }).strict();
export type GitStatusSnapshot = z.infer<typeof GitStatusSnapshotSchema>;
const CommandBase = { command_id: IdentifierSchema };
const ProjectBase = { ...CommandBase, project_id: IdentifierSchema };
export const WorkbenchCommandRequestSchema = z.discriminatedUnion("type", [
  z.object({ ...ProjectBase, type: z.literal("git.status") }).strict(),
  z.object({ ...ProjectBase, type: z.literal("git.diff"), scope: z.enum(["workspace", "staged", "branch"]), base: z.string().max(512).optional(), paths:z.array(RelativePathSchema).min(1).max(1000).optional() }).strict(),
  ...(["git.stage", "git.unstage", "git.discard"] as const).map((type) => z.object({ ...ProjectBase, type: z.literal(type), paths: z.array(RelativePathSchema).min(1).max(1_000), expected_head: z.string().max(128).optional() }).strict()),
  z.object({ ...ProjectBase, type: z.literal("git.commit"), message: z.string().trim().min(1).max(8_000) }).strict(),
  z.object({ ...ProjectBase, type: z.literal("git.branch.create"), name: ShortText }).strict(),
  z.object({ ...ProjectBase, type: z.literal("git.worktree.create"), name: ShortText, branch: ShortText }).strict(),
  z.object({ ...ProjectBase, type: z.literal("git.worktree.remove"), worktree_path: z.string().min(1).max(4_096) }).strict(),
  z.object({ ...ProjectBase, type: z.literal("terminal.create"), title: ShortText.optional(), cols: z.number().int().min(20).max(500).default(100), rows: z.number().int().min(5).max(300).default(30) }).strict(),
  z.object({ ...CommandBase, type: z.literal("terminal.input"), terminal_id: IdentifierSchema, text: z.string().min(1).max(32_768) }).strict(),
  z.object({ ...CommandBase, type: z.literal("terminal.resize"), terminal_id: IdentifierSchema, cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) }).strict(),
  z.object({ ...CommandBase, type: z.literal("terminal.close"), terminal_id: IdentifierSchema }).strict(),
  z.object({ ...ProjectBase, type: z.literal("preview.start"), command: ShortText, args: z.array(z.string().max(2_048)).max(64).default([]), port: z.number().int().min(1024).max(65_535) }).strict(),
  z.object({ ...ProjectBase, type: z.literal("preview.register"), port: z.number().int().min(1024).max(65_535) }).strict(),
  z.object({ ...CommandBase, type: z.literal("preview.stop"), preview_id: IdentifierSchema }).strict(),
  z.object({ ...CommandBase, type: z.literal("schedule.create"), input: ScheduleInputSchema }).strict(),
  z.object({ ...CommandBase, type: z.literal("schedule.update"), schedule_id: IdentifierSchema, expected_revision: z.number().int().nonnegative(), input: ScheduleInputSchema }).strict(),
  z.object({ ...CommandBase, type: z.literal("schedule.delete"), schedule_id: IdentifierSchema }).strict(),
  z.object({ ...CommandBase, type: z.literal("schedule.run"), schedule_id: IdentifierSchema }).strict(),
  z.object({ ...CommandBase, type: z.literal("schedule.history"), schedule_id: IdentifierSchema }).strict(),
  ...(["sessions.archive", "sessions.unarchive"] as const).map((type) => z.object({ ...CommandBase, type: z.literal(type), session_id: IdentifierSchema }).strict()),
  z.object({ ...CommandBase, type: z.literal("host.diagnostics") }).strict(),
  z.object({ ...CommandBase, type: z.literal("host.stop") }).strict(),
  z.object({ ...CommandBase, type: z.literal("host.restart") }).strict(),
  z.object({ ...CommandBase, type: z.literal("queue.cancel"),holder_id:IdentifierSchema }).strict(),
  z.object({ ...CommandBase, type: z.literal("lsp.restart"),server_name:ShortText }).strict(),
  z.object({ ...CommandBase, type: z.literal("usage.query"),project_id:IdentifierSchema.optional(),session_id:IdentifierSchema.optional(),from:Timestamp.optional(),to:Timestamp.optional() }).strict(),
  z.object({ ...CommandBase, type: z.literal("model.clear-key") }).strict(),
  z.object({ ...ProjectBase, type: z.literal("skills.validate") }).strict(),
]);
export type WorkbenchCommandRequest = z.infer<typeof WorkbenchCommandRequestSchema>;
export const WorkbenchCommandResultSchema = z.object({ command_id: IdentifierSchema, status: z.enum(["succeeded", "queued"]), code: ShortText, message: z.string().max(2_000), usage:UsageSnapshotSchema.optional(), git: GitStatusSnapshotSchema.optional(), terminal: TerminalSnapshotSchema.optional(), preview: PreviewSnapshotSchema.optional(), schedule: ScheduleSnapshotSchema.optional(), occurrences: z.array(ScheduleOccurrenceSchema).max(1_000).optional(), text: z.string().max(1_048_576).optional() }).strict();
export type WorkbenchCommandResult = z.infer<typeof WorkbenchCommandResultSchema>;

export const MigrationPreviewSnapshotSchema=z.object({sources:z.array(z.object({source_id:IdentifierSchema,label:ShortText,file_count:z.number().int().nonnegative()}).strict()).max(8),selected_source_id:IdentifierSchema.nullable(),requires_source_selection:z.boolean(),files:z.array(z.object({source_id:IdentifierSchema,scope:z.enum(["data","sessions","model","permission","credentials"]),relative_path:z.string().max(4096),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()).max(100000),conflicts:z.array(z.object({scope:ShortText,relative_path:z.string().max(4096),source_ids:z.array(IdentifierSchema).max(8)}).strict()).max(10000),active_writer_sources:z.array(IdentifierSchema).max(8),warnings:z.array(z.string().max(2000)).max(100)}).strict();
export type MigrationPreviewSnapshot=z.infer<typeof MigrationPreviewSnapshotSchema>;
export const MigrationCommitReceiptSchema=z.object({selected_source_id:IdentifierSchema,copied_files:z.number().int().nonnegative(),quarantined_source_ids:z.array(IdentifierSchema).max(8),backup_created:z.literal(true)}).strict();
export type MigrationCommitReceipt=z.infer<typeof MigrationCommitReceiptSchema>;
