import type { TraceEvent } from "./model";

export interface PublicOperation {
  readonly id: string;
  readonly family: "model" | "tool" | "context" | "event";
  readonly state: "started" | "completed" | "failed" | "cancelled" | "unknown" | "info";
  readonly start?: TraceEvent;
  readonly event: TraceEvent;
}

/** Compact labels preserve the observed operation outcome without leaking transport details. */
export function compactOperationLabel(operation: PublicOperation): string {
  if (operation.family === "model") return operation.state === "started" ? "Request sent" : operation.state === "completed" ? "Response received" : operation.state === "failed" ? "Request failed" : operation.state === "cancelled" ? "Request cancelled" : operation.state === "unknown" ? "Request outcome unknown" : "Model request recorded";
  if (operation.family === "context") return "Context update";
  const tool = operation.event.toolName;
  const labels: Readonly<Record<string, string>> = { generate_image: "Image generation", render_diagram: "Diagram rendering", render_chart: "Chart rendering", read_file: "Reading files", search: "Searching files", preview_patch: "Patch preview", commit_patch: "Applying patch", run_test: "Running tests" };
  return tool && labels[tool] ? labels[tool] : operation.event.title;
}

/** Pair only explicit operation identities. A Run outcome never settles a child operation. */
export function publicOperations(events: readonly TraceEvent[]): PublicOperation[] {
  const operations = new Map<string, PublicOperation>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const type = event.sourceType ?? "";
    const family = type.startsWith("model.") ? "model" : type.startsWith("tool.") ? "tool" : type.startsWith("context.compaction_") ? "context" : "event";
    const started = type === "model.request_started" || type === "tool.started" || type === "context.compaction_started";
    const completed = type === "model.decision" || type === "tool.completed" || type === "context.compaction_completed";
    const failed = type.endsWith("failed") || type === "model.output_invalid";
    const unknown = type === "tool.unknown";
    const cancelled = type.endsWith("cancelled") || type.endsWith("interrupted");
    const paired = event.operationId !== undefined && family !== "event" && (started || completed || failed || unknown || cancelled);
    const id = paired ? `${family}:${event.operationId}` : event.id;
    const previous = operations.get(id);
    operations.set(id, {
      id, family,
      state: started ? "started" : completed ? "completed" : failed ? "failed" : unknown ? "unknown" : cancelled ? "cancelled" : "info",
      ...(started ? { start: event } : previous?.start === undefined ? {} : { start: previous.start }),
      event,
    });
  }
  return [...operations.values()].sort((a, b) => a.event.sequence - b.event.sequence);
}
