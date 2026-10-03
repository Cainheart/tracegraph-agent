import { RawToolResultSchema, type ToolName } from "@tracegraph/contracts";
import type { RawToolResult, ToolDefinition, ToolExecutionContext } from "./definition.js";
import { TOOL_OUTPUT_LIMITS, type BuiltinToolName, type ToolOutputLimit } from "./tool-output-limits.js";
import { MIN_TOOL_RESULT_ENVELOPE_BYTES } from "./constants.js";
import { ActionRejectedError } from "./errors.js";
import { isPlainObject, jsonBytes, truncateUtf8 } from "./utils.js";

function abortedToolResult(): RawToolResult {
  return { status: "failure", code: "tool_aborted", summary: "Tool execution was stopped" };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
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
    const execution = context.startOwnedJob === undefined
      ? Promise.resolve(definition.execute(frozenInput, { ...context, signal }))
      : context.startOwnedJob(() => definition.execute(frozenInput, { ...context, signal }));
    if (execution === undefined) return abortedToolResult();
    const output = await Promise.race([
      execution,
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
