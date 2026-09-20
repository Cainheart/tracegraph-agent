import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BUILTIN_PERMISSION_PRESETS,
  DEFAULT_PERMISSION_PRESET_KEY,
  PermissionPresetKeySchema,
  PermissionPresetSchema,
  PermissionSettingsResponseSchema,
  PolicyDocumentSchema,
  SandboxModeSchema,
  type EffectivePermissionPolicy,
  type PermissionPreset,
  type PermissionPresetKey,
  type PermissionSettingsResponse,
  type PolicyDocument,
  type SandboxMode,
} from "@tracegraph/contracts";
import { createEffectivePermissionPolicy } from "@tracegraph/core";

export const HARNESS_PERMISSION_CONFIG_VERSION = 1 as const;
export const MAX_PERMISSION_CONFIG_BYTES = 64 * 1024;

export class PermissionCeilingError extends TypeError {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "PermissionCeilingError";
  }
}

const ORDERED_BUILTIN_KEYS = ["read-only", "workspace-write", "full-write"] as const;
type ConfigurablePresetKey = (typeof ORDERED_BUILTIN_KEYS)[number];

const PRESET_RANK: Readonly<Record<ConfigurablePresetKey, number>> = {
  "read-only": 0,
  "workspace-write": 1,
  "full-write": 2,
};

const LEGACY_SANDBOX_PRESET: Readonly<Record<SandboxMode, ConfigurablePresetKey>> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  "danger-full-access": "full-write",
};

const BUILTIN_PRESET_BY_KEY = new Map<PermissionPresetKey, PermissionPreset>(
  Object.values(BUILTIN_PERMISSION_PRESETS).map((preset) => {
    const parsed = PermissionPresetSchema.parse(preset);
    return [parsed.key, parsed] as const;
  }),
);

export type PermissionCeilingSource =
  | "cli"
  | "environment"
  | "legacy_cli"
  | "legacy_environment"
  | "default";

export type PermissionSelectionSource = PermissionCeilingSource | "user";

export interface PermissionConfigurationSnapshot {
  readonly ceiling_preset_key: ConfigurablePresetKey;
  readonly selected_preset_key: ConfigurablePresetKey;
  readonly ceiling_source: PermissionCeilingSource;
  readonly selection_source: PermissionSelectionSource;
  readonly selectable_preset_keys: readonly ConfigurablePresetKey[];
  readonly selected_preset: PermissionPreset;
}

export interface PermissionConfigControllerOptions {
  /** Host-private user configuration, normally ~/.tracegraph/harness-config.json. */
  userConfigPath: string;
  permissionPresetFlag?: string;
  /** Compatibility input for the existing --sandbox-mode flag. */
  sandboxModeFlag?: string;
  environment?: NodeJS.ProcessEnv;
}

interface PersistedHarnessPermissionConfig {
  config_version: typeof HARNESS_PERMISSION_CONFIG_VERSION;
  permission_preset: ConfigurablePresetKey;
}

/**
 * Host-owned permission selection and project policy resolver.
 *
 * CLI/environment values establish an immutable ceiling. The user/Web-facing
 * setter can only choose a built-in preset at or below that ceiling. A project
 * policy is deliberately a second, restriction-only layer: repository content
 * may ask or deny, but may never add an allow rule or widen the preset.
 */
