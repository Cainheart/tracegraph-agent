import {
  APPROVAL_TOKEN_FORMAT_VERSION,
  ApprovalTokenSchema,
  IdentifierSchema,
  RelativePathSchema,
  Sha256Schema,
  type ApprovalToken,
} from "@tracegraph/contracts";
import { defaultIdFactory, stableStringify } from "./crypto.js";

export const DEFAULT_APPROVAL_TOKEN_TTL_MS = 5 * 60_000;
export const MAX_APPROVAL_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_MAX_APPROVAL_TOKENS = 4_096;

export interface ApprovalTokenStoreOptions {
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  defaultTtlMs?: number;
  maxTokens?: number;
}

export interface IssueApprovalTokenInput {
  approvalId: string;
  projectId: string;
  runId: string;
  actionId: string;
  actionDigest: string;
  policyDigest: string;
  scope: readonly string[];
  expiresAt?: string;
}

export interface ConsumeApprovalTokenInput {
  tokenId: string;
  approvalId: string;
  projectId: string;
  runId: string;
  actionId: string;
  actionDigest: string;
  policyDigest: string;
  scope: readonly string[];
}

export type ApprovalTokenStoreErrorCode =
  | "approval_token_unknown"
  | "approval_token_expired"
  | "approval_token_consumed"
  | "approval_token_binding_mismatch"
  | "approval_token_digest_mismatch"
  | "approval_token_policy_mismatch"
  | "approval_token_scope_mismatch"
  | "approval_token_id_conflict"
  | "approval_token_capacity";

interface StoredApprovalToken {
  readonly token: ApprovalToken;
  consumedAt?: string;
}

/**
 * Process-local, Host-owned capability store. `issue()` and `consume()` are
 * deliberately synchronous: there is no await point between lookup, burn, and
 * validation, so two concurrent callers cannot both consume the same token.
 * Tokens are never reconstructed after a restart; recovery must issue a fresh
 * approval request and token.
 */
export class ApprovalTokenStore {
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #defaultTtlMs: number;
  readonly #maxTokens: number;
  readonly #records = new Map<string, StoredApprovalToken>();
  readonly #approvalBindings = new Map<string, string>();

