import { UserInputConsumedDataSchema } from "@tracegraph/contracts";
import type { RunMode } from "@tracegraph/contracts";

/**
 * Decide whether the loop may start another model turn. This is a pure
 * progression decision; Runtime still owns steering, state mutation, and I/O.
 */
export function transitionTurnStart(input: {
  completedTurns: number;
  maxTurns: number;
  orchestrationDepth: number;
}): TurnStartTransition {
  if (input.completedTurns >= input.maxTurns) {
    return {
      kind: "budget_exhausted",
      failureCode: input.orchestrationDepth > 0
        ? "subagent_step_budget_exceeded"
        : "turn_budget_exhausted",
    };
  }
  return { kind: "start_turn", turn: input.completedTurns + 1 };
}

export type TurnStartTransition =
  | { kind: "start_turn"; turn: number }
  | {
    kind: "budget_exhausted";
    failureCode: "turn_budget_exhausted" | "subagent_step_budget_exceeded";
  };

/**
 * Decide the finish path from the mode, queued-input count, and (when needed)
 * the Todo count. `inspect_plan_todos` lets Runtime preserve its current order:
 * pending input is checked before the Todo projection is evaluated.
 */
export function transitionAfterFinish(input: {
  mode: RunMode;
  pendingInputCount: number;
  todoCount?: number;
}): FinishTransition {
  if (input.pendingInputCount > 0) return { kind: "continue_for_input" };
  if (input.mode === "execute") return { kind: "complete_run" };
  if (input.todoCount === undefined) return { kind: "inspect_plan_todos" };
  if (input.todoCount === 0) return { kind: "plan_missing_todos" };
  return { kind: "plan_ready" };
}

export type FinishTransition =
  | { kind: "continue_for_input" }
  | { kind: "complete_run" }
  | { kind: "inspect_plan_todos" }
  | { kind: "plan_missing_todos" }
  | { kind: "plan_ready" };

/**
 * Advance the durable user-input step without writing an Event. Valid
 * `user.input_consumed` Events remain the source of the previous step; malformed
 * historical payloads continue to be ignored as they were in Runtime.
 */
export function transitionUserInputStep(
  events: readonly { type: string; data: unknown }[],
  proposed: number,
): UserInputStepTransition {
  let lastStep = 0;
  for (const event of events) {
    if (event.type !== "user.input_consumed") continue;
    const parsed = UserInputConsumedDataSchema.safeParse(event.data);
    if (parsed.success) lastStep = Math.max(lastStep, parsed.data.at_step);
  }
  const next = Math.max(1, Math.trunc(proposed), lastStep + 1);
  if (next > 1_000_000) return { kind: "step_range_exhausted" };
  return { kind: "step_available", step: next };
}

export type UserInputStepTransition =
  | { kind: "step_available"; step: number }
  | { kind: "step_range_exhausted" };
