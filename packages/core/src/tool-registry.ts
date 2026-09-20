import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, opendir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  ArtifactKindSchema,
  BoundedJsonSchemaSchema,
  ModelToolSchema,
  InterruptSubagentInputSchema,
  ListSubagentsInputSchema,
  RelativePathSchema,
  SendSubagentMessageInputSchema,
  SkillLoadInputSchema,
  SpawnSubagentInputSchema,
  TeamHeartbeatInputSchema,
  TeamMailboxClaimInputSchema,
  TeamMailboxSendInputSchema,
  TeamMutationResultSchema,
  TeamReadInputSchema,
  TeamReadResponseSchema,
  TeamTaskWriteInputSchema,
  ToolDescriptorSchema,
  ToolCallSchema,
  TodoListSchema,
  TodoMutationResultSchema,
  TodoReadInputSchema,
  TodoWriteInputSchema,
  ValidatedActionSchema,
  toModelToolSchema,
  type ArtifactRef,
  type BoundedJsonSchema,
  type ModelTool,
  type RunMode,
  type SandboxMode,
  type ToolCall,
  type ToolDescriptor,
  type ToolName,
  type TeamMutationResult,
  type TeamProjection,
  type TeamReadInput,
  type TeamReadSection,
  type TodoList,
  type TodoReadInput,
  type TodoWriteInput,
  type ValidatedAction,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { z } from "zod";
import { defaultIdFactory, redactSensitiveText, sha256 } from "./crypto.js";
import { createSandboxRunner } from "./sandbox/runner.js";
import {
  runBoundedProcess,
  type BoundedProcessOptions,
  type BoundedProcessResult,
} from "./sandbox/process-runner.js";
import {
  TEAM_READ_MODEL_EXCERPT_BYTES,
  TODO_READ_MODEL_EXCERPT_BYTES,
  TOOL_OUTPUT_LIMITS,
  type BuiltinToolName,
  type ToolOutputLimit,
} from "./tool-output-limits.js";
import { TodoDomainError } from "./todo.js";
import { assertInside, resolveWorkspacePath } from "./workspace.js";
import type { RawToolResult, ToolDefinition, ToolExecutionContext } from "./types.js";
import type { TraceGraphExtension } from "./extension.js";

export const ReadFileInputSchema = z.object({ path: RelativePathSchema }).strict();
export const ReadArtifactInputSchema = z.object({
  locator: z.string().trim().min(1).max(180).regex(/^artifact:[A-Za-z0-9_.:-]+$/u),
  /** UTF-8 byte offset returned by the previous page. */
  offset: z.number().int().nonnegative().max(8 * 1024 * 1024).default(0),
  /** Byte-safe chunk bound aligned with durable Observation visibility. */
  limit: z.number().int().min(64).max(4_000).default(4_000),
}).strict();
export const ListArtifactsInputSchema = z.object({
  offset: z.number().int().nonnegative().max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const ListDirInputSchema = z.object({ path: RelativePathSchema.default("."), depth: z.number().int().min(0).max(3).default(1) }).strict();
export const SearchInputSchema = z.object({ pattern: z.string().min(1).max(500) }).strict();
export const PatchInputSchema = z.object({
  path: RelativePathSchema,
  expected: z.string().max(20_000),
  replacement: z.string().max(20_000),
}).strict();
export const CommitPatchInputSchema = PatchInputSchema.extend({
  base_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  patch_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
export const RunTestInputSchema = z.object({ suite: z.literal("fixture") }).strict();

/** Runtime output boundary shared by every built-in Tool definition. */
export const RawToolResultSchema = z.object({
  status: z.enum(["success", "failure", "unknown"]),
  // Keep the shared result envelope compatible with ToolBatchResultSchema.
  code: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(2_000),
  content: z.string().optional(),
  mimeType: z.string().trim().min(1).max(160).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const PublicArtifactMetadataSchema = z.object({
  artifact_id: z.string().min(1).max(160),
  locator: z.string().min(1).max(180),
  kind: ArtifactKindSchema,
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  mime_type: z.string().min(1).max(160),
  byte_length: z.number().int().nonnegative(),
  created_at: z.iso.datetime({ offset: true }),
}).strict();
export type PublicArtifactMetadata = z.infer<typeof PublicArtifactMetadataSchema>;

export interface FileToolLimits {
  /** Maximum bytes read from any single file. */
  maxFileBytes: number;
  /** Maximum regular files inspected by one search. */
  maxFiles: number;
  /** Maximum aggregate file bytes read by one search. */
  maxBytes: number;
  /** Maximum directory depth below the workspace root. */
  maxDepth: number;
  /** Wall-clock budget for one read/search operation. */
  deadlineMs: number;
  /** Maximum search results returned to the model. */
  maxMatches: number;
}

export const DEFAULT_FILE_TOOL_LIMITS: Readonly<FileToolLimits> = Object.freeze({
  maxFileBytes: 64 * 1024,
  maxFiles: 2_000,
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  deadlineMs: 5_000,
  maxMatches: 50,
});

const FILE_TOOL_LIMIT_CEILINGS: Readonly<FileToolLimits> = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxFiles: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  deadlineMs: 60_000,
  maxMatches: 1_000,
});

export interface DefaultToolRegistryOptions {
  fileToolLimits?: Partial<FileToolLimits>;
  nowMs?: () => number;
}

const MIN_TOOL_RESULT_ENVELOPE_BYTES = 256;
const TODO_READ_RESULT_HEADROOM_BYTES = 8 * 1024;
const TODO_READ_CONTENT_HEADROOM_BYTES = 4 * 1024;
const TEAM_READ_RESULT_HEADROOM_BYTES = 8 * 1024;
const TEAM_READ_CONTENT_HEADROOM_BYTES = 4 * 1024;

interface RawToolContractOptions {
  description: string;
  timeoutMs: number;
  concurrencySafe: boolean;
  sideEffect: "none" | "read" | "write" | "execute";
  callLabel: string;
  resultLabel: string;
}

function rawToolContract(name: BuiltinToolName, options: RawToolContractOptions) {
  return {
    description: options.description,
    outputSchema: RawToolResultSchema,
    timeoutMs: options.timeoutMs,
    concurrencySafe: options.concurrencySafe,
    sideEffect: options.sideEffect,
    maxResultBytes: TOOL_OUTPUT_LIMITS[name].maxResultBytes,
    presentation: Object.freeze({
      callLabel: options.callLabel,
      resultLabel: options.resultLabel,
    }),
    render(_input: unknown, output: RawToolResult): RawToolResult {
      return output;
    },
  } as const;
}

export class ToolRegistry {
  readonly #definitions = new Map<ToolName, ToolDefinition>();
  readonly #descriptors = new Map<ToolName, ToolDescriptor>();
  readonly #tokens = new Map<ToolName, symbol>();

  constructor(definitions: readonly ToolDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): { dispose(): void } {
    const descriptor = toolDescriptor(definition);
    const previousDefinition = this.#definitions.get(definition.name);
    const previousDescriptor = this.#descriptors.get(definition.name);
    const previousToken = this.#tokens.get(definition.name);
    const token = Symbol(definition.name);
    this.#definitions.set(definition.name, definition as unknown as ToolDefinition);
    this.#descriptors.set(definition.name, descriptor);
    this.#tokens.set(definition.name, token);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // A later registration owns the visible slot. Disposing an older
        // registration must not erase that newer definition.
        if (this.#tokens.get(definition.name) !== token) return;
        if (previousDefinition === undefined || previousDescriptor === undefined) {
          this.#definitions.delete(definition.name);
          this.#descriptors.delete(definition.name);
          this.#tokens.delete(definition.name);
          return;
        }
        this.#definitions.set(definition.name, previousDefinition);
        this.#descriptors.set(definition.name, previousDescriptor);
        if (previousToken === undefined) this.#tokens.delete(definition.name);
        else this.#tokens.set(definition.name, previousToken);
      },
    };
  }

  get(name: ToolName): ToolDefinition | undefined {
    return this.#definitions.get(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.#definitions.values()];
  }

  /** Complete Host descriptors, suitable for policy/scheduling but not models. */
  descriptors(): readonly ToolDescriptor[] {
    return [...this.#descriptors.values()];
  }

  /**
   * Explicit model-boundary projection.  Do not replace this with object
   * spreading: Host-only output contracts, executors and scheduling policy
   * must remain unreachable from provider requests.
   */
  modelSchemas(allowlist?: ReadonlySet<ToolName>): readonly ModelTool[] {
    return this.descriptors()
      .filter((descriptor) => allowlist === undefined || allowlist.has(descriptor.name))
      .map((descriptor) =>
      ModelToolSchema.parse(toModelToolSchema(descriptor)));
  }
}

function toolDescriptor<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): ToolDescriptor {
  if (definition.maxResultBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES) {
    throw new RangeError(`maxResultBytes must be at least ${MIN_TOOL_RESULT_ENVELOPE_BYTES}`);
  }
  return ToolDescriptorSchema.parse({
    name: definition.name,
    description: definition.description,
    input_schema: definition.modelInputSchema === undefined
      ? boundedJsonSchema(definition.inputSchema)
      : BoundedJsonSchemaSchema.parse(definition.modelInputSchema),
    output_schema: boundedJsonSchema(definition.outputSchema),
    timeout_ms: definition.timeoutMs,
    concurrency_safe: definition.concurrencySafe,
    side_effect: definition.sideEffect,
    max_result_bytes: definition.maxResultBytes,
  });
}

function boundedJsonSchema(schema: z.ZodType): BoundedJsonSchema {
  const generated = z.toJSONSchema(schema);
  return BoundedJsonSchemaSchema.parse(normalizeGeneratedJsonSchema(generated));
}

/** Strip dialect metadata outside TraceGraph's bounded local subset. */
function normalizeGeneratedJsonSchema(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === "$schema" || key === "propertyNames") continue;
    if (key === "exclusiveMinimum" && typeof member === "number" && Number.isInteger(member)) {
      normalized.minimum = member + 1;
      continue;
    }
    if (key === "properties" && isPlainObject(member)) {
      normalized.properties = Object.fromEntries(
        Object.entries(member).map(([name, child]) => [name, normalizeGeneratedJsonSchema(child)]),
      );
      continue;
    }
    if (key === "additionalProperties" && isPlainObject(member)) {
      normalized.additionalProperties = Object.keys(member).length === 0
        ? true
        : normalizeGeneratedJsonSchema(member);
      continue;
    }
    if (key === "items") {
      normalized.items = normalizeGeneratedJsonSchema(member);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf") && Array.isArray(member)) {
      normalized[key] = member.map(normalizeGeneratedJsonSchema);
      continue;
    }
    normalized[key] = member;
  }
  return normalized;
}

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions = {}): ToolRegistry {
  const core = createCoreToolRegistry(options);
  // Preserve the historical model-schema order for direct callers. Runtime's
  // default composition still activates the two capability groups through
  // ExtensionManager; this helper remains a compatibility snapshot.
  return new ToolRegistry([
    core.get("read_file")!,
    ...artifactToolDefinitions(),
    ...runStateToolDefinitions(),
    core.get("list_dir")!,
    core.get("search")!,
    core.get("preview_patch")!,
    core.get("commit_patch")!,
    core.get("run_test")!,
  ]);
}

