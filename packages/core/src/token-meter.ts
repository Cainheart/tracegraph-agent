import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  IdentifierSchema,
  ModelUsageReportSchema,
  TOKEN_CALIBRATION_FORMAT_VERSION,
  TokenCalibrationFileSchema,
  TokenEstimateSchema,
  TokenMeterInputSchema,
  TokenUsageObservationSchema,
  type ModelUsageReport,
  type TokenCalibrationEntry,
  type TokenEstimate,
  type TokenMeterInput,
  type TokenSection,
  type TokenSectionCounts,
  type TokenUsageObservation,
} from "@tracegraph/contracts";
import { estimateTokens } from "./context.js";
import { sha256, stableStringify } from "./crypto.js";

const MAX_CALIBRATION_BYTES = 1024 * 1024;
const SECTION_ORDER = ["system", "goal", "history", "tool", "repo", "memory"] as const;

export interface TokenCounter {
  readonly estimatorId: string;
  supports(provider: string, model: string): boolean;
  /** Return null when this request is unsupported. Throwing also degrades safely. */
  countTokens(content: string): number | null;
}

export interface TokenMeter {
  initialize(): Promise<void>;
  estimate(input: TokenMeterInput): TokenEstimate;
  observeUsage(
    modelCallId: string,
    usage: ModelUsageReport,
    estimatedInputTokens: number,
  ): Promise<TokenUsageObservation>;
  /** Changes only when calibration changes; consumers may key derived caches by it. */
  revision(): number;
}

export interface CalibratedTokenMeterOptions {
  calibrationPath?: string;
  counters?: readonly TokenCounter[];
  maxSamples?: number;
  maxCacheEntries?: number;
  now?: () => Date;
}

interface CalibrationState {
  samples: Array<{ ratio: number; observed_at: string }>;
}

interface PendingEstimate {
  provider: string;
  model: string;
  estimatorId: string;
  inputTokens: number;
  calibrationRatio: number;
}

interface CountedInput {
  estimatorId: string;
  perSection: TokenSectionCounts;
  outputTokens: number;
}

