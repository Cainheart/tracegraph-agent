import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  InputQueueProjectionSchema,
  MAX_PENDING_USER_INPUTS,
  MAX_USER_INPUT_BODY_CHARS,
  MAX_USER_INPUT_STEP,
  PROJECTOR_VERSION,
  RunCommandSchema,
  RunProjectionSchema,
  SCHEMA_VERSION,
  SubmitUserInputCommandSchema,
  SubmitUserInputRequestSchema,
  SubmitUserInputResultSchema,
  UserInputConsumedDataSchema,
  UserInputQueuedDataSchema,
  UserInputSchema,
} from "./index.js";

const SUBMITTED_AT = "2026-09-19T01:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}` as const;

function pendingInput(overrides: Record<string, unknown> = {}) {
  return {
    input_id: "input:one",
    run_id: "run:one",
    kind: "message",
    body: "Please inspect the failing test",
    actor: "user",
    submitted_at: SUBMITTED_AT,
    ...overrides,
  };
}

describe("G-14 steering contracts", () => {
  it("accepts bounded user input and requires atomic consumption facts", () => {
    expect(UserInputSchema.parse(pendingInput())).toEqual(pendingInput());
    expect(UserInputSchema.parse({
      ...pendingInput(),
      consumed_at: "2026-09-19T01:00:01.000Z",
      consumed_at_step: 1,
    }).consumed_at_step).toBe(1);

    expect(() => UserInputSchema.parse({ ...pendingInput(), consumed_at: SUBMITTED_AT })).toThrow(
      "consumed_at and consumed_at_step must be present together",
    );
    expect(() => UserInputSchema.parse({ ...pendingInput(), consumed_at_step: 1 })).toThrow(
      "consumed_at and consumed_at_step must be present together",
    );
    expect(() => UserInputSchema.parse({ ...pendingInput(), consumed_at_step: 0 })).toThrow();
    expect(() => UserInputSchema.parse({
      ...pendingInput(),
      consumed_at: SUBMITTED_AT,
      consumed_at_step: MAX_USER_INPUT_STEP + 1,
    })).toThrow();
    expect(() => UserInputSchema.parse({ ...pendingInput(), body: "x".repeat(MAX_USER_INPUT_BODY_CHARS + 1) }))
      .toThrow();
    expect(() => UserInputSchema.parse({ ...pendingInput(), body: "   " })).toThrow(
      "message input body must not be empty",
    );
    expect(UserInputSchema.parse({ ...pendingInput(), kind: "cancel", body: "" }).body).toBe("");
  });

  it("keeps browser requests free of scope, actor, and server timestamps", () => {
    const request = {
      command_id: "command:one",
      input_id: "input:one",
      kind: "approve_hint",
      body: "Prefer the smaller patch",
    } as const;
    expect(SubmitUserInputRequestSchema.parse(request)).toEqual(request);

    for (const injected of [
      { project_id: "project:smuggled" },
      { run_id: "run:smuggled" },
      { actor: "model" },
      { submitted_at: SUBMITTED_AT },
      { consumed_at: SUBMITTED_AT },
      { consumed_at_step: 1 },
    ]) {
      expect(() => SubmitUserInputRequestSchema.parse({ ...request, ...injected })).toThrow();
    }
  });

  it("defines the Host-bound command and includes it in the Run command union", () => {
    const command = {
      type: "submit_user_input",
      command_id: "command:one",
      input_id: "input:one",
      project_id: "project:one",
      run_id: "run:one",
      kind: "message",
      body: "Continue with the regression test",
      actor: "user",
    } as const;
    expect(SubmitUserInputCommandSchema.parse(command)).toEqual(command);
    expect(RunCommandSchema.parse(command)).toEqual(command);
    expect(() => SubmitUserInputCommandSchema.parse({ ...command, actor: "model" })).toThrow();
    expect(() => SubmitUserInputCommandSchema.parse({ ...command, submitted_at: SUBMITTED_AT })).toThrow();
  });

  it("defines strict queued/consumed event payloads and public results", () => {
    const queuedData = {
      input: pendingInput(),
      _internal_command_digest: HASH,
      _internal_input_digest: HASH,
    } as const;
    expect(UserInputQueuedDataSchema.parse(queuedData)).toEqual(queuedData);
    expect(() => UserInputQueuedDataSchema.parse({ ...queuedData, project_id: "project:smuggled" }))
      .toThrow();

    const consumed = {
      input_id: "input:one",
      kind: "message",
      consumed_at: "2026-09-19T01:00:01.000Z",
      at_step: 2,
      queued_event_id: "event:queued",
    } as const;
    expect(UserInputConsumedDataSchema.parse(consumed)).toEqual(consumed);
    expect(() => UserInputConsumedDataSchema.parse({ ...consumed, at_step: 0 })).toThrow();
    expect(() => UserInputConsumedDataSchema.parse({ ...consumed, at_step: MAX_USER_INPUT_STEP + 1 })).toThrow();
    expect(() => UserInputConsumedDataSchema.parse({ ...consumed, actor: "user" })).toThrow();

    expect(SubmitUserInputResultSchema.parse({
      input: pendingInput(),
      disposition: "queued",
    }).disposition).toBe("queued");
    expect(() => SubmitUserInputResultSchema.parse({
      input: {
        ...pendingInput(),
        consumed_at: "2026-09-19T01:00:01.000Z",
        consumed_at_step: 1,
      },
      disposition: "queued",
    })).toThrow("a newly queued input cannot already be consumed");
    expect(EventTypeSchema.parse("user.input_queued")).toBe("user.input_queued");
    expect(EventTypeSchema.parse("user.input_consumed")).toBe("user.input_consumed");
  });

  it("bounds the public queue and defaults old projections to an empty queue", () => {
    expect(InputQueueProjectionSchema.parse({ pending: [] })).toEqual({ pending: [] });
    expect(() => InputQueueProjectionSchema.parse({
      pending: [pendingInput(), pendingInput()],
    })).toThrow("pending input_id values must be unique");
    expect(() => InputQueueProjectionSchema.parse({
      pending: [pendingInput()],
      last_consumed: {
        input_id: "input:one",
        kind: "message",
        consumed_at: "2026-09-19T01:00:01.000Z",
        at_step: 1,
        queued_event_id: "event:queued",
      },
    })).toThrow("last consumed input cannot remain pending");
    expect(() => InputQueueProjectionSchema.parse({
      pending: Array.from({ length: MAX_PENDING_USER_INPUTS + 1 }, (_, index) => pendingInput({
        input_id: `input:${index}`,
      })),
    })).toThrow();

    const legacyProjection = RunProjectionSchema.parse({
      schema_version: SCHEMA_VERSION,
      projector_version: PROJECTOR_VERSION,
      project_id: "project:one",
      run_id: "run:one",
      task: "Old ledger",
      mode: "execute",
      workspace_kind: "disposable_fixture",
      status: "running",
      last_sequence: 1,
      timeline: [],
      todos: { items: [], last_sequence: 0 },
      artifact_refs: [],
    });
    expect(legacyProjection.input_queue).toEqual({ pending: [] });
    expect(() => RunProjectionSchema.parse({
      ...legacyProjection,
      input_queue: { pending: [pendingInput({ run_id: "run:smuggled" })] },
    })).toThrow("pending input run_id must match the projected Run");
  });
});