/** Tools that remain part of the small privileged execution kernel. */
export function createCoreToolRegistry(options: DefaultToolRegistryOptions = {}): ToolRegistry {
  const limits = normalizeFileToolLimits(options.fileToolLimits);
  const nowMs = options.nowMs ?? Date.now;
  return new ToolRegistry([
    createReadFileTool(limits, nowMs),
    createListDirTool(limits, nowMs),
    createSearchTool(limits, nowMs),
    previewPatchTool,
    commitPatchTool,
    runTestTool,
  ]);
}

export const BUILTIN_ARTIFACT_TOOLS_EXTENSION = "@tracegraph/builtin-artifact-tools" as const;
export const BUILTIN_RUN_STATE_TOOLS_EXTENSION = "@tracegraph/builtin-run-state-tools" as const;

/** Existing Artifact tools are assembled through the same reversible API as external extensions. */
export function createArtifactToolsExtension(): TraceGraphExtension {
  return {
    name: BUILTIN_ARTIFACT_TOOLS_EXTENSION,
    api_version: "tracegraph.extension.v1",
    activate(context) {
      for (const definition of artifactToolDefinitions()) context.registerTool(definition);
    },
  };
}

/** Existing Todo/subagent control tools form a separately removable built-in capability group. */
export function createRunStateToolsExtension(): TraceGraphExtension {
  return {
    name: BUILTIN_RUN_STATE_TOOLS_EXTENSION,
    api_version: "tracegraph.extension.v1",
    activate(context) {
      for (const definition of runStateToolDefinitions()) context.registerTool(definition);
    },
  };
}

function artifactToolDefinitions(): readonly ToolDefinition[] {
  return [readArtifactTool, listArtifactsTool];
}

function runStateToolDefinitions(): readonly ToolDefinition[] {
  return [
    loadSkillTool,
    todoReadTool,
    todoWriteTool,
    spawnSubagentTool,
    sendSubagentMessageTool,
    listSubagentsTool,
    interruptSubagentTool,
    teamReadTool,
    teamTaskWriteTool,
    teamMailboxSendTool,
    teamMailboxClaimTool,
    teamHeartbeatTool,
  ];
}

const loadSkillTool: ToolDefinition<z.infer<typeof SkillLoadInputSchema>> = {
  name: "load_skill",
  ...rawToolContract("load_skill", {
    description: "Load one local Agent Skill body by name. The body is returned as bounded tool output and its declared tool scope narrows the current Run.",
    timeoutMs: 10_000,
    concurrencySafe: false,
    sideEffect: "read",
    callLabel: "Load skill",
    resultLabel: "Skill instructions",
  }),
  inputSchema: SkillLoadInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.skills === undefined) {
      return {
        status: "failure",
        code: "skills_unavailable",
        summary: "Skill registry is unavailable for this Run",
      };
    }
    try {
      return await context.skills.load(input);
    } catch {
      return {
        status: "failure",
        code: "skill_load_failed",
        summary: "Skill could not be loaded",
      };
    }
  },
};

const teamReadTool: ToolDefinition<z.infer<typeof TeamReadInputSchema>> = {
  name: "team_read",
  ...rawToolContract("team_read", {
    description: "Read one stable, bounded page of a durable root-team section. Pin later pages with expected_last_sequence and follow next_offset until truncated is false.",
    timeoutMs: 10_000,
    concurrencySafe: true,
    sideEffect: "read",
    callLabel: "Read agent team",
    resultLabel: "Agent team state",
  }),
  inputSchema: TeamReadInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.team === undefined) return teamUnavailableResult();
    try {
      const response = TeamReadResponseSchema.parse(await context.team.read(input));
      const currentLastSequence = response.team?.last_sequence ?? 0;
      if (
        input.expected_last_sequence !== undefined
        && input.expected_last_sequence !== currentLastSequence
      ) {
        return {
          status: "failure",
          code: "team_snapshot_changed",
          summary: "Agent-team state changed while paging; restart this section from offset 0",
          facts: {
            section: input.section,
            offset: input.offset,
            expected_last_sequence: input.expected_last_sequence,
            current_last_sequence: currentLastSequence,
          },
        };
      }
      if (response.team === undefined) return renderEmptyTeamReadPage(input);

      const section = teamSection(response.team, input.section);
      const total = section.items.length;
      const offset = input.offset;
      const requestedEnd = Math.min(total, offset + input.limit);
      let items: unknown[] = [];
      for (let index = offset; index < requestedEnd; index += 1) {
        const candidate = [...items, section.items[index]!];
        const candidateResult = renderTeamReadPage({
          team: response.team,
          section: input.section,
          sectionLastSequence: section.lastSequence,
          items: candidate,
          total,
          offset,
          limit: input.limit,
        });
        if (!teamReadPageFits(candidateResult)) {
          if (items.length === 0) {
            return {
              status: "failure",
              code: "team_item_exceeds_read_page",
              summary: `Agent-team ${input.section} item at offset ${index} cannot fit in one bounded read page`,
              facts: {
                team_id: response.team.team_id,
                section: input.section,
                item_offset: index,
                total,
                last_sequence: response.team.last_sequence,
              },
            };
          }
          break;
        }
        items = candidate;
      }
      return renderTeamReadPage({
        team: response.team,
        section: input.section,
        sectionLastSequence: section.lastSequence,
        items,
        total,
        offset,
        limit: input.limit,
      });
    } catch (error) {
      return teamFailureResult(error);
    }
  },
};

const teamTaskWriteTool: ToolDefinition<z.infer<typeof TeamTaskWriteInputSchema>> = {
  name: "team_task_write",
  ...rawToolContract("team_task_write", {
    description: "Create or mutate one shared team task. Runtime derives coordinator/member identity; input cannot choose an owner.",
    timeoutMs: 10_000,
    concurrencySafe: true,
    sideEffect: "none",
    callLabel: "Update team task",
    resultLabel: "Team task update",
  }),
  inputSchema: TeamTaskWriteInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.team === undefined) return teamUnavailableResult();
    try {
      return teamMutationEnvelope("team_task_updated", "Updated durable team task", await context.team.writeTask(input));
    } catch (error) {
      return teamFailureResult(error);
    }
  },
};

const teamMailboxSendTool: ToolDefinition<z.infer<typeof TeamMailboxSendInputSchema>> = {
  name: "team_mailbox_send",
  ...rawToolContract("team_mailbox_send", {
    description: "Deliver one durable team mailbox message. Runtime derives the sender from canonical Run provenance.",
    timeoutMs: 10_000,
    concurrencySafe: true,
    sideEffect: "none",
    callLabel: "Send team message",
    resultLabel: "Team message delivery",
  }),
  inputSchema: TeamMailboxSendInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.team === undefined) return teamUnavailableResult();
    try {
      return teamMutationEnvelope("team_message_delivered", "Delivered durable team message", await context.team.sendMailbox(input));
    } catch (error) {
      return teamFailureResult(error);
    }
  },
};

