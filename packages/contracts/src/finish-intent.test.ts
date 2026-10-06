import { describe, expect, it } from "vitest";
import { DecisionSchema } from "./action.js";

const answer = { decision_id: "decision:answer", kind: "finish", public_reason: "Answer the question", evidence_refs: [], risk: "none", final_answer: "A direct answer" };

describe("explicit finish intent", () => {
  it("reads legacy answers without inventing execution authority", () => {
    expect(DecisionSchema.parse(answer).finish_intent).toBeUndefined();
  });
  it.each(["answer", "submit_plan"])("accepts the closed intent %s", (finish_intent) => {
    expect(DecisionSchema.parse({ ...answer, finish_intent }).finish_intent).toBe(finish_intent);
  });
  it("rejects an invented terminal intent and intent on a tool Decision", () => {
    expect(DecisionSchema.safeParse({ ...answer, finish_intent: "execute_now" }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...answer, kind: "tool_call", final_answer: undefined, finish_intent: "submit_plan", tool_call: { action_id: "action:todo", tool_name: "todo_write", arguments: {} } }).success).toBe(false);
  });
});
