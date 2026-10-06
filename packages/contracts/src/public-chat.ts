/** Read-only presentation facts. Raw tool arguments/output and provider reasoning
 * deliberately have no field here. Callers supply only already-public facts. */
import type { SessionEvent } from "./event.js";

export interface PublicChatFact {
  readonly event_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly operation_id?: string;
  readonly model_call_id?: string;
  readonly public_plan?: string;
  /** Public final answer recorded by an exact run.completed ledger fact. */
  readonly public_answer?: string;
  readonly tool_name?: string;
  readonly target?: string;
}

/** Explicit allowlist at the canonical boundary. No fallback to event.summary,
 * decision reasoning, arbitrary nested arguments or response bodies. */
export function projectSessionPublicChat(events: readonly Pick<SessionEvent, "event_id" | "sequence" | "type" | "data" | "operation_id" | "model_call_id">[]): readonly PublicChatBlock[] {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
  return projectPublicChat(events.map(event => {
    const receipt = record(event.data.receipt);
    const tool = text(event.data.tool_name) ?? text(receipt.tool_name);
    const target = text(event.data.path);
    const publicPlan = event.type === "model.decision" ? text(event.data.public_plan) : undefined;
    return { event_id: event.event_id, sequence: event.sequence, type: event.type,
      ...(event.operation_id ? { operation_id: event.operation_id } : {}),
      ...(event.model_call_id ? { model_call_id: event.model_call_id } : {}),
      ...(tool ? { tool_name: tool } : {}), ...(target ? { target } : {}),
      ...(publicPlan ? { public_plan: publicPlan } : {}),
      ...(event.type === "run.completed" && text(event.data.outcome)?.trim() ? { public_answer: text(event.data.outcome)!.trim() } : {}) };
  }));
}

export interface PublicChatOperation {
  readonly id: string;
  readonly source_event_ids: readonly string[];
  readonly sequence: number;
  readonly tool_name: string;
  readonly target?: string;
  readonly status: "running" | "completed" | "failed" | "unknown" | "cancelled";
}

export type PublicChatBlock =
  | { readonly kind: "statement"; readonly id: string; readonly sequence: number; readonly text: string; readonly source_event_ids: readonly string[] }
  | { readonly kind: "answer"; readonly id: string; readonly sequence: number; readonly text: string; readonly source_event_ids: readonly string[] }
  | { readonly kind: "operations"; readonly id: string; readonly sequence: number; readonly operations: readonly PublicChatOperation[] };

/** Stable ordering is by admission/start, not the completion timestamp. A later
 * completion updates its operation without moving it past later commentary.
 * Terminal Run/model events never manufacture a terminal tool result. */
export function projectPublicChat(facts: readonly PublicChatFact[]): readonly PublicChatBlock[] {
  const unique = new Map(facts.map((fact) => [fact.event_id, fact]));
  const statements: Extract<PublicChatBlock, { kind: "statement" | "answer" }>[] = [];
  const operations = new Map<string, PublicChatOperation>();
  for (const fact of [...unique.values()].sort((a, b) => a.sequence - b.sequence)) {
    if (fact.type === "model.decision" && fact.public_plan?.trim()) {
      statements.push({ kind: "statement", id: fact.event_id, sequence: fact.sequence,
        text: fact.public_plan.trim(), source_event_ids: [fact.event_id] });
    }
    // Only a durable successful terminal fact can publish an answer. Failure,
    // cancellation, provisional model output and generic event summaries are
    // intentionally excluded.
    if (fact.type === "run.completed" && fact.public_answer?.trim()) {
      statements.push({ kind: "answer", id: fact.event_id, sequence: fact.sequence,
        text: fact.public_answer.trim(), source_event_ids: [fact.event_id] });
    }
    if (!["tool.started", "tool.completed", "tool.failed", "tool.unknown", "tool.cancelled", "tool.interrupted"].includes(fact.type)) continue;
    const id = fact.operation_id ? `tool:${fact.operation_id}` : fact.event_id;
    const previous = operations.get(id);
    const target = fact.target ?? previous?.target;
    operations.set(id, { id, sequence: previous?.sequence ?? fact.sequence,
      source_event_ids: [...(previous?.source_event_ids ?? []), fact.event_id],
      tool_name: fact.tool_name ?? previous?.tool_name ?? "tool",
      ...(target ? { target } : {}),
      status: fact.type === "tool.started" ? "running" : fact.type === "tool.completed" ? "completed"
        : fact.type === "tool.failed" ? "failed" : fact.type === "tool.unknown" ? "unknown" : "cancelled" });
  }
  const ordered = [...statements, ...operations.values()].sort((a, b) => a.sequence - b.sequence);
  const result: PublicChatBlock[] = [];
  for (const item of ordered) {
    if ("kind" in item) { result.push(item); continue; }
    const previous = result.at(-1);
    if (previous?.kind === "operations") result[result.length - 1] = { ...previous, operations: [...previous.operations, item] };
    else result.push({ kind: "operations", id: `group:${item.id}`, sequence: item.sequence, operations: [item] });
  }
  return result;
}

/** The safe category is language-neutral; detailed transport errors stay in
 * diagnostics. This classification never changes a task's recorded outcome. */
export function classifyPublicChatFailure(message: string): "authentication" | "model" | "connect_timeout" | "response_timeout" | "address" | "connection" | "unknown" {
  if (/401|403|unauthoriz|invalid.?api.?key|authentication/i.test(message)) return "authentication";
  if (/model[_ -]?not[_ -]?found|model.*(?:does not exist|not exist)|model_http_404/i.test(message)) return "model";
  if (/CONNECT_TIMEOUT|connect.*timed?\s*out/i.test(message)) return "connect_timeout";
  if (/HEADERS_TIMEOUT|BODY_TIMEOUT|timed?\s*out|timeout/i.test(message)) return "response_timeout";
  if (/ENOTFOUND|ERR_INVALID_URL|invalid.*(?:url|address)|EAI_AGAIN/i.test(message)) return "address";
  if (/ECONNREFUSED|ECONNRESET|offline|network|fetch failed/i.test(message)) return "connection";
  return "unknown";
}