const teamMailboxClaimTool: ToolDefinition<z.infer<typeof TeamMailboxClaimInputSchema>> = {
  name: "team_mailbox_claim",
  ...rawToolContract("team_mailbox_claim", {
    description: "Claim one mailbox message addressed to the current canonical coordinator or worker identity.",
    timeoutMs: 10_000,
    concurrencySafe: true,
    sideEffect: "none",
    callLabel: "Claim team message",
    resultLabel: "Team message claim",
  }),
  inputSchema: TeamMailboxClaimInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.team === undefined) return teamUnavailableResult();
    try {
      return teamMutationEnvelope("team_message_claimed", "Claimed durable team message", await context.team.claimMailbox(input));
    } catch (error) {
      return teamFailureResult(error);
    }
  },
};

const teamHeartbeatTool: ToolDefinition<z.infer<typeof TeamHeartbeatInputSchema>> = {
  name: "team_heartbeat",
  ...rawToolContract("team_heartbeat", {
    description: "Advance the current joined worker's durable heartbeat. The Runtime, not input, selects the member identity.",
    timeoutMs: 10_000,
    concurrencySafe: true,
    sideEffect: "none",
    callLabel: "Heartbeat team worker",
    resultLabel: "Team worker heartbeat",
  }),
  inputSchema: TeamHeartbeatInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.team === undefined) return teamUnavailableResult();
    try {
      return teamMutationEnvelope("team_heartbeat_recorded", "Recorded durable worker heartbeat", await context.team.heartbeat(input));
    } catch (error) {
      return teamFailureResult(error);
    }
  },
};

function teamSection(
  team: TeamProjection,
  section: TeamReadSection,
): { items: readonly unknown[]; lastSequence: number } {
  switch (section) {
    case "roster":
      return { items: team.roster.members, lastSequence: team.roster.last_sequence };
    case "mailbox":
      return { items: team.mailbox.messages, lastSequence: team.mailbox.last_sequence };
    case "task_board":
      return { items: team.task_board.items, lastSequence: team.task_board.last_sequence };
  }
}

function teamCounts(team: TeamProjection) {
  const taskStates = {
    open: 0,
    claimed: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const task of team.task_board.items) taskStates[task.state] += 1;
  return {
    members: {
      total: team.roster.members.length,
      active: team.roster.members.filter(({ status }) => status === "active").length,
      lost: team.roster.members.filter(({ status }) => status === "lost").length,
    },
    mailbox: {
      total: team.mailbox.messages.length,
      unclaimed: team.mailbox.messages.filter(({ claimed_at: claimedAt }) => claimedAt === undefined).length,
    },
    tasks: { total: team.task_board.items.length, ...taskStates },
  };
}

function renderTeamReadPage(input: {
  team: TeamProjection;
  section: TeamReadSection;
  sectionLastSequence: number;
  items: readonly unknown[];
  total: number;
  offset: number;
  limit: number;
}): RawToolResult {
  const nextOffset = input.offset + input.items.length;
  const truncated = nextOffset < input.total;
  const counts = teamCounts(input.team);
  const page = {
    team: {
      team_id: input.team.team_id,
      coordinator_run_id: input.team.coordinator_run_id,
      limits: input.team.limits,
      created_event_id: input.team.created_event_id,
      created_at: input.team.created_at,
      last_sequence: input.team.last_sequence,
      counts,
    },
    section: input.section,
    items: input.items,
    total: input.total,
    returned_count: input.items.length,
    offset: input.offset,
    limit: input.limit,
    section_last_sequence: input.sectionLastSequence,
    truncated,
    ...(truncated ? { next_offset: nextOffset } : {}),
  };
  const content = JSON.stringify(page, null, 2);
  return {
    status: "success",
    code: "team_read",
    summary: `Read ${input.items.length} of ${input.total} agent-team ${input.section} item${input.total === 1 ? "" : "s"} from offset ${input.offset}${truncated ? " (more remain)" : ""}`,
    content,
    mimeType: "application/json",
    facts: {
      team_present: true,
      team_id: input.team.team_id,
      section: input.section,
      total: input.total,
      returned_count: input.items.length,
      offset: input.offset,
      limit: input.limit,
      last_sequence: input.team.last_sequence,
      section_last_sequence: input.sectionLastSequence,
      truncated,
      ...(truncated ? { next_offset: nextOffset } : {}),
      content: truncateUtf8(content, TEAM_READ_MODEL_EXCERPT_BYTES),
    },
  };
}

function renderEmptyTeamReadPage(input: TeamReadInput): RawToolResult {
  const page = {
    team: null,
    section: input.section,
    items: [],
    total: 0,
    returned_count: 0,
    offset: input.offset,
    limit: input.limit,
    section_last_sequence: 0,
    truncated: false,
  };
  const content = JSON.stringify(page, null, 2);
  return {
    status: "success",
    code: "team_read",
    summary: "No durable agent team exists for this Run",
    content,
    mimeType: "application/json",
    facts: {
      team_present: false,
      section: input.section,
      total: 0,
      returned_count: 0,
      offset: input.offset,
      limit: input.limit,
      last_sequence: 0,
      section_last_sequence: 0,
      truncated: false,
      content,
    },
  };
}

function teamReadPageFits(result: RawToolResult): boolean {
  const limits = TOOL_OUTPUT_LIMITS.team_read;
  return Buffer.byteLength(result.content ?? "", "utf8")
      <= limits.sectionBytes.content - TEAM_READ_CONTENT_HEADROOM_BYTES
    && jsonBytes(result) <= limits.maxResultBytes - TEAM_READ_RESULT_HEADROOM_BYTES;
}

function teamMutationEnvelope(code: string, summary: string, value: unknown): RawToolResult {
  const mutation = TeamMutationResultSchema.parse(value);
  const counts = teamCounts(mutation.team);
  const receipt = {
    command_id: mutation.command_id,
    disposition: mutation.disposition,
    event_ids: mutation.event_ids,
    team: {
      team_id: mutation.team.team_id,
      last_sequence: mutation.team.last_sequence,
      counts,
    },
  };
  return {
    status: "success",
    code,
    summary,
    content: JSON.stringify(receipt, null, 2),
    mimeType: "application/json",
    facts: compactTeamMutationFacts(mutation, counts),
  };
}

function compactTeamMutationFacts(
  mutation: TeamMutationResult,
  counts: ReturnType<typeof teamCounts>,
): Record<string, unknown> {
  return {
    command_id: mutation.command_id,
    disposition: mutation.disposition,
    event_ids: mutation.event_ids,
    team_id: mutation.team.team_id,
    last_sequence: mutation.team.last_sequence,
    member_count: counts.members.total,
    active_member_count: counts.members.active,
    lost_member_count: counts.members.lost,
    mailbox_count: counts.mailbox.total,
    unclaimed_message_count: counts.mailbox.unclaimed,
    task_count: counts.tasks.total,
    open_task_count: counts.tasks.open,
    claimed_task_count: counts.tasks.claimed,
    done_task_count: counts.tasks.done,
    blocked_task_count: counts.tasks.blocked,
    cancelled_task_count: counts.tasks.cancelled,
  };
}

function teamUnavailableResult(): RawToolResult {
  return {
    status: "failure",
    code: "team_control_unavailable",
    summary: "Agent-team control is unavailable in this runtime",
  };
}

function teamFailureResult(error: unknown): RawToolResult {
  const value = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown } : {};
  return {
    status: "failure",
    code: typeof value.code === "string" ? redactSensitiveText(value.code).slice(0, 160) : "team_control_failed",
    summary: typeof value.message === "string"
      ? redactSensitiveText(value.message).slice(0, 2_000)
      : "Agent-team control failed",
  };
}

const spawnSubagentTool: ToolDefinition<z.infer<typeof SpawnSubagentInputSchema>> = {
  name: "spawn_subagent",
  ...rawToolContract("spawn_subagent", {
    description: "Delegate one bounded task packet to a trusted child-agent profile and wait for its canonical result. The built-in profile name is readonly.",
    timeoutMs: 300_000,
    concurrencySafe: true,
    sideEffect: "none",
    callLabel: "Delegate child task",
    resultLabel: "Child task result",
  }),
  inputSchema: SpawnSubagentInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.subagents === undefined) return subagentUnavailableResult();
    try {
      // Runtime arms the shield at the durable parent `subagent.started`
      // boundary. Before that point ordinary Tool cancellation still wins;
      // afterwards Runtime must cascade and wait for a child terminal proof.
      const result = await context.subagents.spawn(input, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.cancellationShield === undefined
          ? {}
          : { cancellationShield: context.cancellationShield }),
      });
      return subagentResultEnvelope("subagent_result", "Subagent returned a canonical result", result);
    } catch (error) {
      return subagentFailureResult(error);
    }
  },
};

