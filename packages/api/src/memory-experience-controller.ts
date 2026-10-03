import {
  ExperienceControlListResponseSchema,
  ExperienceLifecycleReviewRequestSchema,
  ExperienceLifecycleReviewResponseSchema,
  IdentifierSchema,
  MemoryCandidateCreateRequestSchema,
  MemoryControlListResponseSchema,
  MemoryControlItemSchema,
  MemoryCorrectionRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryDeleteResponseSchema,
  MemoryExperienceControlCommandSchema,
  MemoryExperienceControlQuerySchema,
  MemoryExperienceControlReplySchema,
  MemoryReviewRequestSchema,
  MemoryRevokeRequestSchema,
  type ExperienceControlListResponse,
  type ExperienceLifecycleReviewRequest,
  type ExperienceLifecycleReviewResponse,
  type MemoryCandidateCreateRequest,
  type MemoryControlItem,
  type MemoryControlListResponse,
  type MemoryCorrectionRequest,
  type MemoryDeleteResponse,
  type MemoryExperienceControlReply,
  type MemoryReviewRequest,
  type MemoryRevokeRequest,
} from "@tracegraph/contracts";

export interface MemoryExperienceRuntimePort {
  listMemoryControl(scope: { allowedScopeIds: readonly string[] }): Promise<MemoryControlListResponse>;
  createMemoryCandidate(input: MemoryCandidateCreateRequest, scope: { allowedScopeIds: readonly string[] }): Promise<MemoryControlItem>;
  reviewMemory(memoryId: string, input: MemoryReviewRequest, scope: { allowedScopeIds: readonly string[] }): Promise<MemoryControlItem>;
  correctMemory(memoryId: string, input: MemoryCorrectionRequest, scope: { allowedScopeIds: readonly string[] }): Promise<MemoryControlItem>;
  revokeMemory(memoryId: string, input: MemoryRevokeRequest, scope: { allowedScopeIds: readonly string[] }): Promise<MemoryControlItem>;
  deleteMemory(memoryId: string, commandId: string, scope: { allowedScopeIds: readonly string[] }): Promise<{ deletedMemoryIds: readonly string[] }>;
  listExperienceCases(scope: { allowedScopeIds: readonly string[] }): ReturnType<ExperienceRuntimeList>;
  reviewExperienceCase(caseId: string, input: {
    action: ExperienceLifecycleReviewRequest["action"];
    expectedSequence: number;
    commandId: string;
  }, scope: { allowedScopeIds: readonly string[] }): Promise<ExperienceLifecycleReviewResponse>;
}

type ExperienceRuntimeList = () => Promise<ExperienceControlListResponse["items"]>;

export interface MemoryExperienceControllerOptions {
  readonly runtime: MemoryExperienceRuntimePort;
  /** Must resolve current Host registrations for every request. */
  readonly getProjectIds: () => readonly string[];
}

export class MemoryExperienceControllerError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryExperienceControllerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Transport-neutral application controller shared by Web routes and Desktop RPC. */
export class MemoryExperienceController {
  readonly #runtime: MemoryExperienceRuntimePort;
  readonly #getProjectIds: () => readonly string[];

  constructor(options: MemoryExperienceControllerOptions) {
    this.#runtime = options.runtime;
    this.#getProjectIds = options.getProjectIds;
  }

  listMemoryControl(): Promise<MemoryControlListResponse> {
    return this.#run(() => this.#runtime.listMemoryControl(this.#scope()).then((value) => MemoryControlListResponseSchema.parse(value)));
  }

  createMemoryCandidate(inputValue: unknown): Promise<MemoryControlItem> {
    const input = MemoryCandidateCreateRequestSchema.parse(inputValue);
    return this.#run(() => this.#runtime.createMemoryCandidate(input, this.#scope()).then((value) => MemoryControlItemSchema.parse(value)));
  }

  reviewMemory(memoryIdValue: string, inputValue: unknown): Promise<MemoryControlItem> {
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    const input = MemoryReviewRequestSchema.parse(inputValue);
    return this.#run(() => this.#runtime.reviewMemory(memoryId, input, this.#scope()).then((value) => MemoryControlItemSchema.parse(value)));
  }

