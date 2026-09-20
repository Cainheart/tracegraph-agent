import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CalibratedTokenMeter,
  TokenCalibrationStoreError,
  type TokenCounter,
} from "./token-meter.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CalibratedTokenMeter", () => {
  it("converges on provider usage, preserves section totals, and reloads calibration", async () => {
    const setup = await temporaryCalibration();
    let now = new Date("2026-09-18T00:00:00.000Z");
    const meter = new CalibratedTokenMeter({
      calibrationPath: setup.path,
      now: () => now,
    });
    await meter.initialize();

    const first = meter.estimate(meterInput("call-1", "revision-1"));
    expect(first.confidence).toBe("estimated");
    expect(sectionTotal(first.per_section)).toBe(first.input_tokens);
    const reportedInput = first.input_tokens * 2;
    const observed = await meter.observeUsage(
      "call-1",
      usage(reportedInput, 12, { cached: Math.floor(reportedInput / 2) }),
      first.input_tokens,
    );

    expect(observed).toMatchObject({
      confidence: "provider_reported",
      estimated_input_tokens: first.input_tokens,
      delta_ratio: 2,
      anomaly: true,
      calibration_applied: true,
      calibration_revision: 1,
    });
    expect(meter.revision()).toBe(1);

    now = new Date("2026-09-18T00:01:00.000Z");
    const calibrated = meter.estimate(meterInput("call-2", "revision-2"));
    expect(calibrated.confidence).toBe("calibrated");
    expect(calibrated.input_tokens).toBe(reportedInput);
    expect(sectionTotal(calibrated.per_section)).toBe(calibrated.input_tokens);
    const stable = await meter.observeUsage("call-2", usage(reportedInput, 12), calibrated.input_tokens);
    expect(stable.delta_ratio).toBe(1);
    expect(stable.anomaly).toBe(false);
    expect(stable.calibration_applied).toBe(true);

    const fileInfo = await lstat(setup.path);
    const directoryInfo = await lstat(setup.directory);
    if (process.platform !== "win32") {
      expect(fileInfo.mode & 0o777).toBe(0o600);
      expect(directoryInfo.mode & 0o777).toBe(0o700);
    }
    const persisted = await readFile(setup.path, "utf8");
    expect(persisted).not.toContain("Pinned system instructions");
    expect((await readdir(setup.directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);

    const reloaded = new CalibratedTokenMeter({ calibrationPath: setup.path });
    await reloaded.initialize();
    const afterRestart = reloaded.estimate(meterInput("call-after-restart", "revision-3"));
    expect(afterRestart).toMatchObject({
      confidence: "calibrated",
      input_tokens: reportedInput,
    });
  });

  it("uses only the bounded sliding window and isolates provider/model calibration", async () => {
    const setup = await temporaryCalibration();
    const counter: TokenCounter = {
      estimatorId: "test:characters",
      supports: () => true,
      countTokens: (content) => content.length,
    };
    const meter = new CalibratedTokenMeter({
      calibrationPath: setup.path,
      counters: [counter],
      maxSamples: 3,
    });
    await meter.initialize();

    for (const [index, absoluteRatio] of [1, 2, 3, 4].entries()) {
      const modelCallId = `call-window-${index}`;
      const estimate = meter.estimate(characterInput(modelCallId, "openai", "model-a", `r${index}`));
      await meter.observeUsage(
        modelCallId,
        usage(100 * absoluteRatio, 0, { provider: "openai", model: "model-a" }),
        estimate.input_tokens,
      );
    }

    const windowed = meter.estimate(characterInput("call-window-result", "openai", "model-a", "result"));
    const otherModel = meter.estimate(characterInput("call-other-model", "openai", "model-b", "result"));
    const otherProvider = meter.estimate(characterInput("call-other-provider", "anthropic", "model-a", "result"));
    expect(windowed.input_tokens).toBe(300);
    expect(windowed.confidence).toBe("calibrated");
    expect(otherModel).toMatchObject({ input_tokens: 100, confidence: "estimated" });
    expect(otherProvider).toMatchObject({ input_tokens: 100, confidence: "estimated" });
  });

  it("invalidates estimates on both content and calibration revision changes", async () => {
    const setup = await temporaryCalibration();
    let calls = 0;
    const counter: TokenCounter = {
      estimatorId: "test:counted",
      supports: () => true,
      countTokens(content) {
        calls += 1;
        return content.length;
      },
    };
    const meter = new CalibratedTokenMeter({ calibrationPath: setup.path, counters: [counter] });
    await meter.initialize();
    const base = characterInput("cache-1", "openai", "cache-model", "content-r1");
    const first = meter.estimate(base);
    expect(calls).toBe(1);
    meter.estimate({ ...base, model_call_id: "cache-2" });
    expect(calls).toBe(1);

    await meter.observeUsage("cache-1", usage(200, 0, {
      provider: "openai",
      model: "cache-model",
    }), first.input_tokens);
    expect(meter.revision()).toBe(1);
    meter.estimate({ ...base, model_call_id: "cache-3" });
    expect(calls).toBe(2);
    meter.estimate({ ...base, model_call_id: "cache-4", content_revision: "content-r2" });
    expect(calls).toBe(3);
    meter.estimate({
      ...base,
      model_call_id: "cache-5",
      sections: [{ section: "goal", content: `${"x".repeat(100)}changed` }],
    });
    expect(calls).toBe(4);
  });

  it("does not calibrate duplicate or never-estimated provider reports", async () => {
    const setup = await temporaryCalibration();
    const meter = new CalibratedTokenMeter({ calibrationPath: setup.path });
    await meter.initialize();
    const estimate = meter.estimate(meterInput("call-once", "revision-once"));
    const report = usage(estimate.input_tokens * 2, 3);

    const first = await meter.observeUsage("call-once", report, estimate.input_tokens);
    const duplicate = await meter.observeUsage("call-once", report, estimate.input_tokens);
    const unbound = await meter.observeUsage("call-never-estimated", report, estimate.input_tokens);

    expect(first.calibration_applied).toBe(true);
    expect(duplicate).toMatchObject({ calibration_applied: false, calibration_revision: 1 });
    expect(unbound).toMatchObject({ calibration_applied: false, calibration_revision: 1 });
    expect(meter.revision()).toBe(1);
  });

  it("rolls back in-memory calibration when secure persistence rejects the target", async () => {
    const setup = await temporaryCalibration();
    const meter = new CalibratedTokenMeter({ calibrationPath: setup.path });
    await meter.initialize();
    const estimate = meter.estimate(meterInput("call-persist-failure", "revision-persist-failure"));
    const target = join(setup.root, "unexpected-calibration-target.json");
    await writeFile(target, validCalibration(), { mode: 0o600 });
    await symlink(target, setup.path);

    await expect(meter.observeUsage(
      "call-persist-failure",
      usage(estimate.input_tokens * 2, 0),
      estimate.input_tokens,
    )).rejects.toMatchObject({ code: "calibration_path_unsafe" });
    expect(meter.revision()).toBe(0);

    await unlink(setup.path);
    const afterFailure = meter.estimate(meterInput("call-after-persist-failure", "revision-after-failure"));
    expect(afterFailure.confidence).toBe("estimated");
  });

  it("silently falls back for unknown models and failing optional counters", async () => {
    const setup = await temporaryCalibration();
    const broken: TokenCounter = {
      estimatorId: "broken:counter",
      supports: () => {
        throw new Error("unsupported catalog lookup");
      },
      countTokens: () => {
        throw new Error("must not escape");
      },
    };
    const meter = new CalibratedTokenMeter({ calibrationPath: setup.path, counters: [broken] });
    await meter.initialize();

    expect(() => meter.estimate({
      ...meterInput("unknown-call", "unknown-revision"),
      provider: "new-provider",
      model: "unpublished-model-v99",
    })).not.toThrow();
    const estimate = meter.estimate({
      ...meterInput("unknown-call-2", "unknown-revision-2"),
      provider: "new-provider",
      model: "unpublished-model-v99",
    });
    expect(estimate.estimator_id).toBe("heuristic_v2");
    expect(estimate.confidence).toBe("estimated");
    expect(sectionTotal(estimate.per_section)).toBe(estimate.input_tokens);
  });

  it("does not overclaim full-request exactness from a precise section tokenizer", async () => {
    const setup = await temporaryCalibration();
    const exactCounter: TokenCounter = {
      estimatorId: "vendor:exact-test-tokenizer",
      supports: (provider, model) => provider === "vendor" && model === "known-model",
      countTokens: (content) => content.length,
    };
    const meter = new CalibratedTokenMeter({ calibrationPath: setup.path, counters: [exactCounter] });
    await meter.initialize();
    const estimate = meter.estimate({
      model_call_id: "exact-call",
      provider: "vendor",
      model: "known-model",
      content_revision: "exact-r1",
      sections: [{ section: "goal", content: "12345" }],
      output_content: "123",
    });
    expect(estimate).toMatchObject({
      estimator_id: "vendor:exact-test-tokenizer",
      confidence: "estimated",
      input_tokens: 5,
      output_tokens: 3,
    });
    const observed = await meter.observeUsage(
      "exact-call",
      usage(7, 3, { provider: "vendor", model: "known-model" }),
      5,
    );
    expect(observed).toMatchObject({ confidence: "provider_reported", anomaly: true });
    expect(meter.revision()).toBe(1);
    const calibrated = meter.estimate({
      model_call_id: "exact-call-calibrated",
      provider: "vendor",
      model: "known-model",
      content_revision: "exact-r2",
      sections: [{ section: "goal", content: "12345" }],
      output_content: "123",
    });
    expect(calibrated).toMatchObject({
      estimator_id: "vendor:exact-test-tokenizer",
      confidence: "calibrated",
      input_tokens: 7,
    });
  });

  it("rejects corrupt, over-permissive, and symlinked calibration files without exposing content", async () => {
    const corrupt = await temporaryCalibration();
    await writeFile(corrupt.path, "DO_NOT_ECHO_INVALID_CALIBRATION", { mode: 0o600 });
    const corruptMeter = new CalibratedTokenMeter({ calibrationPath: corrupt.path });
    await expect(corruptMeter.initialize()).rejects.toMatchObject({
      name: "TokenCalibrationStoreError",
      code: "calibration_corrupt",
      message: "Token calibration file is invalid",
    });

    if (process.platform !== "win32") {
      const permissive = await temporaryCalibration();
      await writeFile(permissive.path, validCalibration(), { mode: 0o600 });
      await chmod(permissive.path, 0o644);
      await expect(new CalibratedTokenMeter({ calibrationPath: permissive.path }).initialize())
        .rejects.toMatchObject<Partial<TokenCalibrationStoreError>>({
          code: "calibration_permissions_unsafe",
        });
    }

    const linked = await temporaryCalibration();
    const target = join(linked.root, "target.json");
    await writeFile(target, validCalibration(), { mode: 0o600 });
    await symlink(target, linked.path);
    await expect(new CalibratedTokenMeter({ calibrationPath: linked.path }).initialize())
      .rejects.toMatchObject<Partial<TokenCalibrationStoreError>>({
        code: "calibration_path_unsafe",
      });

    const parent = await temporaryCalibration();
    const realDirectory = join(parent.root, "real-state");
    const linkedDirectory = join(parent.root, "linked-state");
    await mkdir(realDirectory, { mode: 0o700 });
    await symlink(realDirectory, linkedDirectory);
    await expect(new CalibratedTokenMeter({
      calibrationPath: join(linkedDirectory, "token-calibration.json"),
    }).initialize()).rejects.toMatchObject<Partial<TokenCalibrationStoreError>>({
      code: "calibration_path_unsafe",
    });
  });
});

function meterInput(modelCallId: string, contentRevision: string) {
  return {
    model_call_id: modelCallId,
    provider: "openai",
    model: "gpt-5.6-sol",
    content_revision: contentRevision,
    sections: [
      { section: "system" as const, content: "Pinned system instructions" },
      { section: "goal" as const, content: "Explain the repository" },
      { section: "history" as const, content: "Earlier user and assistant messages" },
      { section: "tool" as const, content: "Bounded tool observation" },
      { section: "repo" as const, content: "export const answer = 42;" },
      { section: "memory" as const, content: "Verified project preference" },
    ],
  };
}

function characterInput(
  modelCallId: string,
  provider: string,
  model: string,
  contentRevision: string,
) {
  return {
    model_call_id: modelCallId,
    provider,
    model,
    content_revision: contentRevision,
    sections: [{ section: "goal" as const, content: "x".repeat(100) }],
  };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  options: { provider?: string; model?: string; cached?: number } = {},
) {
  return {
    provider: options.provider ?? "openai",
    model: options.model ?? "gpt-5.6-sol",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(options.cached === undefined ? {} : { cached_input_tokens: options.cached }),
    total_tokens: inputTokens + outputTokens,
    request_kind: "initial" as const,
    request_sequence: 1,
  };
}

function sectionTotal(sections: Record<string, number>): number {
  return Object.values(sections).reduce((total, count) => total + count, 0);
}

function validCalibration(): string {
  return `${JSON.stringify({
    version: 1,
    revision: 1,
    updated_at: "2026-09-18T00:00:00.000Z",
    entries: [{
      provider: "openai",
      model: "gpt-5.6-sol",
      samples: [{ ratio: 1.2, observed_at: "2026-09-18T00:00:00.000Z" }],
    }],
  })}\n`;
}

async function temporaryCalibration(): Promise<{
  root: string;
  directory: string;
  path: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-token-meter-"));
  cleanups.push(() => removeControlledTemporaryDirectory(root));
  const directory = join(root, "state");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory, path: join(directory, "token-calibration.json") };
}