export class PermissionConfigController {
  readonly #userConfigPath: string;
  readonly #ceilingKey: ConfigurablePresetKey;
  readonly #ceilingSource: PermissionCeilingSource;
  #selectedKey: ConfigurablePresetKey;
  #selectionSource: PermissionSelectionSource;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(input: {
    userConfigPath: string;
    ceilingKey: ConfigurablePresetKey;
    ceilingSource: PermissionCeilingSource;
    selectedKey: ConfigurablePresetKey;
    selectionSource: PermissionSelectionSource;
  }) {
    this.#userConfigPath = resolve(input.userConfigPath);
    this.#ceilingKey = input.ceilingKey;
    this.#ceilingSource = input.ceilingSource;
    this.#selectedKey = input.selectedKey;
    this.#selectionSource = input.selectionSource;
  }

  static async open(options: PermissionConfigControllerOptions): Promise<PermissionConfigController> {
    const environment = options.environment ?? process.env;
    const ceiling = resolvePermissionCeiling({
      ...(options.permissionPresetFlag === undefined
        ? {}
        : { permissionPresetFlag: options.permissionPresetFlag }),
      ...(options.sandboxModeFlag === undefined ? {} : { sandboxModeFlag: options.sandboxModeFlag }),
      environment,
    });
    const userConfigPath = resolve(options.userConfigPath);
    const persisted = await readHarnessPermissionConfig(userConfigPath);
    const selectedKey = persisted?.permission_preset ?? ceiling.key;
    assertAtOrBelowCeiling(selectedKey, ceiling.key);
    return new PermissionConfigController({
      userConfigPath,
      ceilingKey: ceiling.key,
      ceilingSource: ceiling.source,
      selectedKey,
      selectionSource: persisted === undefined ? ceiling.source : "user",
    });
  }

  snapshot(): PermissionConfigurationSnapshot {
    return {
      ceiling_preset_key: this.#ceilingKey,
      selected_preset_key: this.#selectedKey,
      ceiling_source: this.#ceilingSource,
      selection_source: this.#selectionSource,
      selectable_preset_keys: ORDERED_BUILTIN_KEYS.filter(
        (key) => PRESET_RANK[key] <= PRESET_RANK[this.#ceilingKey],
      ),
      selected_preset: clonePreset(requireBuiltinPreset(this.#selectedKey)),
    };
  }

  /** Persist a user/Web selection. Mutating a running Run is a Host concern. */
  async setUserPreset(value: string): Promise<PermissionConfigurationSnapshot> {
    const selectedKey = parseConfigurablePresetKey(value, "user permission preset");
    assertAtOrBelowCeiling(selectedKey, this.#ceilingKey);
    const operation = this.#writeQueue.then(async () => {
      await persistHarnessPermissionConfig(this.#userConfigPath, {
        config_version: HARNESS_PERMISSION_CONFIG_VERSION,
        permission_preset: selectedKey,
      });
      // Publish the in-memory selection only after the durable rename commits.
      this.#selectedKey = selectedKey;
      this.#selectionSource = "user";
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return this.snapshot();
  }

  /** Resolve the immutable policy snapshot to inject into a new Run. */
  async resolveProject(projectRoot: string): Promise<EffectivePermissionPolicy> {
    await this.#writeQueue;
    const document = await readProjectPolicy(projectRoot);
    // A selection may have been queued while the project file was being read.
    // Await once more, then capture the key synchronously for one coherent Run.
    await this.#writeQueue;
    const preset = clonePreset(requireBuiltinPreset(this.#selectedKey));
    return createEffectivePermissionPolicy({
      preset,
      projectRules: document.rules,
    });
  }

  /** Browser-safe view: no local paths, path scopes, rules, or Tool lists. */
  async resolveSettings(projectRoot?: string): Promise<PermissionSettingsResponse> {
    const document = projectRoot === undefined
      ? emptyPolicyDocument()
      : await readProjectPolicy(projectRoot);
    await this.#writeQueue;
    const configuration = this.snapshot();
    const policy = createEffectivePermissionPolicy({
      preset: configuration.selected_preset,
      projectRules: document.rules,
    });
    return permissionSettingsResponse(policy, configuration);
  }
}

/** Adapt an effective Host policy to the strict public settings contract. */
export function permissionSettingsResponse(
  policy: EffectivePermissionPolicy,
  configuration: PermissionConfigurationSnapshot,
): PermissionSettingsResponse {
  const availablePresets = configuration.selectable_preset_keys.map((key) => {
    const preset = requireBuiltinPreset(key);
    return {
      key,
      label: preset.label,
      sandbox_mode: preset.sandbox_mode,
      approval_policy: preset.approval_policy,
    };
  });
  const locked = availablePresets.length === 1;
  return PermissionSettingsResponseSchema.parse({
    active_preset: policy.preset.key,
    sandbox_mode: policy.preset.sandbox_mode,
    approval_policy: policy.preset.approval_policy,
    policy_digest: policy.policy_digest,
    ceiling: configuration.ceiling_preset_key,
    available_presets: availablePresets,
    source: publicSettingsSource(configuration.selection_source),
    locked,
    ...(locked
      ? { lock_reason: "The Host permission ceiling permits only read-only access" }
      : {}),
  });
}

export function resolvePermissionCeiling(input: {
  permissionPresetFlag?: string;
  sandboxModeFlag?: string;
  environment: NodeJS.ProcessEnv;
}): { key: ConfigurablePresetKey; source: PermissionCeilingSource } {
  const permissionFlag = optionalConfigValue(input.permissionPresetFlag, "--permission-preset");
  const permissionEnvironment = optionalConfigValue(
    input.environment.TRACEGRAPH_PERMISSION_PRESET,
    "TRACEGRAPH_PERMISSION_PRESET",
  );
  const permission = permissionFlag === undefined
    ? permissionEnvironment === undefined
      ? undefined
      : {
          key: parseConfigurablePresetKey(permissionEnvironment, "TRACEGRAPH_PERMISSION_PRESET"),
          source: "environment" as const,
        }
    : {
        key: parseConfigurablePresetKey(permissionFlag, "--permission-preset"),
        source: "cli" as const,
      };

  const legacyFlag = optionalConfigValue(input.sandboxModeFlag, "--sandbox-mode");
  const legacyEnvironment = optionalConfigValue(
    input.environment.TRACEGRAPH_SANDBOX_MODE,
    "TRACEGRAPH_SANDBOX_MODE",
  );
  const legacy = legacyFlag === undefined
    ? legacyEnvironment === undefined
      ? undefined
      : {
          key: legacyPreset(legacyEnvironment, "TRACEGRAPH_SANDBOX_MODE"),
          source: "legacy_environment" as const,
        }
    : {
        key: legacyPreset(legacyFlag, "--sandbox-mode"),
        source: "legacy_cli" as const,
      };

  if (permission !== undefined && legacy !== undefined && permission.key !== legacy.key) {
    throw new TypeError(
      `Permission preset ${permission.key} conflicts with legacy sandbox mode mapped to ${legacy.key}`,
    );
  }
  if (permission !== undefined) return permission;
  if (legacy !== undefined) return legacy;
  return {
    key: parseConfigurablePresetKey(DEFAULT_PERMISSION_PRESET_KEY, "default permission preset"),
    source: "default",
  };
}

export async function readHarnessPermissionConfig(
  path: string,
): Promise<PersistedHarnessPermissionConfig | undefined> {
  const value = await readBoundedJson(path, {
    label: "Harness permission configuration",
    privateFile: true,
    optional: true,
  });
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasExactKeys(value, ["config_version", "permission_preset"])) {
    throw new TypeError("Harness permission configuration must contain only config_version and permission_preset");
  }
  if (value.config_version !== HARNESS_PERMISSION_CONFIG_VERSION) {
    throw new TypeError("Harness permission configuration version is unsupported");
  }
  return {
    config_version: HARNESS_PERMISSION_CONFIG_VERSION,
    permission_preset: parseConfigurablePresetKey(
      value.permission_preset,
      "persisted permission_preset",
    ),
  };
}

export async function readProjectPolicy(projectRoot: string): Promise<PolicyDocument> {
  const canonicalRoot = await realpath(projectRoot).catch(() => {
    throw new TypeError("Project policy root is unavailable");
  });
  const policyDirectory = resolve(canonicalRoot, ".tracegraph");
  const policyPath = resolve(policyDirectory, "policy.json");
  let directoryInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryInfo = await lstat(policyDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyPolicyDocument();
    throw new TypeError("Project policy directory could not be inspected");
  }
  if (directoryInfo.isSymbolicLink()) {
    throw new TypeError("Project policy directory must not be a symlink");
  }
  if (!directoryInfo.isDirectory()) {
    throw new TypeError("Project policy directory must be a directory");
  }
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(policyDirectory);
  } catch (error) {
    throw new TypeError("Project policy directory could not be resolved");
  }
  if (canonicalDirectory !== policyDirectory) {
    throw new TypeError("Project policy directory must not be a symlink");
  }
  let policyInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    policyInfo = await lstat(policyPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyPolicyDocument();
    throw new TypeError("Project policy path could not be inspected");
  }
  if (policyInfo.isSymbolicLink()) {
    throw new TypeError("Project policy must not be a symlink");
  }
  if (!policyInfo.isFile()) {
    throw new TypeError("Project permission policy must be a regular file");
  }
  const canonicalPolicyPath = await realpath(policyPath).catch(() => {
    throw new TypeError("Project policy path could not be resolved");
  });
  const relation = relative(canonicalRoot, canonicalPolicyPath);
  if (relation.startsWith("..") || relation === "" || resolve(canonicalPolicyPath) !== canonicalPolicyPath) {
    throw new TypeError("Project policy must remain inside the canonical project root");
  }
  const value = await readBoundedJson(policyPath, {
    label: "Project permission policy",
    privateFile: false,
    optional: false,
  });
  const parsed = PolicyDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("Project permission policy does not match the strict bounded contract");
  }
  if (parsed.data.rules.some((rule) => rule.then === "allow")) {
    throw new TypeError("Project permission policy may only tighten access with ask or deny rules");
  }
  return parsed.data;
}

async function persistHarnessPermissionConfig(
  path: string,
  config: PersistedHarnessPermissionConfig,
): Promise<void> {
  const parsed: PersistedHarnessPermissionConfig = {
    config_version: HARNESS_PERMISSION_CONFIG_VERSION,
    permission_preset: parseConfigurablePresetKey(
      config.permission_preset,
      "permission_preset",
    ),
  };
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rejectSymlinkIfPresent(path, "Harness permission configuration");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_PERMISSION_CONFIG_BYTES) {
    throw new TypeError("Harness permission configuration exceeds its byte limit");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload, { encoding: "utf8" });
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readBoundedJson(
  path: string,
  options: { label: string; privateFile: boolean; optional: boolean },
): Promise<unknown | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const flags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(path, flags);
  } catch (error) {
    if (options.optional && isNodeError(error) && error.code === "ENOENT") return undefined;
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new TypeError(`${options.label} must not be a symlink`);
    }
    throw new TypeError(`${options.label} could not be opened`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TypeError(`${options.label} must be a regular file`);
    if (info.size > MAX_PERMISSION_CONFIG_BYTES) {
      throw new TypeError(`${options.label} exceeds ${MAX_PERMISSION_CONFIG_BYTES} bytes`);
    }
    if (options.privateFile && process.platform !== "win32") {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new TypeError(`${options.label} must be owned by the current user`);
      }
      if ((info.mode & 0o077) !== 0) {
        throw new TypeError(`${options.label} permissions must be 0600 or stricter`);
      }
    }
    const bytes = Buffer.alloc(MAX_PERMISSION_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_PERMISSION_CONFIG_BYTES) {
      throw new TypeError(`${options.label} exceeds ${MAX_PERMISSION_CONFIG_BYTES} bytes`);
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new TypeError(`${options.label} is not valid UTF-8`);
    }
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new TypeError(`${options.label} is invalid JSON`);
    }
  } finally {
    await handle.close();
  }
}