const sendSubagentMessageTool: ToolDefinition<z.infer<typeof SendSubagentMessageInputSchema>> = {
  name: "send_subagent_message",
  ...rawToolContract("send_subagent_message", {
    description: "Queue a durable parent-agent message for one active direct child.",
    timeoutMs: 30_000,
    concurrencySafe: true,
    sideEffect: "none",
    callLabel: "Message child agent",
    resultLabel: "Child message receipt",
  }),
  inputSchema: SendSubagentMessageInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.subagents === undefined) return subagentUnavailableResult();
    try {
      return subagentResultEnvelope(
        "subagent_message_queued",
        "Message was durably queued for the child agent",
        await context.subagents.sendMessage(input),
      );
    } catch (error) {
      return subagentFailureResult(error);
    }
  },
};

const listSubagentsTool: ToolDefinition<z.infer<typeof ListSubagentsInputSchema>> = {
  name: "list_subagents",
  ...rawToolContract("list_subagents", {
    description: "List canonical child-agent state derived from the current parent Run ledger.",
    timeoutMs: 10_000,
    concurrencySafe: true,
    sideEffect: "read",
    callLabel: "List child agents",
    resultLabel: "Child agent list",
  }),
  inputSchema: ListSubagentsInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.subagents === undefined) return subagentUnavailableResult();
    try {
      return subagentResultEnvelope(
        "subagent_listed",
        "Listed canonical child-agent state",
        await context.subagents.list(input),
      );
    } catch (error) {
      return subagentFailureResult(error);
    }
  },
};

const interruptSubagentTool: ToolDefinition<z.infer<typeof InterruptSubagentInputSchema>> = {
  name: "interrupt_subagent",
  ...rawToolContract("interrupt_subagent", {
    description: "Durably cancel one active direct child agent and wait for its terminal receipt.",
    timeoutMs: 60_000,
    concurrencySafe: true,
    sideEffect: "none",
    callLabel: "Interrupt child agent",
    resultLabel: "Child interruption receipt",
  }),
  inputSchema: InterruptSubagentInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.subagents === undefined) return subagentUnavailableResult();
    try {
      return subagentResultEnvelope(
        "subagent_interrupted",
        "Child interruption reached a durable terminal state",
        await context.subagents.interrupt(input),
      );
    } catch (error) {
      return subagentFailureResult(error);
    }
  },
};

function subagentResultEnvelope(code: string, summary: string, value: unknown): RawToolResult {
  return {
    status: "success",
    code,
    summary,
    content: JSON.stringify(value),
    mimeType: "application/json",
    facts: { subagent: value },
  };
}

function subagentUnavailableResult(): RawToolResult {
  return {
    status: "failure",
    code: "subagent_control_unavailable",
    summary: "Subagent control is unavailable in this runtime",
  };
}

function subagentFailureResult(error: unknown): RawToolResult {
  const value = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown } : {};
  return {
    status: "failure",
    code: typeof value.code === "string" ? redactSensitiveText(value.code).slice(0, 160) : "subagent_control_failed",
    summary: typeof value.message === "string"
      ? redactSensitiveText(value.message).slice(0, 2_000)
      : "Subagent control failed",
  };
}

const readArtifactTool: ToolDefinition<z.infer<typeof ReadArtifactInputSchema>> = {
  name: "read_artifact",
  ...rawToolContract("read_artifact", {
    description: "Read one bounded UTF-8 page from an archived Context Artifact in the current Run.",
    timeoutMs: 5_000,
    concurrencySafe: true,
    sideEffect: "read",
    callLabel: "Read archived Context",
    resultLabel: "Archived Context page",
  }),
  inputSchema: ReadArtifactInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.signal?.aborted) return abortedToolResult();
    if (context.readArtifact === undefined) {
      return {
        status: "failure",
        code: "artifact_reader_unavailable",
        summary: "Artifact retrieval is unavailable in this runtime",
        facts: { locator: input.locator },
      };
    }
    try {
      const artifact = await context.readArtifact({
        locator: input.locator,
        offset: input.offset,
        limit: input.limit,
      });
      if (context.signal?.aborted) return abortedToolResult();
      return {
        status: "success",
        code: "artifact_read",
        summary: artifact.truncated
          ? `Retrieved archived Context source ${artifact.artifactId} bytes ${artifact.offset}-${artifact.offset + artifact.returnedBytes}; more bytes remain`
          : `Retrieved archived Context source ${artifact.artifactId} through byte ${artifact.offset + artifact.returnedBytes}`,
        content: artifact.content,
        mimeType: artifact.mimeType,
        facts: {
          locator: input.locator,
          artifact_id: artifact.artifactId,
          content_hash: artifact.contentHash,
          offset: artifact.offset,
          bytes_read: artifact.returnedBytes,
          total_bytes: artifact.totalBytes,
          truncated: artifact.truncated,
          ...(artifact.nextOffset === undefined ? {} : { next_offset: artifact.nextOffset }),
          // Runtime applies the same redacted, bounded `content_excerpt`
          // projection used by read_file before this reaches the model.
          content: artifact.content,
        },
      };
    } catch (error) {
      if (context.signal?.aborted) return abortedToolResult();
      return {
        status: "failure",
        code: "artifact_read_failed",
        summary: error instanceof Error ? redactSensitiveText(error.message) : "Artifact retrieval failed",
        facts: { locator: input.locator },
      };
    }
  },
};

const listArtifactsTool: ToolDefinition<z.infer<typeof ListArtifactsInputSchema>> = {
  name: "list_artifacts",
  ...rawToolContract("list_artifacts", {
    description: "List public Artifact metadata for the current Run without reading Artifact content.",
    timeoutMs: 5_000,
    concurrencySafe: true,
    sideEffect: "read",
    callLabel: "List Run Artifacts",
    resultLabel: "Run Artifact index",
  }),
  inputSchema: ListArtifactsInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.signal?.aborted) return abortedToolResult();
    if (context.listArtifacts === undefined) {
      return {
        status: "failure",
        code: "artifact_index_unavailable",
        summary: "Artifact metadata listing is unavailable in this runtime",
      };
    }
    const refs = await context.listArtifacts();
    if (context.signal?.aborted) return abortedToolResult();
    const deduplicated = new Map<string, ArtifactRef>();
    for (const ref of refs) {
      // Defence in depth: the Host callback owns scoping, but a malformed
      // composition cannot make cross-run metadata visible through the Tool.
      if (
        ref.project_id !== context.projectId
        || ref.run_id !== context.runId
        || ref.kind === "recovery_state"
      ) continue;
      deduplicated.set(ref.artifact_id, ref);
    }
    const all = [...deduplicated.values()]
      .sort((left, right) =>
        left.created_at.localeCompare(right.created_at)
        || left.artifact_id.localeCompare(right.artifact_id))
      .map(publicArtifactMetadata);
    const artifacts = all.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + artifacts.length;
    const truncated = nextOffset < all.length;
    const facts = {
      artifacts,
      count: artifacts.length,
      total: all.length,
      offset: input.offset,
      truncated,
      ...(truncated ? { next_offset: nextOffset } : {}),
    };
    return {
      status: "success",
      code: "artifacts_listed",
      summary: `Listed ${artifacts.length} of ${all.length} public Artifact(s) for the current Run${truncated ? " (more remain)" : ""}`,
      content: JSON.stringify(facts, null, 2),
      mimeType: "application/json",
      facts,
    };
  },
};

const todoReadTool: ToolDefinition<TodoReadInput> = {
  name: "todo_read",
  ...rawToolContract("todo_read", {
    description: "Read one bounded page of the current structured Todo list. Follow next_offset until truncated is false.",
    timeoutMs: 5_000,
    concurrencySafe: true,
    sideEffect: "read",
    callLabel: "Read Todos",
    resultLabel: "Todo list",
  }),
  inputSchema: TodoReadInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.signal?.aborted) return abortedToolResult();
    if (context.todos === undefined) {
      return {
        status: "failure",
        code: "todo_store_unavailable",
        summary: "The Run Todo ledger is unavailable",
      };
    }
    try {
      const todos = TodoListSchema.parse(await context.todos.read());
      const total = todos.items.length;
      const offset = Math.min(input.offset, total);
      const requestedEnd = Math.min(total, offset + input.limit);
      let items: (typeof todos.items)[number][] = [];
      for (let index = offset; index < requestedEnd; index += 1) {
        const candidate = [...items, todos.items[index]!];
        const candidateResult = renderTodoReadPage({
          items: candidate,
          total,
          offset,
          limit: input.limit,
          lastSequence: todos.last_sequence,
        });
        if (!todoReadPageFits(candidateResult)) {
          if (items.length === 0) {
            return {
              status: "failure",
              code: "todo_item_exceeds_read_page",
              summary: `Todo ${todos.items[index]!.todo_id} cannot fit in one bounded read page`,
              facts: {
                todo_id: todos.items[index]!.todo_id,
                todo_count: total,
                offset,
                limit: input.limit,
              },
            };
          }
          break;
        }
        items = candidate;
      }
      return renderTodoReadPage({
        items,
        total,
        offset,
        limit: input.limit,
        lastSequence: todos.last_sequence,
      });
    } catch (error) {
      return todoToolFailure(error);
    }
  },
};