export class CalibratedTokenMeter implements TokenMeter {
  readonly #path: string;
  readonly #counters: readonly TokenCounter[];
  readonly #maxSamples: number;
  readonly #maxCacheEntries: number;
  readonly #now: () => Date;
  readonly #calibrations = new Map<string, CalibrationState>();
  readonly #cache = new Map<string, TokenEstimate>();
  readonly #pending = new Map<string, PendingEstimate>();
  #revision = 0;
  #initialized = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: CalibratedTokenMeterOptions = {}) {
    const path = options.calibrationPath ?? join(homedir(), ".tracegraph", "token-calibration.json");
    if (!isAbsolute(path)) throw new TokenMeterError("calibration_path_invalid", "Token calibration path must be absolute");
    this.#path = resolve(path);
    this.#counters = [...(options.counters ?? [])];
    this.#maxSamples = boundedInteger(options.maxSamples ?? 20, 1, 100, "maxSamples");
    this.#maxCacheEntries = boundedInteger(options.maxCacheEntries ?? 512, 1, 10_000, "maxCacheEntries");
    this.#now = options.now ?? (() => new Date());
    for (const counter of this.#counters) {
      if (!counter.estimatorId.trim() || counter.estimatorId.length > 160) {
        throw new TokenMeterError("counter_invalid", "Token counter estimatorId is invalid");
      }
    }
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => this.#initialize());
  }

  revision(): number {
    return this.#revision;
  }

  estimate(inputValue: TokenMeterInput): TokenEstimate {
    const input = TokenMeterInputSchema.parse(inputValue);
    const calibrationRatio = this.#calibrationRatio(input.provider, input.model);
    const cacheKey = sha256(stableStringify({
      provider: input.provider,
      model: input.model,
      content_revision: input.content_revision,
      sections: input.sections,
      output_content: input.output_content ?? "",
      calibration_revision: this.#revision,
    }));
    let estimate = this.#cache.get(cacheKey);
    let counted: CountedInput | undefined;
    if (estimate === undefined) {
      counted = this.#count(input);
      // Counters receive auditable Context fragments, not the provider's full
      // serialized request (system wrapper, JSON envelope, message framing).
      // Provider calibration therefore applies even when fragment tokenization
      // itself is exact; claiming an exact billed-request total here would be
      // misleading.
      const perSection = scaleSections(counted.perSection, calibrationRatio);
      const inputTokens = sumSections(perSection);
      // Input calibration contains prompt framing overhead and must not be
      // reused as an output multiplier. A separate output calibration series
      // can be added when a consumer actually supplies output_content.
      const outputTokens = counted.outputTokens;
      estimate = TokenEstimateSchema.parse({
        estimator_id: counted.estimatorId,
        confidence: this.#hasCalibration(input.provider, input.model)
          ? "calibrated"
          : "estimated",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        per_section: perSection,
      });
      this.#rememberCache(cacheKey, estimate);
    }
    this.#rememberPending(input.model_call_id, {
      provider: input.provider,
      model: input.model,
      estimatorId: estimate.estimator_id,
      inputTokens: estimate.input_tokens,
      calibrationRatio,
    });
    return TokenEstimateSchema.parse(estimate);
  }

  observeUsage(
    modelCallIdValue: string,
    usageValue: ModelUsageReport,
    estimatedInputTokensValue: number,
  ): Promise<TokenUsageObservation> {
    const modelCallId = IdentifierSchema.parse(modelCallIdValue);
    const usage = ModelUsageReportSchema.parse(usageValue);
    const estimatedInputTokens = tokenCount(estimatedInputTokensValue, "estimatedInputTokens");
    return this.#serialize(async () => {
      await this.#initialize();
      const pending = this.#pending.get(modelCallId);
      if (pending !== undefined && (pending.provider !== usage.provider || pending.model !== usage.model)) {
        this.#pending.delete(modelCallId);
        throw new TokenMeterError("usage_binding_mismatch", "Provider usage does not match the estimated model call");
      }
      if (pending !== undefined && pending.inputTokens !== estimatedInputTokens) {
        this.#pending.delete(modelCallId);
        throw new TokenMeterError("usage_estimate_mismatch", "Provider usage does not match the recorded input estimate");
      }
      // Consume the binding before persistence. A duplicate callback, a retry
      // after a failed write, or an evicted/never-estimated call may still be
      // recorded as provider evidence, but it must not add another sample.
      if (pending !== undefined) this.#pending.delete(modelCallId);

      const rawDeltaRatio = ratio(usage.input_tokens, estimatedInputTokens);
      const deltaRatio = Math.min(100, rawDeltaRatio);
      const anomaly = Math.abs(rawDeltaRatio - 1) > 0.25;
      let calibrationApplied = false;
      if (pending !== undefined && usage.input_tokens > 0 && estimatedInputTokens > 0) {
        const baseRatio = pending.calibrationRatio;
        const absoluteRatio = clamp(baseRatio * rawDeltaRatio, 0.01, 100);
        const key = calibrationKey(usage.provider, usage.model);
        const previous = this.#calibrations.get(key);
        const previousRevision = this.#revision;
        const samples = [...(previous?.samples ?? []), {
          ratio: absoluteRatio,
          observed_at: this.#now().toISOString(),
        }].slice(-this.#maxSamples);
        this.#calibrations.set(key, { samples });
        this.#revision += 1;
        this.#cache.clear();
        try {
          await this.#persist();
          calibrationApplied = true;
        } catch (error) {
          if (previous === undefined) this.#calibrations.delete(key);
          else this.#calibrations.set(key, previous);
          this.#revision = previousRevision;
          this.#cache.clear();
          throw error;
        }
      }

      return TokenUsageObservationSchema.parse({
        model_call_id: modelCallId,
        provider: usage.provider,
        model: usage.model,
        estimator_id: pending?.estimatorId ?? "heuristic_v2",
        confidence: "provider_reported",
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ...(usage.cached_input_tokens === undefined
          ? {}
          : { cached_input_tokens: usage.cached_input_tokens }),
        ...(usage.reasoning_output_tokens === undefined
          ? {}
          : { reasoning_output_tokens: usage.reasoning_output_tokens }),
        total_tokens: usage.total_tokens,
        estimated_input_tokens: estimatedInputTokens,
        delta_ratio: deltaRatio,
        anomaly,
        calibration_applied: calibrationApplied,
        calibration_revision: this.#revision,
        request_kind: usage.request_kind,
        request_sequence: usage.request_sequence,
        ...(usage.provider_reported_cost === undefined
          ? {}
          : { provider_reported_cost: usage.provider_reported_cost }),
      });
    });
  }

  #count(input: TokenMeterInput): CountedInput {
    for (const counter of this.#counters) {
      let supported = false;
      try {
        supported = counter.supports(input.provider, input.model);
      } catch {
        continue;
      }
      if (!supported) continue;
      const sections = emptySections();
      let valid = true;
      for (const item of input.sections) {
        const count = safelyCount(counter, item.content);
        if (count === null) {
          valid = false;
          break;
        }
        sections[item.section] += count;
      }
      const output = input.output_content === undefined ? 0 : safelyCount(counter, input.output_content);
      if (valid && output !== null) {
        return {
          estimatorId: counter.estimatorId,
          perSection: sections,
          outputTokens: output,
        };
      }
    }

    const sections = emptySections();
    for (const item of input.sections) sections[item.section] += estimateTokens(item.content);
    return {
      estimatorId: "heuristic_v2",
      perSection: sections,
      outputTokens: input.output_content === undefined ? 0 : estimateTokens(input.output_content),
    };
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    await ensurePrivateDirectory(dirname(this.#path));
    const persisted = await readCalibration(this.#path);
    if (persisted !== undefined) {
      this.#revision = persisted.revision;
      for (const entry of persisted.entries) {
        this.#calibrations.set(calibrationKey(entry.provider, entry.model), {
          samples: entry.samples.slice(-this.#maxSamples),
        });
      }
    }
    this.#initialized = true;
  }

  async #persist(): Promise<void> {
    const entries: TokenCalibrationEntry[] = [...this.#calibrations.entries()]
      .map(([key, state]) => {
        const [provider, model] = JSON.parse(key) as [string, string];
        return { provider, model, samples: state.samples };
      })
      .sort((left, right) => (
        left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)
      ));
    const value = TokenCalibrationFileSchema.parse({
      version: TOKEN_CALIBRATION_FORMAT_VERSION,
      revision: this.#revision,
      updated_at: this.#now().toISOString(),
      entries,
    });
    await writeCalibrationAtomic(this.#path, `${JSON.stringify(value, null, 2)}\n`);
  }

  #calibrationRatio(provider: string, model: string): number {
    const samples = this.#calibrations.get(calibrationKey(provider, model))?.samples ?? [];
    return samples.length === 0
      ? 1
      : samples.reduce((total, sample) => total + sample.ratio, 0) / samples.length;
  }

  #hasCalibration(provider: string, model: string): boolean {
    return (this.#calibrations.get(calibrationKey(provider, model))?.samples.length ?? 0) > 0;
  }

  #rememberCache(key: string, value: TokenEstimate): void {
    this.#cache.delete(key);
    this.#cache.set(key, value);
    while (this.#cache.size > this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  #rememberPending(modelCallId: string, value: PendingEstimate): void {
    this.#pending.delete(modelCallId);
    this.#pending.set(modelCallId, value);
    while (this.#pending.size > this.#maxCacheEntries) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function safelyCount(counter: TokenCounter, content: string): number | null {
  try {
    const value = counter.countTokens(content);
    return Number.isSafeInteger(value) && value !== null && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function emptySections(): TokenSectionCounts {
  return { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 0 };
}

function scaleSections(sections: TokenSectionCounts, ratioValue: number): TokenSectionCounts {
  const result = emptySections();
  const rawTotal = sumSections(sections);
  if (rawTotal === 0) return result;
  const target = scaleTokenCount(rawTotal, ratioValue);
  const ranked: Array<{ section: TokenSection; fraction: number }> = [];
  let allocated = 0;
  for (const section of SECTION_ORDER) {
    const exact = (sections[section] / rawTotal) * target;
    const whole = Math.floor(exact);
    result[section] = whole;
    allocated += whole;
    ranked.push({ section, fraction: exact - whole });
  }
  ranked.sort((left, right) => right.fraction - left.fraction
    || SECTION_ORDER.indexOf(left.section) - SECTION_ORDER.indexOf(right.section));
  for (let index = 0; allocated < target; index += 1) {
    const section = ranked[index % ranked.length]!.section;
    result[section] += 1;
    allocated += 1;
  }
  return result;
}

function sumSections(sections: TokenSectionCounts): number {
  return SECTION_ORDER.reduce((total, section) => total + sections[section], 0);
}

function scaleTokenCount(value: number, ratioValue: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value * ratioValue)));
}

