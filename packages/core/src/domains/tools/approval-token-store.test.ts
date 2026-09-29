import { ApprovalTokenSchema } from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import {
  ApprovalTokenStore,
  ApprovalTokenStoreError,
  MAX_APPROVAL_TOKEN_TTL_MS,
  type ApprovalTokenStoreErrorCode,
  type ConsumeApprovalTokenInput,
} from "./approval-token-store.js";

describe("ApprovalTokenStore", () => {
  it("issues a frozen, canonical token and permits exactly one concurrent consumer", async () => {
    const clock = testClock();
    const store = new ApprovalTokenStore({
      now: clock.now,
      idFactory: () => "approval-token:one",
    });
    const token = store.issue(issueInput());

    expect(ApprovalTokenSchema.parse(token)).toEqual(token);
    expect(token.scope).toEqual(["src/app.ts", "src/other.ts"]);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.scope)).toBe(true);

    const consume = consumeInput(token.token_id);
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => store.consume({
        ...consume,
        scope: ["src/other.ts", "src/app.ts"],
      })),
      Promise.resolve().then(() => store.consume(consume)),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "approval_token_consumed" }),
    });
    expect(store.stats()).toEqual({ issued: 1, consumed: 1 });
  });

  it.each<{
    label: string;
    override: Partial<ConsumeApprovalTokenInput>;
    code: ApprovalTokenStoreErrorCode;
  }>([
    {
      label: "approval identity",
      override: { approvalId: "approval:other" },
      code: "approval_token_binding_mismatch",
    },
    {
      label: "project identity",
      override: { projectId: "project:other" },
      code: "approval_token_binding_mismatch",
    },
    {
      label: "Run identity",
      override: { runId: "run:other" },
      code: "approval_token_binding_mismatch",
    },
    {
      label: "action identity",
      override: { actionId: "action:other" },
      code: "approval_token_binding_mismatch",
    },
    {
      label: "action digest",
      override: { actionDigest: hash("c") },
      code: "approval_token_digest_mismatch",
    },
    {
      label: "policy digest",
      override: { policyDigest: hash("d") },
      code: "approval_token_policy_mismatch",
    },
    {
      label: "scope",
      override: { scope: ["src/different.ts"] },
      code: "approval_token_scope_mismatch",
    },
  ])("fails closed on a mismatched $label and burns the token", ({ override, code }) => {
    const store = new ApprovalTokenStore({ idFactory: () => "approval-token:mismatch" });
    const token = store.issue(issueInput());

    expectStoreError(
      () => store.consume({ ...consumeInput(token.token_id), ...override }),
      code,
    );
    expectStoreError(
      () => store.consume(consumeInput(token.token_id)),
      "approval_token_consumed",
    );
  });

  it("rejects an expired token at the exact expiry boundary and burns it", () => {
    const clock = testClock();
    const store = new ApprovalTokenStore({
      now: clock.now,
      idFactory: () => "approval-token:expiry",
      defaultTtlMs: 1_000,
    });
    const token = store.issue(issueInput());
    clock.advance(1_000);

    expectStoreError(
      () => store.consume(consumeInput(token.token_id)),
      "approval_token_expired",
    );
    expectStoreError(
      () => store.consume(consumeInput(token.token_id)),
      "approval_token_consumed",
    );
  });

  it("rejects unknown tokens, duplicate approvals, duplicate token ids, and exhausted capacity", () => {
    const unknownStore = new ApprovalTokenStore();
    expectStoreError(
      () => unknownStore.consume(consumeInput("approval-token:unknown")),
      "approval_token_unknown",
    );

    let nextTokenId = "approval-token:first";
    const conflictStore = new ApprovalTokenStore({ idFactory: () => nextTokenId, maxTokens: 3 });
    conflictStore.issue(issueInput());
    expectStoreError(
      () => conflictStore.issue(issueInput()),
      "approval_token_id_conflict",
    );
    expectStoreError(
      () => conflictStore.issue({ ...issueInput(), approvalId: "approval:two" }),
      "approval_token_id_conflict",
    );

    nextTokenId = "approval-token:second";
    conflictStore.issue({ ...issueInput(), approvalId: "approval:two" });
    nextTokenId = "approval-token:third";
    conflictStore.issue({ ...issueInput(), approvalId: "approval:three" });
    expectStoreError(
      () => conflictStore.issue({ ...issueInput(), approvalId: "approval:four" }),
      "approval_token_capacity",
    );
  });

  it("bounds token lifetimes and rejects non-positive store settings", () => {
    const clock = testClock();
    const store = new ApprovalTokenStore({
      now: clock.now,
      idFactory: () => "approval-token:ttl",
    });
    expectStoreError(
      () => store.issue({ ...issueInput(), expiresAt: clock.iso() }),
      "approval_token_expired",
    );
    expectStoreError(
      () => store.issue({
        ...issueInput(),
        expiresAt: new Date(clock.millis() + MAX_APPROVAL_TOKEN_TTL_MS + 1).toISOString(),
      }),
      "approval_token_expired",
    );
    expect(() => new ApprovalTokenStore({ defaultTtlMs: 0 })).toThrow(RangeError);
    expect(() => new ApprovalTokenStore({ maxTokens: 0 })).toThrow(RangeError);
  });
});

function issueInput() {
  return {
    approvalId: "approval:test",
    projectId: "project:test",
    runId: "run:test",
    actionId: "action:test",
    actionDigest: hash("a"),
    policyDigest: hash("b"),
    scope: ["src/other.ts", "src/app.ts"],
  };
}

function consumeInput(tokenId: string): ConsumeApprovalTokenInput {
  return {
    tokenId,
    approvalId: "approval:test",
    projectId: "project:test",
    runId: "run:test",
    actionId: "action:test",
    actionDigest: hash("a"),
    policyDigest: hash("b"),
    scope: ["src/app.ts", "src/other.ts"],
  };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function expectStoreError(operation: () => unknown, code: ApprovalTokenStoreErrorCode): void {
  try {
    operation();
    throw new Error(`Expected ApprovalTokenStoreError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalTokenStoreError);
    expect(error).toMatchObject({ code });
  }
}

function testClock() {
  let current = Date.parse("2026-09-19T00:00:00.000Z");
  return {
    now: () => new Date(current),
    millis: () => current,
    iso: () => new Date(current).toISOString(),
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}
