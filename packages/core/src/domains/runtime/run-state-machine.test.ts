import { describe, expect, it } from "vitest";
import {
  transitionAfterFinish,
  transitionTurnStart,
  transitionUserInputStep,
} from "./run-state-machine.js";

describe("Run/Turn/Step state machine", () => {
  it.each([
    {
      name: "starts the first turn",
      input: { completedTurns: 0, maxTurns: 12, orchestrationDepth: 0 },
      expected: { kind: "start_turn", turn: 1 },
    },
    {
      name: "starts the final permitted turn",
      input: { completedTurns: 11, maxTurns: 12, orchestrationDepth: 0 },
      expected: { kind: "start_turn", turn: 12 },
    },
    {
      name: "fails an exhausted root turn budget",
      input: { completedTurns: 12, maxTurns: 12, orchestrationDepth: 0 },
      expected: { kind: "budget_exhausted", failureCode: "turn_budget_exhausted" },
    },
    {
      name: "fails an exhausted child step budget",
      input: { completedTurns: 2, maxTurns: 2, orchestrationDepth: 1 },
      expected: { kind: "budget_exhausted", failureCode: "subagent_step_budget_exceeded" },
    },
    {
      name: "fails a zero-turn budget before starting",
      input: { completedTurns: 0, maxTurns: 0, orchestrationDepth: 1 },
      expected: { kind: "budget_exhausted", failureCode: "subagent_step_budget_exceeded" },
    },
  ])("$name", ({ input, expected }) => {
    expect(transitionTurnStart(input)).toEqual(expected);
  });

  it.each([
    {
      name: "lets queued input win over a finish in execute mode",
      input: { mode: "execute" as const, pendingInputCount: 1 },
      expected: { kind: "continue_for_input" },
    },
    {
      name: "lets queued input win before inspecting a plan",
      input: { mode: "plan" as const, pendingInputCount: 1 },
      expected: { kind: "continue_for_input" },
    },
    {
      name: "completes an execute Run with no pending input",
      input: { mode: "execute" as const, pendingInputCount: 0 },
      expected: { kind: "complete_run" },
    },
    {
      name: "defers Todo projection for a plan with no pending input",
      input: { mode: "plan" as const, pendingInputCount: 0 },
      expected: { kind: "inspect_plan_todos" },
    },
    {
      name: "fails a plan with no Todos",
      input: { mode: "plan" as const, pendingInputCount: 0, todoCount: 0 },
      expected: { kind: "plan_missing_todos" },
    },
    {
      name: "makes a nonempty plan ready",
      input: { mode: "plan" as const, pendingInputCount: 0, todoCount: 2 },
      expected: { kind: "plan_ready" },
    },
  ])("$name", ({ input, expected }) => {
    expect(transitionAfterFinish(input)).toEqual(expected);
  });

  it.each([
    {
      name: "starts at step one for a new Run",
      events: [],
      proposed: 1,
      expected: { kind: "step_available", step: 1 },
    },
    {
      name: "uses the caller's later proposed step",
      events: [],
      proposed: 4,
      expected: { kind: "step_available", step: 4 },
    },
    {
      name: "advances beyond the last valid consumed step",
      events: [{ type: "user.input_consumed", data: consumedInput(4) }],
      proposed: 2,
      expected: { kind: "step_available", step: 5 },
    },
    {
      name: "ignores malformed consumed-event payloads",
      events: [
        { type: "user.input_consumed", data: { ...consumedInput(1), at_step: 0 } },
        { type: "user.input_consumed", data: { ...consumedInput(1), at_step: "invalid" } },
        { type: "run.started", data: { at_step: 99 } },
      ],
      proposed: 2,
      expected: { kind: "step_available", step: 2 },
    },
    {
      name: "truncates the proposed step and enforces the minimum",
      events: [],
      proposed: 0.9,
      expected: { kind: "step_available", step: 1 },
    },
    {
      name: "reports step-range exhaustion",
      events: [{ type: "user.input_consumed", data: consumedInput(1_000_000) }],
      proposed: 1,
      expected: { kind: "step_range_exhausted" },
    },
  ])("$name", ({ events, proposed, expected }) => {
    expect(transitionUserInputStep(events, proposed)).toEqual(expected);
  });
});

function consumedInput(at_step: number) {
  return {
    input_id: "input:state-machine-test",
    kind: "message",
    consumed_at: "2026-09-30T00:00:00.000Z",
    at_step,
    queued_event_id: "event:state-machine-test",
  };
}