function renderTodoReadPage(input: {
  items: TodoList["items"];
  total: number;
  offset: number;
  limit: number;
  lastSequence: number;
}): RawToolResult {
  const nextOffset = input.offset + input.items.length;
  const truncated = nextOffset < input.total;
  const page = {
    items: input.items,
    total: input.total,
    returned_count: input.items.length,
    offset: input.offset,
    limit: input.limit,
    last_sequence: input.lastSequence,
    truncated,
    ...(truncated ? { next_offset: nextOffset } : {}),
  };
  const content = JSON.stringify(page, null, 2);
  return {
    status: "success",
    code: "todos_read",
    summary: `Read ${input.items.length} of ${input.total} Todo item${input.total === 1 ? "" : "s"} from offset ${input.offset}${truncated ? " (more remain)" : ""}`,
    content,
    mimeType: "application/json",
    // Runtime converts this deliberately bounded prefix into the
    // model-visible content_excerpt. The complete page is persisted as an
    // Artifact, while next_offset makes later item pages independently
    // addressable even when the whole list exceeds the Tool envelope.
    facts: {
      todo_count: input.total,
      returned_count: input.items.length,
      offset: input.offset,
      limit: input.limit,
      last_sequence: input.lastSequence,
      truncated,
      ...(truncated ? { next_offset: nextOffset } : {}),
      content: truncateUtf8(content, TODO_READ_MODEL_EXCERPT_BYTES),
    },
  };
}

function todoReadPageFits(result: RawToolResult): boolean {
  const limits = TOOL_OUTPUT_LIMITS.todo_read;
  return Buffer.byteLength(result.content ?? "", "utf8")
      <= limits.sectionBytes.content - TODO_READ_CONTENT_HEADROOM_BYTES
    && jsonBytes(result) <= limits.maxResultBytes - TODO_READ_RESULT_HEADROOM_BYTES;
}

const todoWriteTool: ToolDefinition<TodoWriteInput> = {
  name: "todo_write",
  ...rawToolContract("todo_write", {
    description: "Create or update one structured Todo in this Run's canonical event ledger.",
    timeoutMs: 5_000,
    // Ledger writes retain command order even though they do not mutate the
    // Workspace and therefore have side_effect=none for permission policy.
    concurrencySafe: false,
    sideEffect: "none",
    callLabel: "Update Todo",
    resultLabel: "Todo update",
  }),
  inputSchema: TodoWriteInputSchema,
  capability: "read",
  requiresApproval: false,
  async execute(input, context) {
    if (context.signal?.aborted) return abortedToolResult();
    if (context.todos === undefined) {
      return {
        status: "failure",
        code: "todo_store_unavailable",
        summary: "The Run Todo ledger is unavailable",
      };
    }
    try {
      const mutation = TodoMutationResultSchema.parse(await context.todos.write(input));
      return {
        status: "success",
        code: mutation.event_type,
        summary: mutation.event_type === "todo.created"
          ? "Created Todo"
          : mutation.event_type === "todo.completed"
            ? "Completed Todo"
            : mutation.event_type === "todo.blocked"
              ? "Blocked Todo"
              : "Updated Todo",
        content: JSON.stringify(mutation.todo, null, 2),
        mimeType: "application/json",
        facts: {
          todo_id: mutation.todo.todo_id,
          state: mutation.todo.state,
          event_id: mutation.event_id,
          event_type: mutation.event_type,
          last_sequence: mutation.last_sequence,
        },
      };
    } catch (error) {
      return todoToolFailure(error);
    }
  },
};

function publicArtifactMetadata(ref: ArtifactRef): PublicArtifactMetadata {
  return PublicArtifactMetadataSchema.parse({
    artifact_id: ref.artifact_id,
    locator: `artifact:${ref.artifact_id}`,
    kind: ref.kind,
    content_hash: ref.content_hash,
    mime_type: ref.mime_type,
    byte_length: ref.byte_length,
    created_at: ref.created_at,
  });
}

function createListDirTool(
  limits: Readonly<FileToolLimits>,
  nowMs: () => number,
): ToolDefinition<z.infer<typeof ListDirInputSchema>> {
  return {
    name: "list_dir",
    ...rawToolContract("list_dir", {
      description: "List a bounded, non-sensitive portion of a Workspace directory tree.",
      timeoutMs: Math.max(10, limits.deadlineMs),
      concurrencySafe: true,
      sideEffect: "read",
      callLabel: "List directory",
      resultLabel: "Directory listing",
    }),
    inputSchema: ListDirInputSchema,
    capability: "read",
    requiresApproval: false,
    async execute(input, context) {
      if (isSensitiveWorkspacePath(input.path)) return sensitiveFileResult(input.path);
      if (context.signal?.aborted) return abortedToolResult();
      const directoryPath = await resolveWorkspacePath(context.workspace, input.path);
      const canonicalRelativePath = relative(context.workspace.real_root, directoryPath) || ".";
      if (isSensitiveWorkspacePath(canonicalRelativePath)) return sensitiveFileResult(input.path);
      const startedAt = nowMs();
      const entries: Array<{ path: string; type: "file" | "directory" }> = [];
      const walk = async (path: string, depth: number): Promise<void> => {
        if (context.signal?.aborted) throw abortReason(context.signal);
        if (entries.length >= limits.maxMatches || nowMs() - startedAt >= limits.deadlineMs) return;
        const directory = await opendir(path);
        try {
          for await (const entry of directory) {
            if (entries.length >= limits.maxMatches || nowMs() - startedAt >= limits.deadlineMs) return;
            if (ignoredWorkspaceEntry(entry.name)) continue;
            const child = resolve(path, entry.name);
            const childRelative = relative(context.workspace.real_root, child);
            if (isSensitiveWorkspacePath(childRelative)) continue;
            if (entry.isDirectory()) {
              entries.push({ path: childRelative, type: "directory" });
              if (depth < input.depth) await walk(child, depth + 1);
            } else if (entry.isFile()) {
              entries.push({ path: childRelative, type: "file" });
            }
          }
        } finally {
          await directory.close().catch(() => undefined);
        }
      };
      try {
        await walk(directoryPath, 0);
      } catch (error) {
        if (context.signal?.aborted) return abortedToolResult();
        throw error;
      }
      entries.sort((left, right) => left.path.localeCompare(right.path));
      const incomplete = entries.length >= limits.maxMatches || nowMs() - startedAt >= limits.deadlineMs;
      return {
        status: "success",
        code: "directory_listed",
        summary: `Listed ${entries.length} entr${entries.length === 1 ? "y" : "ies"} under ${canonicalRelativePath}${incomplete ? " (partial)" : ""}`,
        content: JSON.stringify(entries, null, 2),
        mimeType: "application/json",
        facts: { path: canonicalRelativePath, entries, incomplete, limits: publicFileLimits(limits) },
      };
    },
  };
}

export function validateToolCall(input: {
  call: ToolCall;
  registry: ToolRegistry;
  projectId: string;
  runId: string;
  workspace: WorkspaceHandle;
  mode: RunMode;
  sandboxMode: SandboxMode;
  now: Date;
  approvalId?: string;
  approvalTokenId?: string;
  actionDigest?: string;
  policyDigest?: string;
  /** Runtime policy engine already evaluated every hard constraint. */
  policyPrevalidated?: boolean;
}): { action: ValidatedAction; parsedInput: unknown; definition: ToolDefinition } {
  const call = ToolCallSchema.parse(input.call);
  const definition = input.registry.get(call.tool_name);
  if (definition === undefined) {
    throw new ActionRejectedError("tool_not_registered", `Tool ${call.tool_name} is not registered`);
  }
  const parsedInput = definition.inputSchema.safeParse(call.arguments);
  if (!parsedInput.success) {
    throw new ActionRejectedError("schema_invalid", parsedInput.error.message);
  }
  // Run-scoped Artifact/Todo tools never touch the Workspace filesystem.
  // Plain Chat intentionally has no workspace-read capability but must still
  // be able to use its own canonical Run state.
  if (input.policyPrevalidated !== true) {
    if (
      call.tool_name !== "read_artifact"
      && call.tool_name !== "list_artifacts"
      && call.tool_name !== "todo_read"
      && call.tool_name !== "todo_write"
      && !input.workspace.capabilities[definition.capability]
    ) {
      throw new ActionRejectedError("capability_denied", `${definition.capability} is disabled by WorkspaceHandle`);
    }
    if (input.mode === "plan" && !planModeDefinitionAllowed(definition)) {
      throw new ActionRejectedError("plan_mode_denied", `${call.tool_name} is not available in plan mode`);
    }
    if (input.sandboxMode === "read-only" && definition.sideEffect === "write") {
      throw new ActionRejectedError(
        "sandbox_denied",
        `${call.tool_name} cannot write while the Host sandbox mode is read-only`,
      );
    }
    if (definition.requiresApproval && input.approvalId === undefined) {
      throw new ActionRejectedError("approval_required", `${call.tool_name} requires a one-time approval`);
    }
  }
  return {
    definition,
    parsedInput: parsedInput.data,
    action: ValidatedActionSchema.parse({
      action_id: call.action_id,
      tool_name: call.tool_name,
      arguments: call.arguments,
      project_id: input.projectId,
      run_id: input.runId,
      workspace_handle_id: input.workspace.handle_id,
      validated_at: input.now.toISOString(),
      ...(input.approvalId === undefined ? {} : { approval_id: input.approvalId }),
      ...(input.approvalTokenId === undefined ? {} : { approval_token_id: input.approvalTokenId }),
      ...(input.actionDigest === undefined ? {} : { action_digest: input.actionDigest }),
      ...(input.policyDigest === undefined ? {} : { policy_digest: input.policyDigest }),
    }),
  };
}

