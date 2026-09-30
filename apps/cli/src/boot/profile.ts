import { createHash } from "node:crypto";
import type {
  ExtensionStatus,
  LspConfig,
  McpConfig,
  ModelProtocol,
  ModelProvider,
  PermissionPresetKey,
  SandboxMode,
  SubagentLimits,
  SubagentProfile,
  TelemetrySink,
} from "@tracegraph/contracts";
import { CLI_PROFILE_DEFINITION } from "../profiles/cli.js";

export const CLI_RESOLVED_PROFILE_SCHEMA_VERSION = "tracegraph.resolved-cli-profile.v1" as const;

export interface ResolveCliProfileInput {
  readonly permission: {
    readonly selectedPreset: PermissionPresetKey;
    readonly sandboxMode: SandboxMode;
  };
  readonly runtime: {
    readonly maxTurns: number;
    readonly rollbackPolicy: {
      readonly enabled: boolean;
      readonly allowForce: boolean;
    };
    readonly imageInput: boolean;
  };
  readonly model: {
    readonly provider: ModelProvider;
    readonly protocol: ModelProtocol;
    readonly model: string;
  } | null;
  readonly telemetrySink: TelemetrySink;
  readonly retrievalMode: "local" | "remote_with_local_fallback";
  readonly subagents: {
    readonly profiles: readonly SubagentProfile[];
    readonly limits: SubagentLimits;
  };
  readonly mcpServers: McpConfig["servers"];
  readonly lspServers: LspConfig["servers"];
  readonly extensions: readonly ExtensionStatus[];
}

export interface ResolvedCliProfile {
  readonly schema_version: typeof CLI_RESOLVED_PROFILE_SCHEMA_VERSION;
  readonly profile_id: typeof CLI_PROFILE_DEFINITION.profile_id;
  readonly revision: typeof CLI_PROFILE_DEFINITION.revision;
  readonly surface: typeof CLI_PROFILE_DEFINITION.surface;
  readonly components: typeof CLI_PROFILE_DEFINITION.components;
  readonly selections: {
    readonly permission: {
      readonly selected_preset: PermissionPresetKey;
      readonly sandbox_mode: SandboxMode;
    };
    readonly runtime: {
      readonly max_turns: number;
      readonly rollback_policy: {
        readonly enabled: boolean;
        readonly allow_force: boolean;
      };
      readonly image_input: boolean;
    };
    readonly model: {
      readonly provider: ModelProvider;
      readonly protocol: ModelProtocol;
      readonly model: string;
    } | null;
    readonly telemetry_sink: TelemetrySink;
    readonly retrieval_mode: "local" | "remote_with_local_fallback";
    readonly subagents: {
      readonly profiles: readonly SubagentProfile[];
      readonly limits: SubagentLimits;
    };
    readonly mcp_servers: readonly {
      readonly name: string;
      readonly required: boolean;
      readonly transport: "stdio";
      readonly tool_policy: {
        readonly allow?: readonly string[];
        readonly deny?: readonly string[];
      } | null;
    }[];
    readonly lsp_servers: readonly {
      readonly name: string;
      readonly language_ids: readonly string[];
      readonly file_extensions: readonly string[];
      readonly request_timeout_ms: number;
      readonly diagnostics_wait_ms: number;
    }[];
    readonly extensions: readonly {
      readonly name: string;
      readonly api_version: string;
      readonly state: ExtensionStatus["state"];
      readonly registration_count: number;
    }[];
  };
  readonly digest: `sha256:${string}`;
}

type ResolvedCliProfileBody = Omit<ResolvedCliProfile, "digest">;

/**
 * Capture the CLI's currently resolved, non-secret startup selections.
 * This is an informational projection, not the future cross-app CompositionPlan.
 */
export function resolveCliProfile(input: ResolveCliProfileInput): ResolvedCliProfile {
  const body: ResolvedCliProfileBody = {
    schema_version: CLI_RESOLVED_PROFILE_SCHEMA_VERSION,
    ...CLI_PROFILE_DEFINITION,
    selections: {
      permission: {
        selected_preset: input.permission.selectedPreset,
        sandbox_mode: input.permission.sandboxMode,
      },
      runtime: {
        max_turns: requirePositiveSafeInteger(input.runtime.maxTurns, "runtime.maxTurns"),
        rollback_policy: {
          enabled: input.runtime.rollbackPolicy.enabled,
          allow_force: input.runtime.rollbackPolicy.allowForce,
        },
        image_input: input.runtime.imageInput,
      },
      model: input.model === null
        ? null
        : {
            provider: input.model.provider,
            protocol: input.model.protocol,
            model: requireNonEmpty(input.model.model, "model.model"),
          },
      telemetry_sink: input.telemetrySink,
      retrieval_mode: input.retrievalMode,
      subagents: {
        profiles: input.subagents.profiles.map((profile) => ({
          name: profile.name,
          provider_key: profile.provider_key,
          role_prompt_version: profile.role_prompt_version,
          role_prompt_hash: profile.role_prompt_hash,
          tool_allowlist: [...profile.tool_allowlist],
          default_budget: {
            max_steps: profile.default_budget.max_steps,
            max_tokens: profile.default_budget.max_tokens,
          },
          budget_ceiling: {
            max_steps: profile.budget_ceiling.max_steps,
            max_tokens: profile.budget_ceiling.max_tokens,
          },
        })),
        limits: {
          max_parallel_subagents: input.subagents.limits.max_parallel_subagents,
          max_depth: input.subagents.limits.max_depth,
        },
      },
      mcp_servers: input.mcpServers.map((server) => ({
        name: server.name,
        required: server.required,
        transport: server.transport,
        tool_policy: server.tool_policy === undefined
          ? null
          : {
              ...(server.tool_policy.allow === undefined ? {} : { allow: [...server.tool_policy.allow] }),
              ...(server.tool_policy.deny === undefined ? {} : { deny: [...server.tool_policy.deny] }),
            },
      })),
      lsp_servers: input.lspServers.map((server) => ({
        name: server.name,
        language_ids: [...server.language_ids],
        file_extensions: [...server.file_extensions],
        request_timeout_ms: server.request_timeout_ms,
        diagnostics_wait_ms: server.diagnostics_wait_ms,
      })),
      extensions: input.extensions.map((extension) => ({
        name: extension.name,
        api_version: extension.api_version,
        state: extension.state,
        registration_count: extension.registration_count,
      })),
    },
  };
  const digest = digestBody(body);
  return deepFreeze({ ...body, digest });
}

/** Return the digest only after verifying the profile body was not changed. */
export function hashResolvedCliProfile(profile: ResolvedCliProfile): `sha256:${string}` {
  const { digest, ...body } = profile;
  const actual = digestBody(body);
  if (digest !== actual) throw new TypeError("Resolved CLI profile digest does not match its contents");
  return actual;
}

/** Stable, redacted JSON representation suitable for local inspection. */
export function dumpResolvedCliProfile(profile: ResolvedCliProfile): string {
  hashResolvedCliProfile(profile);
  return `${JSON.stringify(profile, null, 2)}\n`;
}

function digestBody(body: ResolvedCliProfileBody): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")}`;
}

function requireNonEmpty(value: string, path: string): string {
  if (value.trim().length === 0) throw new TypeError(`${path} must be non-empty`);
  return value;
}

function requirePositiveSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${path} must be a positive safe integer`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
