import { describe, expect, it } from "vitest";
import type { TraceEvent } from "./model";
import { publicOperations } from "./public-progress";

function fact(sequence: number, sourceType: string, operationId?: string): TraceEvent {
  return { id: `event-${sequence}`, sequence, sourceType, kind: "tool", title: sourceType, summary: sourceType, timestamp: "12:00:00", state: sourceType.endsWith("started") ? "running" : "succeeded", ...(operationId === undefined ? {} : { operationId }) };
}

describe("public operation facts", () => {
  it("pairs a tool completion only with the same operation, retaining the start", () => {
    const operations = publicOperations([fact(3, "tool.completed", "read-a"), fact(1, "tool.started", "read-a"), fact(2, "tool.started", "read-b"), fact(4, "run.completed")]);
    expect(operations.find((item) => item.id === "tool:read-a")).toMatchObject({ state: "completed", start: { sequence: 1 }, event: { sequence: 3 } });
    expect(operations.find((item) => item.id === "tool:read-b")).toMatchObject({ state: "started", event: { sequence: 2 } });
    expect(operations).toHaveLength(3);
  });
  it("keeps missing identities independent and never pairs across model and tool families", () => {
    const operations = publicOperations([fact(1, "tool.started"), fact(2, "tool.completed"), fact(3, "model.request_started", "same-id"), fact(4, "tool.completed", "same-id")]);
    expect(operations).toHaveLength(4);
    expect(operations.find((item) => item.id === "model:same-id")?.state).toBe("started");
  });
  it("retains an uncertain outcome after a Run ends and settles only an explicit cancellation", () => {
    const operations = publicOperations([fact(1, "tool.started", "write"), fact(2, "tool.unknown", "write"), fact(3, "run.failed"), fact(4, "model.request_started", "call"), fact(5, "model.interrupted", "call")]);
    expect(operations.find((item) => item.id === "tool:write")?.state).toBe("unknown");
    expect(operations.find((item) => item.id === "model:call")?.state).toBe("cancelled");
  });
});