function ratio(reported: number, estimated: number): number {
  if (estimated === 0) return reported === 0 ? 1 : 100;
  return reported / estimated;
}

function calibrationKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function tokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TokenMeterError("token_count_invalid", `${label} must be a nonnegative safe integer`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TokenMeterError("option_invalid", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TokenCalibrationStoreError("calibration_path_unsafe", "Token calibration directory is unsafe");
  }
  assertOwned(info.uid, "directory");
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function readCalibration(path: string) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new TokenCalibrationStoreError("calibration_path_unsafe", "Token calibration file is unsafe");
  }
  assertOwned(before.uid, "file");
  if (before.size > MAX_CALIBRATION_BYTES) {
    throw new TokenCalibrationStoreError("calibration_too_large", "Token calibration file exceeds its size limit");
  }
  if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
    throw new TokenCalibrationStoreError("calibration_permissions_unsafe", "Token calibration file must use mode 0600");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new TokenCalibrationStoreError("calibration_path_unsafe", "Token calibration file changed while opening");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > MAX_CALIBRATION_BYTES) {
      throw new TokenCalibrationStoreError("calibration_too_large", "Token calibration file exceeds its size limit");
    }
    try {
      return TokenCalibrationFileSchema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      throw new TokenCalibrationStoreError("calibration_corrupt", "Token calibration file is invalid", { cause: error });
    }
  } finally {
    await handle.close();
  }
}

async function writeCalibrationAtomic(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_CALIBRATION_BYTES) {
    throw new TokenCalibrationStoreError("calibration_too_large", "Token calibration file exceeds its size limit");
  }
  await ensurePrivateDirectory(dirname(path));
  await assertSafeExistingFile(path);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertSafeExistingFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new TokenCalibrationStoreError("calibration_path_unsafe", "Token calibration file is unsafe");
    }
    assertOwned(info.uid, "file");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertOwned(uid: number, kind: string): void {
  if (process.platform === "win32" || process.getuid === undefined) return;
  if (uid !== process.getuid()) {
    throw new TokenCalibrationStoreError("calibration_owner_mismatch", `Token calibration ${kind} has another owner`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class TokenMeterError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenMeterError";
  }
}

export class TokenCalibrationStoreError extends TokenMeterError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "TokenCalibrationStoreError";
  }
}