function emptyPolicyDocument(): PolicyDocument {
  return PolicyDocumentSchema.parse({ policy_version: 1, rules: [] });
}

function parseConfigurablePresetKey(value: unknown, label: string): ConfigurablePresetKey {
  const parsed = PermissionPresetKeySchema.safeParse(value);
  if (!parsed.success || parsed.data === "custom" || !isConfigurableKey(parsed.data)) {
    throw new TypeError(
      `${label} must be read-only, workspace-write, or full-write; custom requires Host-local policy configuration`,
    );
  }
  requireBuiltinPreset(parsed.data);
  return parsed.data;
}

function legacyPreset(value: string, label: string): ConfigurablePresetKey {
  const parsed = SandboxModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${label} must be read-only, workspace-write, or danger-full-access`);
  }
  return LEGACY_SANDBOX_PRESET[parsed.data];
}

function assertAtOrBelowCeiling(
  selected: ConfigurablePresetKey,
  ceiling: ConfigurablePresetKey,
): void {
  if (PRESET_RANK[selected] > PRESET_RANK[ceiling]) {
    throw new PermissionCeilingError(
      `Permission preset ${selected} exceeds the Host ceiling ${ceiling}`,
    );
  }
}

function requireBuiltinPreset(key: ConfigurablePresetKey): PermissionPreset {
  const preset = BUILTIN_PRESET_BY_KEY.get(key);
  if (preset === undefined) throw new TypeError(`Built-in permission preset ${key} is unavailable`);
  return preset;
}

function clonePreset(preset: PermissionPreset): PermissionPreset {
  return PermissionPresetSchema.parse(structuredClone(preset));
}

function optionalConfigValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${label} must not be empty`);
  return trimmed;
}

function publicSettingsSource(
  source: PermissionSelectionSource,
): PermissionSettingsResponse["source"] {
  if (source === "legacy_cli") return "cli";
  if (source === "legacy_environment") return "environment";
  if (source === "user") return "user-config";
  return source;
}

function isConfigurableKey(value: PermissionPresetKey): value is ConfigurablePresetKey {
  return ORDERED_BUILTIN_KEYS.includes(value as ConfigurablePresetKey);
}

async function rejectSymlinkIfPresent(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new TypeError(`${label} must not be a symlink`);
    if (!info.isFile()) throw new TypeError(`${label} must be a regular file`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