function planModeDefinitionAllowed(definition: ToolDefinition): boolean {
  if (definition.name === "todo_write") return definition.sideEffect === "none";
  return [
    "read_file",
    "list_dir",
    "search",
    "read_artifact",
    "list_artifacts",
    "todo_read",
  ].includes(definition.name)
    && (definition.sideEffect === "none" || definition.sideEffect === "read")
    && (definition.capability === "read" || definition.capability === "search");
}

function createReadFileTool(
  limits: Readonly<FileToolLimits>,
  nowMs: () => number,
): ToolDefinition<z.infer<typeof ReadFileInputSchema>> {
  return {
    name: "read_file",
    ...rawToolContract("read_file", {
      description: "Read one bounded, non-sensitive UTF-8 file from the Workspace.",
      timeoutMs: Math.max(10, limits.deadlineMs),
      concurrencySafe: true,
      sideEffect: "read",
      callLabel: "Read file",
      resultLabel: "File contents",
    }),
    inputSchema: ReadFileInputSchema,
    capability: "read",
    requiresApproval: false,
    async execute(input, context) {
      if (isSensitiveWorkspacePath(input.path)) return sensitiveFileResult(input.path);
      if (context.signal?.aborted) return abortedToolResult();
      const path = await resolveWorkspacePath(context.workspace, input.path);
      const canonicalRelativePath = relative(context.workspace.real_root, path);
      if (isSensitiveWorkspacePath(canonicalRelativePath)) return sensitiveFileResult(input.path);
      const startedAt = nowMs();
      try {
        const bounded = await readBoundedUtf8(path, limits.maxFileBytes, context.signal);
        if (nowMs() - startedAt >= limits.deadlineMs) {
          return {
            status: "failure",
            code: "read_deadline_exceeded",
            summary: `Reading ${input.path} exceeded the ${limits.deadlineMs}ms deadline`,
            facts: { path: input.path, limits: publicFileLimits(limits) },
          };
        }
        return {
          status: "success",
          code: "file_read",
          summary: bounded.truncated
            ? `Read the first ${bounded.bytesRead} byte(s) of ${input.path}`
            : `Read ${input.path}`,
          content: bounded.content,
          mimeType: "text/plain",
          facts: {
            path: input.path,
            content: bounded.content,
            bytes_read: bounded.bytesRead,
            truncated: bounded.truncated,
            limits: publicFileLimits(limits),
          },
        };
      } catch (error) {
        if (context.signal?.aborted) return abortedToolResult();
        throw error;
      }
    },
  };
}