  constructor(options: ApprovalTokenStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#defaultTtlMs = boundedPositiveInteger(
      options.defaultTtlMs ?? DEFAULT_APPROVAL_TOKEN_TTL_MS,
      "defaultTtlMs",
      MAX_APPROVAL_TOKEN_TTL_MS,
    );
    this.#maxTokens = boundedPositiveInteger(
      options.maxTokens ?? DEFAULT_MAX_APPROVAL_TOKENS,
      "maxTokens",
      1_000_000,
    );
  }

  issue(input: IssueApprovalTokenInput): ApprovalToken {
    if (this.#records.size >= this.#maxTokens) {
      throw new ApprovalTokenStoreError(
        "approval_token_capacity",
        "Approval token capacity is exhausted; issuance failed closed",
      );
    }
    const issuedAt = this.#now();
    const expiresAt = input.expiresAt === undefined
      ? new Date(issuedAt.getTime() + this.#defaultTtlMs)
      : parseDate(input.expiresAt, "expiresAt");
    if (expiresAt.getTime() <= issuedAt.getTime()) {
      throw new ApprovalTokenStoreError(
        "approval_token_expired",
        "Approval token expiry must be after issuance",
      );
    }
    if (expiresAt.getTime() - issuedAt.getTime() > MAX_APPROVAL_TOKEN_TTL_MS) {
      throw new ApprovalTokenStoreError(
        "approval_token_expired",
        `Approval token lifetime cannot exceed ${MAX_APPROVAL_TOKEN_TTL_MS}ms`,
      );
    }

    const approvalId = IdentifierSchema.parse(input.approvalId);
    if (this.#approvalBindings.has(approvalId)) {
      throw new ApprovalTokenStoreError(
        "approval_token_id_conflict",
        "An approval can issue only one one-time token",
      );
    }
    const tokenId = IdentifierSchema.parse(this.#idFactory("approval-token"));
    if (this.#records.has(tokenId)) {
      throw new ApprovalTokenStoreError(
        "approval_token_id_conflict",
        "Approval token id already exists",
      );
    }
    const token = freezeToken(ApprovalTokenSchema.parse({
      token_version: APPROVAL_TOKEN_FORMAT_VERSION,
      token_id: tokenId,
      approval_id: approvalId,
      project_id: IdentifierSchema.parse(input.projectId),
      run_id: IdentifierSchema.parse(input.runId),
      action_id: IdentifierSchema.parse(input.actionId),
      action_digest: Sha256Schema.parse(input.actionDigest),
      policy_digest: Sha256Schema.parse(input.policyDigest),
      scope: canonicalScope(input.scope),
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      single_use: true,
    }));
    this.#records.set(tokenId, { token });
    this.#approvalBindings.set(approvalId, tokenId);
    return token;
  }

  consume(input: ConsumeApprovalTokenInput): ApprovalToken {
    const tokenId = IdentifierSchema.parse(input.tokenId);
    const record = this.#records.get(tokenId);
    if (record === undefined) {
      throw new ApprovalTokenStoreError(
        "approval_token_unknown",
        "Approval token is unknown to this Host process",
      );
    }
    if (record.consumedAt !== undefined) {
      throw new ApprovalTokenStoreError(
        "approval_token_consumed",
        "Approval token has already been consumed",
      );
    }

    // Burn before checking claims. A failed integrity check is itself the one
    // allowed use; callers must request a fresh approval instead of retrying a
    // token whose binding has become uncertain.
    const consumedAt = this.#now();
    record.consumedAt = consumedAt.toISOString();
    const token = record.token;
    if (consumedAt.getTime() >= Date.parse(token.expires_at)) {
      throw new ApprovalTokenStoreError(
        "approval_token_expired",
        "Approval token expired before it could be consumed",
      );
    }

    const binding = {
      approval_id: IdentifierSchema.parse(input.approvalId),
      project_id: IdentifierSchema.parse(input.projectId),
      run_id: IdentifierSchema.parse(input.runId),
      action_id: IdentifierSchema.parse(input.actionId),
    };
    if (
      binding.approval_id !== token.approval_id
      || binding.project_id !== token.project_id
      || binding.run_id !== token.run_id
      || binding.action_id !== token.action_id
    ) {
      throw new ApprovalTokenStoreError(
        "approval_token_binding_mismatch",
        "Approval token does not belong to the requested project, Run, approval, and action",
      );
    }
    if (Sha256Schema.parse(input.actionDigest) !== token.action_digest) {
      throw new ApprovalTokenStoreError(
        "approval_token_digest_mismatch",
        "Approval token does not authorize the actual action digest",
      );
    }
    if (Sha256Schema.parse(input.policyDigest) !== token.policy_digest) {
      throw new ApprovalTokenStoreError(
        "approval_token_policy_mismatch",
        "Approval token was issued under a different effective policy",
      );
    }
    if (stableStringify(canonicalScope(input.scope)) !== stableStringify(token.scope)) {
      throw new ApprovalTokenStoreError(
        "approval_token_scope_mismatch",
        "Approval token scope does not match the actual action scope",
      );
    }
    return token;
  }

  /** Test/diagnostic surface; it never exposes claims or token identifiers. */
  stats(): { issued: number; consumed: number } {
    let consumed = 0;
    for (const record of this.#records.values()) {
      if (record.consumedAt !== undefined) consumed += 1;
    }
    return { issued: this.#records.size, consumed };
  }
}

function canonicalScope(scope: readonly string[]): string[] {
  if (scope.length === 0 || scope.length > 64) {
    throw new ApprovalTokenStoreError(
      "approval_token_scope_mismatch",
      "Approval token scope must contain between 1 and 64 paths",
    );
  }
  const parsed = scope
    .map((path) => RelativePathSchema.parse(path.replaceAll("\\", "/")))
    .sort((left, right) => left.localeCompare(right));
  if (new Set(parsed).size !== parsed.length) {
    throw new ApprovalTokenStoreError(
      "approval_token_scope_mismatch",
      "Approval token scope paths must be unique",
    );
  }
  return parsed;
}

function freezeToken(token: ApprovalToken): ApprovalToken {
  Object.freeze(token.scope);
  return Object.freeze(token);
}

function parseDate(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${name} must be a valid ISO date-time`);
  }
  return parsed;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

export class ApprovalTokenStoreError extends Error {
  constructor(readonly code: ApprovalTokenStoreErrorCode, message: string) {
    super(message);
    this.name = "ApprovalTokenStoreError";
  }
}