  correctMemory(memoryIdValue: string, inputValue: unknown): Promise<MemoryControlItem> {
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    const input = MemoryCorrectionRequestSchema.parse(inputValue);
    return this.#run(() => this.#runtime.correctMemory(memoryId, input, this.#scope()).then((value) => MemoryControlItemSchema.parse(value)));
  }

  revokeMemory(memoryIdValue: string, inputValue: unknown): Promise<MemoryControlItem> {
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    const input = MemoryRevokeRequestSchema.parse(inputValue);
    return this.#run(() => this.#runtime.revokeMemory(memoryId, input, this.#scope()).then((value) => MemoryControlItemSchema.parse(value)));
  }

  deleteMemory(memoryIdValue: string, inputValue: unknown): Promise<MemoryDeleteResponse> {
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    const input = MemoryDeleteRequestSchema.parse(inputValue);
    return this.#run(() => this.#runtime.deleteMemory(memoryId, input.command_id, this.#scope()).then((value) => MemoryDeleteResponseSchema.parse(value)));
  }

  listExperienceCases(): Promise<ExperienceControlListResponse> {
    return this.#run(() => this.#runtime.listExperienceCases(this.#scope()).then((items) => ExperienceControlListResponseSchema.parse({ items })));
  }

  dispatchQuery(queryValue: unknown): Promise<MemoryExperienceControlReply> {
    const query = MemoryExperienceControlQuerySchema.parse(queryValue);
    if (query.operation === "memory.list") {
      return this.listMemoryControl().then((value) => MemoryExperienceControlReplySchema.parse({ resource: "memory_control", value }));
    }
    return this.listExperienceCases().then((value) => MemoryExperienceControlReplySchema.parse({ resource: "experience_cases", value }));
  }

  dispatchCommand(commandValue: unknown): Promise<MemoryExperienceControlReply> {
    const command = MemoryExperienceControlCommandSchema.parse(commandValue);
    let operation: Promise<unknown>;
    let resource: MemoryExperienceControlReply["resource"];
    switch (command.type) {
      case "memory.create":
        resource = "memory_item";
        operation = this.createMemoryCandidate(command.input);
        break;
      case "memory.review":
        resource = "memory_item";
        operation = this.reviewMemory(command.memory_id, command.input);
        break;
      case "memory.correct":
        resource = "memory_item";
        operation = this.correctMemory(command.memory_id, command.input);
        break;
      case "memory.revoke":
        resource = "memory_item";
        operation = this.revokeMemory(command.memory_id, command.input);
        break;
      case "memory.delete":
        resource = "memory_delete";
        operation = this.deleteMemory(command.memory_id, command.input);
        break;
      case "experience.review":
        resource = "experience_case";
        operation = this.reviewExperienceCase(command.case_id, command.input);
        break;
      default:
        throw new TypeError("Unsupported Memory/Experience control command");
    }
    return this.#run(async () => MemoryExperienceControlReplySchema.parse({ resource, value: await operation }));
  }

  reviewExperienceCase(caseIdValue: string, inputValue: unknown): Promise<ExperienceLifecycleReviewResponse> {
    const caseId = IdentifierSchema.parse(caseIdValue);
    const input = ExperienceLifecycleReviewRequestSchema.parse(inputValue);
    return this.#run(() => this.#runtime.reviewExperienceCase(caseId, {
      action: input.action,
      expectedSequence: input.expected_sequence,
      commandId: input.command_id,
    }, this.#scope()).then((value) => ExperienceLifecycleReviewResponseSchema.parse(value)));
  }

  #scope(): { allowedScopeIds: readonly string[] } {
    return { allowedScopeIds: [...new Set(this.#getProjectIds())] };
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return operation().catch((error: unknown) => { throw normalizeDomainError(error); });
    } catch (error) {
      return Promise.reject(normalizeDomainError(error));
    }
  }
}

function normalizeDomainError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return error;
  if ("statusCode" in error && typeof error.statusCode === "number") return error;
  const code = error.code;
  if (!code.startsWith("experience_")) return error;
  const statusCode = code.endsWith("not_found") || code.endsWith("scope_denied") ? 404
    : code.endsWith("conflict") ? 409
      : code.endsWith("invalid") ? 400
        : 500;
  const message = error instanceof Error ? error.message : "Experience request failed";
  return new MemoryExperienceControllerError(code, statusCode, message, { cause: error });
}