function createSearchTool(
  limits: Readonly<FileToolLimits>,
  nowMs: () => number,
): ToolDefinition<z.infer<typeof SearchInputSchema>> {
  return {
    name: "search",
    ...rawToolContract("search", {
      description: "Search bounded non-sensitive Workspace text for a literal pattern.",
      timeoutMs: Math.max(10, limits.deadlineMs),
      concurrencySafe: true,
      sideEffect: "read",
      callLabel: "Search Workspace",
      resultLabel: "Search results",
    }),
    inputSchema: SearchInputSchema,
    capability: "search",
    requiresApproval: false,
    async execute(input, context) {
      try {
        const search = await searchWorkspace({
          root: context.workspace.real_root,
          pattern: input.pattern,
          limits,
          nowMs,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        const suffix = search.limitReasons.length === 0
          ? ""
          : ` (partial: ${search.limitReasons.join(", ")})`;
        const summary = search.matches.length === 0
          ? `No matches for ${input.pattern}; broaden the query or inspect the repository structure${suffix}`
          : `Found ${search.matches.length} match(es) for ${input.pattern}${suffix}`;
        return {
          status: "success",
          code: "search_completed",
          summary,
          content: JSON.stringify(search.matches, null, 2),
          mimeType: "application/json",
          facts: {
            matches: search.matches,
            first_match_path: search.matches[0]?.path,
            files_scanned: search.filesScanned,
            bytes_scanned: search.bytesScanned,
            incomplete: search.limitReasons.length > 0,
            limit_reasons: search.limitReasons,
            limits: publicFileLimits(limits),
          },
        };
      } catch (error) {
        if (context.signal?.aborted) return abortedToolResult();
        throw error;
      }
    },
  };
}

const previewPatchTool: ToolDefinition<z.infer<typeof PatchInputSchema>> = {
  name: "preview_patch",
  ...rawToolContract("preview_patch", {
    description: "Create a deterministic patch preview and hashes without modifying the Workspace.",
    timeoutMs: 10_000,
    concurrencySafe: false,
    sideEffect: "read",
    callLabel: "Preview patch",
    resultLabel: "Patch preview",
  }),
  inputSchema: PatchInputSchema,
  capability: "preview_patch",
  requiresApproval: false,
  async execute(input, context) {
    if (context.signal?.aborted) return abortedToolResult();
    if (isSensitiveWorkspacePath(input.path)) return sensitiveFileResult(input.path);
    const target = await resolvePatchTarget(context.workspace, input.path);
    const path = target.path;
    const before = target.exists
      ? await readFile(path, { encoding: "utf8", ...(context.signal === undefined ? {} : { signal: context.signal }) })
      : "";
    if (context.signal?.aborted) return abortedToolResult();
    if (!target.exists && input.expected !== "") {
      return { status: "failure", code: "patch_target_missing", summary: `${input.path} does not exist; use an empty expected value to create it` };
    }
    if (target.exists && input.expected === "") {
      return { status: "failure", code: "patch_anchor_empty", summary: `An empty patch anchor is only allowed when creating a new file` };
    }
    const occurrences = target.exists ? before.split(input.expected).length - 1 : 1;
    if (occurrences !== 1) {
      return {
        status: "failure",
        code: "patch_anchor_mismatch",
        summary: `Expected exactly one patch anchor in ${input.path}, found ${occurrences}`,
      };
    }
    const after = target.exists ? before.replace(input.expected, input.replacement) : input.replacement;
    if (after === before) {
      return {
        status: "failure",
        code: "patch_no_change",
        summary: `${input.path} would not change`,
      };
    }
    const diff = target.exists
      ? createSimpleDiff(input.path, input.expected, input.replacement)
      : createNewFileDiff(input.path, input.replacement);
    if (redactSensitiveText(diff) !== diff) {
      return {
        status: "failure",
        code: "patch_sensitive_content",
        summary: "Patch preview contains sensitive or local-path content that cannot be shown exactly",
      };
    }
    return {
      status: "success",
      code: "patch_preview_created",
      summary: `Prepared patch preview for ${input.path}`,
      content: diff,
      mimeType: "text/x-diff",
      facts: {
        path: input.path,
        diff,
        base_hash: sha256(before),
        patch_hash: sha256(after),
        scope: [input.path],
      },
    };
  },
};

const commitPatchTool: ToolDefinition<z.infer<typeof CommitPatchInputSchema>> = {
  name: "commit_patch",
  ...rawToolContract("commit_patch", {
    description: "Apply an approved, hash-bound patch through the durable mutation boundary.",
    timeoutMs: 15_000,
    concurrencySafe: false,
    sideEffect: "write",
    callLabel: "Apply approved patch",
    resultLabel: "Applied patch",
  }),
  inputSchema: CommitPatchInputSchema,
  capability: "commit_patch",
  requiresApproval: true,
  async execute(input, context) {
    if (context.signal?.aborted) return abortedToolResult();
    if (isSensitiveWorkspacePath(input.path)) return sensitiveFileResult(input.path);
    const target = await resolvePatchTarget(context.workspace, input.path);
    const path = target.path;
    const before = target.exists
      ? await readFile(path, { encoding: "utf8", ...(context.signal === undefined ? {} : { signal: context.signal }) })
      : "";
    if (context.signal?.aborted) return abortedToolResult();
    if (sha256(before) !== input.base_hash) {
      return { status: "failure", code: "stale_base", summary: `${input.path} changed after approval` };
    }
    if (target.exists && input.expected === "") {
      return { status: "failure", code: "patch_anchor_empty", summary: "Approved new-file patch now targets an existing file" };
    }
    if (!target.exists && input.expected !== "") {
      return { status: "failure", code: "patch_target_missing", summary: "Patch target disappeared after approval" };
    }
    const occurrences = target.exists ? before.split(input.expected).length - 1 : 1;
    if (occurrences !== 1) {
      return { status: "failure", code: "patch_anchor_mismatch", summary: "Patch anchor is no longer unique" };
    }
    const after = target.exists ? before.replace(input.expected, input.replacement) : input.replacement;
    if (sha256(after) !== input.patch_hash) {
      return { status: "failure", code: "patch_hash_mismatch", summary: "Approved patch hash does not match" };
    }
    const snapshot = {
      relativePath: input.path,
      absolutePath: path,
      existed: target.exists,
      before,
      after,
      beforeHash: input.base_hash,
      afterHash: input.patch_hash,
    };
    await context.patchMutation?.prepare(snapshot);
    // Cancellation remains safe through WAL prepare: no external mutation has
    // happened yet. Check once more before preparing the durable temp file.
    if (context.signal?.aborted) return abortedToolResult();
    const temporary = resolve(
      dirname(path),
      `.${basename(path)}.tracegraph-${process.pid}-${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(after, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (context.signal?.aborted) return abortedToolResult();
      // No await may appear between this final signal check and arming the
      // fence. Cancellation after this line must wait for rename + applied WAL.
      context.cancellationShield?.arm();
      await rename(temporary, path);
      await syncDirectory(dirname(path));
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
    await context.patchMutation?.applied(snapshot);
    return {
      status: "success",
      code: "patch_committed",
      summary: `Applied approved patch to ${input.path}`,
      content: target.exists
        ? createSimpleDiff(input.path, input.expected, input.replacement)
        : createNewFileDiff(input.path, input.replacement),
      mimeType: "text/x-diff",
      facts: { path: input.path, base_hash: input.base_hash, patch_hash: input.patch_hash },
    };
  },
};

async function syncDirectory(path: string): Promise<void> {
  // Directory fsync is the POSIX durability boundary for the rename. Windows
  // does not expose equivalent directory handles through Node's portable API.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const runTestTool: ToolDefinition<z.infer<typeof RunTestInputSchema>> = {
  name: "run_test",
  ...rawToolContract("run_test", {
    description: "Run the bounded fixture test suite in a process group that is reclaimed on stop or timeout.",
    timeoutMs: 15_000,
    concurrencySafe: false,
    sideEffect: "execute",
    callLabel: "Run fixture tests",
    resultLabel: "Fixture test result",
  }),
  inputSchema: RunTestInputSchema,
  capability: "test",
  requiresApproval: false,
  async execute(_input, context) {
    const testEntry = await resolveWorkspacePath(context.workspace, "test/run.mjs");
    const sandboxRunner = context.sandboxRunner ?? createSandboxRunner();
    const sandboxMode = context.sandboxMode ?? "workspace-write";
    const result = await sandboxRunner.run({
      mode: sandboxMode,
      workspaceRoot: context.workspace.real_root,
      cwd: context.workspace.real_root,
      executable: process.execPath,
      args: [testEntry],
      timeoutMs: 15_000,
      maxOutputBytes: 64_000,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const code = result.aborted
      ? "tool_aborted"
      : result.timedOut
        ? "timeout"
        : result.truncated
          ? "test_output_limit"
          : !result.started || result.failureCode === "sandbox_unavailable"
            ? "sandbox_unavailable"
            : result.exitCode === 0
              ? "tests_passed"
              : "tests_failed";
    const success = code === "tests_passed";
    return {
      status: success ? "success" : "failure",
      code,
      summary: success
        ? "Fixture tests passed"
        : result.aborted
          ? "Fixture tests were stopped"
          : result.timedOut
            ? "Fixture tests exceeded the 15000ms timeout"
            : result.truncated
              ? "Fixture test output exceeded the 64000 byte limit"
              : code === "sandbox_unavailable"
                ? "Fixture tests were not started because sandbox enforcement is unavailable"
                : `Fixture tests failed with exit ${result.exitCode}`,
      content: `${result.stdout}${result.stderr}`,
      mimeType: "text/plain",
      facts: {
        suite: "fixture",
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        output_truncated: result.truncated,
        aborted: result.aborted,
        started: result.started,
        sandbox_report: result.sandboxReport,
      },
    };
  },
};

interface SearchWorkspaceResult {
  matches: Array<{ path: string; line: number; text: string }>;
  filesScanned: number;
  bytesScanned: number;
  limitReasons: string[];
}

async function searchWorkspace(input: {
  root: string;
  pattern: string;
  limits: Readonly<FileToolLimits>;
  nowMs: () => number;
  signal?: AbortSignal;
}): Promise<SearchWorkspaceResult> {
  const matches: SearchWorkspaceResult["matches"] = [];
  const limitReasons = new Set<string>();
  const startedAt = input.nowMs();
  let filesScanned = 0;
  let bytesScanned = 0;

  const shouldStop = (): boolean => {
    if (input.signal?.aborted) throw abortReason(input.signal);
    if (input.nowMs() - startedAt >= input.limits.deadlineMs) {
      limitReasons.add("deadline");
      return true;
    }
    if (filesScanned >= input.limits.maxFiles) {
      limitReasons.add("max_files");
      return true;
    }
    if (bytesScanned >= input.limits.maxBytes) {
      limitReasons.add("max_bytes");
      return true;
    }
    if (matches.length >= input.limits.maxMatches) {
      limitReasons.add("max_matches");
      return true;
    }
    return false;
  };

  const walk = async (directoryPath: string, depth: number): Promise<void> => {
    if (shouldStop()) return;
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) {
        if (shouldStop()) return;
        if (ignoredWorkspaceEntry(entry.name)) continue;
        const path = resolve(directoryPath, entry.name);
        const workspaceRelativePath = relative(input.root, path);
        if (isSensitiveWorkspacePath(workspaceRelativePath)) continue;
        if (entry.isDirectory()) {
          if (depth >= input.limits.maxDepth) {
            limitReasons.add("max_depth");
          } else {
            await walk(path, depth + 1);
          }
          continue;
        }
        if (!entry.isFile()) continue;

        filesScanned += 1;
        const remainingTotalBytes = input.limits.maxBytes - bytesScanned;
        const allowedBytes = Math.min(input.limits.maxFileBytes, remainingTotalBytes);
        if (allowedBytes <= 0) {
          limitReasons.add("max_bytes");
          return;
        }
        let bounded: BoundedTextRead | undefined;
        try {
          bounded = await readBoundedUtf8(path, allowedBytes, input.signal);
        } catch (error) {
          if (input.signal?.aborted) throw error;
          // Races with editors, unreadable files and device files are ignored.
          continue;
        }
        bytesScanned += bounded.bytesRead;
        if (bounded.truncated) {
          limitReasons.add(
            allowedBytes < input.limits.maxFileBytes ? "max_bytes" : "max_file_bytes",
          );
        }
        if (bounded.content.includes("\0")) continue;
        for (const [index, line] of bounded.content.split("\n").entries()) {
          if (!line.includes(input.pattern)) continue;
          matches.push({
            path: workspaceRelativePath,
            line: index + 1,
            text: line.slice(0, 500),
          });
          if (matches.length >= input.limits.maxMatches) break;
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };

  await walk(input.root, 0);
  if (input.signal?.aborted) throw abortReason(input.signal);
  if (input.nowMs() - startedAt >= input.limits.deadlineMs) {
    limitReasons.add("deadline");
  }
  return {
    matches,
    filesScanned,
    bytesScanned,
    limitReasons: [...limitReasons].sort(),
  };
}

interface BoundedTextRead {
  content: string;
  bytesRead: number;
  truncated: boolean;
}

async function readBoundedUtf8(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedTextRead> {
  if (signal?.aborted) throw abortReason(signal);
  const handle = await open(path, "r");
  try {
    if (signal?.aborted) throw abortReason(signal);
    // The extra byte detects truncation without ever materializing the full file.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (signal?.aborted) throw abortReason(signal);
    const visibleBytes = Math.min(bytesRead, maxBytes);
    return {
      content: buffer.subarray(0, visibleBytes).toString("utf8"),
      bytesRead: visibleBytes,
      truncated: bytesRead > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

function ignoredWorkspaceEntry(name: string): boolean {
  return [".git", ".ssh", ".aws", ".gnupg", "node_modules", "dist", ".tracegraph"].includes(name);
}

function normalizeFileToolLimits(overrides: Partial<FileToolLimits> | undefined): Readonly<FileToolLimits> {
  const limits = { ...DEFAULT_FILE_TOOL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const minimum = name === "maxDepth" ? 0 : 1;
    const maximum = FILE_TOOL_LIMIT_CEILINGS[name as keyof FileToolLimits];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
    }
  }
  return Object.freeze(limits);
}

function publicFileLimits(limits: Readonly<FileToolLimits>): Record<string, number> {
  return {
    max_file_bytes: limits.maxFileBytes,
    max_files: limits.maxFiles,
    max_bytes: limits.maxBytes,
    max_depth: limits.maxDepth,
    deadline_ms: limits.deadlineMs,
    max_matches: limits.maxMatches,
  };
}

function createSimpleDiff(path: string, before: string, after: string): string {
  return `--- a/${path}\n+++ b/${path}\n@@\n-${before}\n+${after}\n`;
}

function createNewFileDiff(path: string, content: string): string {
  return `--- /dev/null\n+++ b/${path}\n@@\n${content.split("\n").map((line) => `+${line}`).join("\n")}\n`;
}

export async function resolvePatchTarget(
  workspace: WorkspaceHandle,
  workspaceRelativePath: string,
): Promise<{ path: string; exists: boolean }> {
  try {
    return { path: await resolveWorkspacePath(workspace, workspaceRelativePath), exists: true };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
    const candidate = resolve(workspace.real_root, workspaceRelativePath);
    assertInside(workspace.real_root, candidate);
    const canonicalParent = await realpath(dirname(candidate));
    assertInside(workspace.real_root, canonicalParent);
    return { path: resolve(canonicalParent, basename(candidate)), exists: false };
  }
}

export type ProcessResult = BoundedProcessResult;

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<ProcessResult> {
  return runBoundedProcess(executable, args, options);
}

const sensitiveBasenames = new Set([
  ".env",
  ".aws",
  ".gnupg",
  ".netrc",
  ".npmrc",
  ".ssh",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

export function isSensitiveWorkspacePath(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/u).filter(Boolean);
  return segments.some((segment) =>
    sensitiveBasenames.has(segment)
    || segment.startsWith(".env.")
    || /\.(?:pem|key|p12|pfx)$/u.test(segment),
  );
}

function sensitiveFileResult(path: string): RawToolResult {
  return {
    status: "failure",
    code: "sensitive_file_blocked",
    summary: `Reading sensitive credential file ${path} is blocked by policy`,
  };
}

function abortedToolResult(): RawToolResult {
  return { status: "failure", code: "tool_aborted", summary: "Tool execution was stopped" };
}

function todoToolFailure(error: unknown): RawToolResult {
  if (!(error instanceof TodoDomainError)) {
    return { status: "failure", code: "todo_internal", summary: "Todo operation failed" };
  }
  return {
    status: "failure",
    code: error.code,
    summary: redactSensitiveText(error.message),
    facts: {
      ...(error.todoId === undefined ? {} : { todo_id: error.todoId }),
      ...(error.dependencyId === undefined ? {} : { dependency_id: error.dependencyId }),
      ...(error.evidenceEventId === undefined ? {} : { evidence_event_id: error.evidenceEventId }),
      ...(error.cyclePath === undefined ? {} : { cycle_path: error.cyclePath }),
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

export class ActionRejectedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ActionRejectedError";
  }
}

export async function executeToolDefinition<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
  parsedInput: unknown,
  context: ToolExecutionContext,
): Promise<RawToolResult> {
  if (definition.maxResultBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES) {
    throw new RangeError(`maxResultBytes must be at least ${MIN_TOOL_RESULT_ENVELOPE_BYTES}`);
  }
  if (context.signal?.aborted) return abortedToolResult();
  let frozenInput: TInput;
  try {
    frozenInput = deepFreeze(parsedInput) as TInput;
  } catch {
    return internalToolResult(definition.name);
  }

  const timeoutSignal = AbortSignal.timeout(definition.timeoutMs);
  const signal = context.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([context.signal, timeoutSignal]);
  const cancellationIsShielded = () => context.cancellationShield?.isArmed() === true;
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      // Once an irreversible mutation is fenced, cancellation is observed by
      // the caller only after Tool execution and Host durability callbacks
      // settle. Rejecting this race here would orphan the still-running write.
      if (cancellationIsShielded()) return;
      reject(abortReason(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    const output = await Promise.race([
      definition.execute(frozenInput, { ...context, signal }),
      aborted,
    ]);
    if (!cancellationIsShielded()) {
      if (context.signal?.aborted) return abortedToolResult();
      if (timeoutSignal.aborted) return timedOutToolResult(definition);
    }

    const validated = definition.outputSchema.safeParse(output);
    if (!validated.success) return outputContractViolationResult(definition.name);

    let rendered: RawToolResult;
    try {
      rendered = definition.render(frozenInput, validated.data);
    } catch {
      return internalToolResult(definition.name);
    }
    const validatedRender = RawToolResultSchema.safeParse(rendered);
    if (!validatedRender.success) return internalToolResult(definition.name);
    return boundRenderedToolResult(
      validatedRender.data,
      definition.maxResultBytes,
      TOOL_OUTPUT_LIMITS[definition.name as BuiltinToolName],
    );
  } catch (error) {
    // Action WAL crash boundaries are deliberately not ordinary Tool errors.
    // Runtime must observe them so startup reconciliation can classify the
    // exact before/after/diverged state instead of recording a false failure.
    if (context.isHostBoundaryError?.(error) === true) throw error;
    if (error instanceof ActionRejectedError) {
      return {
        status: "failure",
        code: error.code,
        summary: error.message,
      };
    }
    if (!cancellationIsShielded()) {
      if (context.signal?.aborted) return abortedToolResult();
      if (timeoutSignal.aborted) return timedOutToolResult(definition);
    }
    return internalToolResult(definition.name);
  } finally {
    removeAbortListener();
  }
}

function timedOutToolResult(definition: ToolDefinition<unknown, unknown>): RawToolResult {
  return {
    status: "failure",
    code: "timeout",
    summary: `Tool ${definition.name} exceeded its ${definition.timeoutMs}ms timeout`,
    facts: { timeout_ms: definition.timeoutMs },
  };
}

function outputContractViolationResult(name: ToolName): RawToolResult {
  return {
    status: "failure",
    code: "output_contract_violation",
    summary: `Tool ${name} returned output that did not satisfy its declared contract`,
  };
}

function internalToolResult(name: ToolName): RawToolResult {
  return {
    status: "failure",
    code: "internal",
    summary: `Tool ${name} failed inside its execution boundary`,
  };
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function boundRenderedToolResult(
  result: RawToolResult,
  requestedMaxBytes: number,
  configured?: ToolOutputLimit,
): RawToolResult {
  const maxResultBytes = Math.max(256, Math.min(
    requestedMaxBytes,
    configured?.maxResultBytes ?? requestedMaxBytes,
  ));
  const summaryLimit = configured?.sectionBytes.summary ?? Math.min(2_000, maxResultBytes);
  const contentLimit = configured?.sectionBytes.content ?? maxResultBytes;
  const factsLimit = configured?.sectionBytes.facts ?? maxResultBytes;
  let bounded: RawToolResult = {
    ...result,
    summary: truncateUtf8(result.summary, summaryLimit),
    ...(result.content === undefined
      ? {}
      : { content: truncateUtf8(result.content, contentLimit) }),
    ...(result.facts === undefined
      ? {}
      : { facts: boundFacts(result.facts, factsLimit) }),
  };
  if (jsonBytes(bounded) <= maxResultBytes) return bounded;

  if (bounded.content !== undefined) {
    const withoutContent = { ...bounded };
    delete withoutContent.content;
    const remaining = Math.max(0, maxResultBytes - jsonBytes(withoutContent) - 64);
    bounded = remaining === 0
      ? withoutContent
      : { ...bounded, content: truncateUtf8(bounded.content, remaining) };
  }
  if (jsonBytes(bounded) <= maxResultBytes) return markOutputTruncated(bounded, maxResultBytes);

  if (bounded.facts !== undefined) {
    const withoutFacts = { ...bounded };
    delete withoutFacts.facts;
    const remaining = Math.max(32, maxResultBytes - jsonBytes(withoutFacts) - 32);
    bounded = { ...bounded, facts: boundFacts(bounded.facts, remaining) };
  }
  if (jsonBytes(bounded) <= maxResultBytes) return markOutputTruncated(bounded, maxResultBytes);

  delete bounded.content;
  bounded.facts = { output_truncated: true };
  if (jsonBytes(bounded) <= maxResultBytes) return bounded;

  bounded.summary = truncateUtf8(bounded.summary, Math.max(1, Math.floor(maxResultBytes / 3)));
  if (jsonBytes(bounded) <= maxResultBytes) return bounded;
  return {
    status: bounded.status,
    code: truncateUtf8(bounded.code, 64),
    summary: "Tool output exceeded its configured result limit",
    facts: { output_truncated: true },
  };
}

function markOutputTruncated(result: RawToolResult, maxBytes: number): RawToolResult {
  const marked = {
    ...result,
    facts: { ...(result.facts ?? {}), output_truncated: true },
  };
  return jsonBytes(marked) <= maxBytes ? marked : result;
}

function boundFacts(facts: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (jsonBytes(facts) <= maxBytes) return facts;
  const bounded: Record<string, unknown> = { output_truncated: true };
  for (const key of Object.keys(facts).sort()) {
    const value = boundFactValue(facts[key], 0);
    const candidate = { ...bounded, [key]: value };
    if (jsonBytes(candidate) <= maxBytes) bounded[key] = value;
  }
  return bounded;
}

function boundFactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncateUtf8(value, 4_000);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 6) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => boundFactValue(item, depth + 1));
    if (value.length > items.length) items.push(`[${value.length - items.length} more item(s)]`);
    return items;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().slice(0, 100)
        .map((key) => [key, boundFactValue(value[key], depth + 1)]),
    );
  }
  return "[unsupported value]";
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const marker = Buffer.from("\n...[truncated]", "utf8");
  if (maxBytes <= marker.byteLength) return marker.subarray(0, maxBytes).toString("utf8");
  let end = maxBytes - marker.byteLength;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker.toString("utf8")}`;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
