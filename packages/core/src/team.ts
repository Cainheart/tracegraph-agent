import {
  DEFAULT_TEAM_LIMITS,
  IdentifierSchema,
  TEAM_COORDINATOR_ADDRESS,
  TEAM_EVENT_DATA_SCHEMAS,
  TeamActorSchema,
  TeamCommandSchema,
  TeamCreatedDataSchema,
  TeamHeartbeatDataSchema,
  TeamLimitsSchema,
  TeamMailboxClaimedDataSchema,
  TeamMailboxDeliveredDataSchema,
  TeamMemberJoinedDataSchema,
  TeamMemberLostDataSchema,
  TeamProjectionSchema,
  TeamSweepCompletedDataSchema,
  TeamTaskBlockedDataSchema,
  TeamTaskCancelledDataSchema,
  TeamTaskClaimedDataSchema,
  TeamTaskCompletedDataSchema,
  TeamTaskCreatedDataSchema,
  TeamTaskReopenedDataSchema,
  SessionEventProposalSchema,
  SubagentCompletedDataSchema,
  SubagentFailedDataSchema,
  SubagentInterruptedDataSchema,
  SubagentStartedDataSchema,
  isTerminalEventType,
  type MailboxMessage,
  type SessionEvent,
  type SessionEventProposal,
  type SubagentStartedData,
  type SubagentRunLink,
  type TaskBoardItem,
  type TeamActor,
  type TeamCommand,
  type TeamLimits,
  type TeamMember,
  type TeamProjection,
} from "@tracegraph/contracts";
import {
  defaultIdFactory,
  redactSensitiveText,
  redactStructuredArtifactValue,
  sha256,
  stableStringify,
} from "./crypto.js";
import type { AtomicAppendResult, AtomicEventScope } from "./event-ledger.js";
import { isEligibleTodoCompletionEvidence } from "./todo.js";

export type TeamDomainErrorCode =
  | "run_not_found"
  | "run_scope_mismatch"
  | "run_terminal"
  | "team_not_found"
  | "team_already_exists"
  | "team_required_root_run"
  | "team_capacity_exceeded"
  | "member_not_found"
  | "member_already_joined"
  | "member_not_active"
  | "member_join_proof_missing"
  | "member_join_proof_invalid"
  | "heartbeat_not_advanced"
  | "heartbeat_not_expired"
  | "mailbox_capacity_exceeded"
  | "mailbox_message_not_found"
  | "mailbox_message_already_exists"
  | "mailbox_message_already_claimed"
  | "mailbox_recipient_invalid"
  | "task_capacity_exceeded"
  | "task_not_found"
  | "task_already_exists"
  | "task_version_conflict"
  | "task_state_conflict"
  | "task_owner_conflict"
  | "task_evidence_invalid"
  | "authority_denied"
  | "command_id_reserved"
  | "idempotency_conflict"
  | "invalid_team_event";

export class TeamDomainError extends Error {
  constructor(
    readonly code: TeamDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeamDomainError";
  }
}

export interface TeamEventLedger {
  list(runId: string): Promise<SessionEvent[]>;
  append(proposal: SessionEventProposal): Promise<SessionEvent>;
  appendAtomic(
    scope: AtomicEventScope,
    proposals: readonly SessionEventProposal[],
    finalize?: (resolved: readonly SessionEvent[]) => SessionEventProposal,
  ): Promise<AtomicAppendResult>;
}

export interface TeamCommandScope {
  readonly projectId: string;
  readonly runId: string;
  readonly sessionId?: string;
  /** Trusted Runtime identity. It is never copied from model Tool input. */
  readonly actor: TeamActor;
  /**
   * Trusted child action boundary for evidence validation. Runtime supplies
   * this only for an in-flight member Tool; it is never model-controlled.
   */
  readonly evidenceBeforeActionId?: string;
}

export interface TeamDomainServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  /** Frozen into team.created. Runtime normally caps this to its G-07 permit ceiling. */
  readonly defaultLimits?: Partial<TeamLimits>;
  /**
   * Trusted cross-ledger verifier. Runtime binds this to the member's exact
   * canonical child Run; model input supplies only opaque evidence ids.
   */
  readonly evidenceResolver?: (input: {
    readonly projectId: string;
    readonly coordinatorRunId: string;
    readonly member: TeamMember;
    readonly evidenceEventIds: readonly string[];
    readonly beforeActionId?: string;
  }) => boolean | Promise<boolean>;
}

const TEAM_EVENT_TYPES = new Set<SessionEvent["type"]>(
  Object.keys(TEAM_EVENT_DATA_SCHEMAS) as SessionEvent["type"][],
);

export const INTERNAL_TEAM_COMMAND_PREFIXES = Object.freeze([
  "team-expire:",
  "team-join:",
  "team-retire:",
  "team-tool:",
] as const);

/**
 * Rebuild one root Run's complete G-08 state from its canonical Event Ledger.
 * No side store or process memory is consulted, so restart is ordinary replay.
 */
export function projectTeam(events: readonly SessionEvent[]): TeamProjection | undefined {
  const first = events[0];
  if (first === undefined || first.type !== "run.created") {
    throw new TeamDomainError("run_not_found", "run.created must precede team events");
  }

  let team: TeamProjection | undefined;
  const members = new Map<string, TeamMember>();
  const messages = new Map<string, MailboxMessage>();
  const messageDeliveryEvents = new Map<string, string>();
  const tasks = new Map<string, TaskBoardItem>();
  const heartbeatLosses: Array<{
    readonly event: SessionEvent;
    readonly data: ReturnType<typeof TeamMemberLostDataSchema.parse>;
  }> = [];
  const heartbeatLossByEventId = new Map<string, {
    readonly event: SessionEvent;
    readonly data: ReturnType<typeof TeamMemberLostDataSchema.parse>;
  }>();
  const heartbeatLossByOperationId = new Map<string, SessionEvent>();
  let rosterLastSequence = 0;
  let mailboxLastSequence = 0;
  let taskLastSequence = 0;
  let teamLastSequence = 0;
  let terminalSeen = false;

  for (const event of events) {
    if (isTerminalEventType(event.type)) terminalSeen = true;
    if (!isTeamEventType(event.type)) continue;
    if (terminalSeen) {
      throw new TeamDomainError(
        "invalid_team_event",
        `${event.type} cannot follow a terminal Run event at sequence ${event.sequence}`,
      );
    }
    if (event.project_id !== first.project_id || event.run_id !== first.run_id || event.session_id !== first.session_id) {
      throw new TeamDomainError("run_scope_mismatch", `Team event scope mismatch at sequence ${event.sequence}`);
    }
    const data = parseTeamEventData(event);

    if (event.type === "team.created") {
      const created = TeamCreatedDataSchema.parse(data);
      if (team !== undefined) {
        throw new TeamDomainError("team_already_exists", "A Run cannot contain two team.created events");
      }
      if (created.coordinator_run_id !== event.run_id || typeof first.data.parent_run_id === "string") {
        throw new TeamDomainError("team_required_root_run", "A team coordinator must be a root Run");
      }
      team = TeamProjectionSchema.parse({
        team_id: created.team_id,
        coordinator_run_id: created.coordinator_run_id,
        limits: created.limits,
        created_event_id: event.event_id,
        created_at: created.created_at,
        roster: { members: [], last_sequence: 0 },
        mailbox: { messages: [], last_sequence: 0 },
        task_board: { items: [], last_sequence: 0 },
        last_sequence: event.sequence,
      });
      teamLastSequence = event.sequence;
      continue;
    }

    if (team === undefined) {
      throw new TeamDomainError("team_not_found", `${event.type} precedes team.created`);
    }
    if (data.team_id !== team.team_id) {
      throw new TeamDomainError("invalid_team_event", `${event.type} changes the immutable team_id`);
    }

    switch (event.type) {
      case "team.member_joined": {
        const parsed = TeamMemberJoinedDataSchema.parse(data);
        const member = publicMember(parsed.member);
        const memberId = member.link.subagent_id;
        if (members.has(memberId)) {
          throw new TeamDomainError("member_already_joined", `Team member ${memberId} joined twice`);
        }
        if (members.size >= team.limits.max_members || activeMemberCount(members) >= team.limits.max_parallel_workers) {
          throw new TeamDomainError("team_capacity_exceeded", "Team member limits were exceeded during replay");
        }
        assertDirectSubagentProof(events, event.sequence, member.link, member.role);
        assertTimestampNotBefore(member.joined_at, team.created_at, "Member join precedes team creation");
        if (hasPriorSubagentTerminalProof(events, event.sequence, member.link)) {
          throw new TeamDomainError(
            "invalid_team_event",
            `Terminal subagent ${memberId} cannot replay as an active team member`,
          );
        }
        members.set(memberId, member);
        rosterLastSequence = event.sequence;
        break;
      }
      case "team.heartbeat": {
        const parsed = TeamHeartbeatDataSchema.parse(data);
        const memberId = parsed.member.link.subagent_id;
        const current = requireMember(members, memberId);
        if (current.status !== "active") {
          throw new TeamDomainError("member_not_active", `Lost member ${memberId} cannot heartbeat`);
        }
        if (parsed.previous_heartbeat_at !== current.last_heartbeat_at) {
          throw new TeamDomainError("invalid_team_event", "Heartbeat previous value does not match replayed state");
        }
        if (Date.parse(parsed.member.last_heartbeat_at) <= Date.parse(current.last_heartbeat_at)) {
          throw new TeamDomainError("invalid_team_event", "Heartbeat time must advance during replay");
        }
        assertSameMemberIdentity(current, parsed.member);
        members.set(memberId, publicMember(parsed.member));
        rosterLastSequence = event.sequence;
        break;
      }
      case "team.member_lost": {
        const parsed = TeamMemberLostDataSchema.parse(data);
        const memberId = parsed.member.link.subagent_id;
        const current = requireMember(members, memberId);
        if (current.status !== "active" || parsed.last_heartbeat_at !== current.last_heartbeat_at) {
          throw new TeamDomainError("invalid_team_event", "Member loss does not match the active roster state");
        }
        assertSameMemberIdentity(current, parsed.member);
        if (
          parsed.reason === "heartbeat_timeout"
          && Date.parse(parsed.lost_at) - Date.parse(current.last_heartbeat_at) < team.limits.heartbeat_timeout_ms
        ) {
          throw new TeamDomainError("invalid_team_event", "Member loss precedes the frozen heartbeat timeout");
        }
        if (
          parsed.reason === "worker_terminal"
          && !hasPriorSubagentTerminalProof(events, event.sequence, current.link)
        ) {
          throw new TeamDomainError("invalid_team_event", "Terminal member loss requires a prior exact subagent terminal proof");
        }
        const claimedTaskIds = [...tasks.values()]
          .filter((task) => task.state === "claimed" && task.owner === memberId)
          .map(({ task_id: taskId }) => taskId)
          .sort();
        if (stableStringify(claimedTaskIds) !== stableStringify([...parsed.reopened_task_ids].sort())) {
          throw new TeamDomainError(
            "invalid_team_event",
            "team.member_lost must atomically reopen every claimed task owned by the member",
          );
        }
        members.set(memberId, publicMember(parsed.member));
        for (const taskId of claimedTaskIds) {
          const currentTask = tasks.get(taskId)!;
          assertTimestampNotBefore(
            parsed.lost_at,
            currentTask.updated_at,
            `Member loss clock precedes claimed task ${taskId}`,
          );
          tasks.set(taskId, publicTask({
            ...currentTask,
            state: "open",
            owner: undefined,
            evidence_event_ids: [],
            version: currentTask.version + 1,
            updated_at: parsed.lost_at,
          }));
        }
        rosterLastSequence = event.sequence;
        if (claimedTaskIds.length > 0) taskLastSequence = event.sequence;
        if (parsed.reason === "heartbeat_timeout") {
          if (event.operation_id === undefined || heartbeatLossByOperationId.has(event.operation_id)) {
            throw new TeamDomainError("invalid_team_event", "Heartbeat-timeout member loss operation must be unique");
          }
          const indexed = { event, data: parsed };
          heartbeatLosses.push(indexed);
          heartbeatLossByEventId.set(event.event_id, indexed);
          heartbeatLossByOperationId.set(event.operation_id, event);
        }
        break;
      }
      case "team.sweep_completed": {
        const parsed = TeamSweepCompletedDataSchema.parse(data);
        if (event.operation_id === undefined) {
          throw new TeamDomainError("invalid_team_event", "Team sweep receipt is missing its command operation_id");
        }
        assertTimestampNotBefore(parsed.swept_at, team.created_at, "Team sweep precedes team creation");
        const expectedLostEventIds = heartbeatLosses
          .filter(({ event: candidate, data: lost }) => (
            candidate.operation_id === `team-expire:${sha256(
              `${event.operation_id}:${lost.member.link.subagent_id}`,
            )}`
          ))
          .map(({ event: { event_id: eventId } }) => eventId);
        if (stableStringify(expectedLostEventIds) !== stableStringify(parsed.member_lost_event_ids)) {
          throw new TeamDomainError(
            "invalid_team_event",
            "Team sweep receipt must reference exactly its prior heartbeat-timeout member losses",
          );
        }
        for (const eventId of parsed.member_lost_event_ids) {
          const lost = heartbeatLossByEventId.get(eventId);
          if (lost === undefined || lost.event.sequence >= event.sequence) {
            throw new TeamDomainError("invalid_team_event", "Team sweep references a missing or future member loss");
          }
          if (lost.data.lost_at !== parsed.swept_at) {
            throw new TeamDomainError("invalid_team_event", "Team sweep loss time does not match swept_at");
          }
        }
        break;
      }
      case "team.mailbox_delivered": {
        const parsed = TeamMailboxDeliveredDataSchema.parse(data);
        const message = publicMessage(parsed.message);
        if (messages.has(message.message_id)) {
          throw new TeamDomainError("mailbox_message_already_exists", `Duplicate message ${message.message_id}`);
        }
        if (messages.size >= team.limits.max_mailbox_messages) {
          throw new TeamDomainError("mailbox_capacity_exceeded", "Team mailbox limit was exceeded during replay");
        }
        assertTimestampNotBefore(message.delivered_at, team.created_at, "Mailbox delivery precedes team creation");
        assertActiveAddress(members, message.from);
        assertActiveAddress(members, message.to);
        messages.set(message.message_id, message);
        messageDeliveryEvents.set(message.message_id, event.event_id);
        mailboxLastSequence = event.sequence;
        break;
      }
      case "team.mailbox_claimed": {
        const parsed = TeamMailboxClaimedDataSchema.parse(data);
        const messageId = parsed.message.message_id;
        const current = messages.get(messageId);
        if (current === undefined) {
          throw new TeamDomainError("mailbox_message_not_found", `Unknown message ${messageId}`);
        }
        if (current.claimed_at !== undefined) {
          throw new TeamDomainError("mailbox_message_already_claimed", `Message ${messageId} was claimed twice`);
        }
        if (messageDeliveryEvents.get(messageId) !== parsed.delivered_event_id) {
          throw new TeamDomainError("invalid_team_event", "Mailbox claim does not reference its delivery event");
        }
        const claimed = publicMessage(parsed.message);
        if (!sameMessageDelivery(current, claimed) || claimed.claimed_by !== current.to) {
          throw new TeamDomainError("invalid_team_event", "Mailbox claim changes immutable delivery facts");
        }
        assertActiveAddress(members, claimed.claimed_by);
        messages.set(messageId, claimed);
        mailboxLastSequence = event.sequence;
        break;
      }
      case "team.task_created": {
        const parsed = TeamTaskCreatedDataSchema.parse(data);
        const task = publicTask(parsed.task);
        if (tasks.has(task.task_id)) {
          throw new TeamDomainError("task_already_exists", `Duplicate task ${task.task_id}`);
        }
        if (tasks.size >= team.limits.max_tasks) {
          throw new TeamDomainError("task_capacity_exceeded", "Team task limit was exceeded during replay");
        }
        assertTimestampNotBefore(task.created_at, team.created_at, "Task creation precedes team creation");
        tasks.set(task.task_id, task);
        taskLastSequence = event.sequence;
        break;
      }
      case "team.task_claimed":
      case "team.task_completed":
      case "team.task_blocked":
      case "team.task_cancelled":
      case "team.task_reopened": {
        const parsed = parseTaskTransition(event, data);
        const current = tasks.get(parsed.task.task_id);
        if (current === undefined) {
          throw new TeamDomainError("task_not_found", `Unknown task ${parsed.task.task_id}`);
        }
        if (
          current.version !== parsed.previous_version
          || current.state !== parsed.previous_state
          || current.owner !== parsed.previous_owner
        ) {
          throw new TeamDomainError("invalid_team_event", `${event.type} previous task revision does not match`);
        }
        const next = publicTask(parsed.task);
        assertTaskIdentity(current, next);
        assertTimestampNotBefore(next.updated_at, current.updated_at, "Task update time moved backwards");
        if (event.type === "team.task_claimed") {
          assertActiveAddress(members, next.owner);
        }
        // Live command handling verifies evidence against the exact member
        // child ledger. Replay deliberately does not reach into another file:
        // the committed root event is the durable validation receipt.
        tasks.set(next.task_id, next);
        taskLastSequence = event.sequence;
        break;
      }
      default:
        break;
    }
    teamLastSequence = event.sequence;
  }

  if (team === undefined) return undefined;
  return TeamProjectionSchema.parse({
    ...team,
    roster: { members: [...members.values()], last_sequence: rosterLastSequence },
    mailbox: { messages: [...messages.values()], last_sequence: mailboxLastSequence },
    task_board: { items: [...tasks.values()], last_sequence: taskLastSequence },
    last_sequence: teamLastSequence,
  });
}

/**
 * Ledger-backed team command service. Per-root serialization makes the read,
 * authority check, and append one process-local critical section; the first
 * durable claim sequence wins and every later claimant observes that owner.
 */
export class TeamDomainService {
  readonly #ledger: TeamEventLedger;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #defaultLimits: TeamLimits;
  readonly #evidenceResolver: TeamDomainServiceOptions["evidenceResolver"];
  readonly #queues = new Map<string, Promise<void>>();

  constructor(ledger: TeamEventLedger, options: TeamDomainServiceOptions = {}) {
    this.#ledger = ledger;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#defaultLimits = TeamLimitsSchema.parse({
      ...DEFAULT_TEAM_LIMITS,
      ...options.defaultLimits,
    });
    this.#evidenceResolver = options.evidenceResolver;
  }

  async read(runIdValue: string): Promise<TeamProjection | undefined> {
    const runId = IdentifierSchema.parse(runIdValue);
    await this.#queues.get(runId);
    return projectTeam(await this.#ledger.list(runId));
  }

  execute(scopeValue: TeamCommandScope, commandValue: TeamCommand): Promise<TeamProjection> {
    const scope = {
      projectId: IdentifierSchema.parse(scopeValue.projectId),
      runId: IdentifierSchema.parse(scopeValue.runId),
      ...(scopeValue.sessionId === undefined ? {} : { sessionId: IdentifierSchema.parse(scopeValue.sessionId) }),
      actor: TeamActorSchema.parse(scopeValue.actor),
      ...(scopeValue.evidenceBeforeActionId === undefined
        ? {}
        : { evidenceBeforeActionId: IdentifierSchema.parse(scopeValue.evidenceBeforeActionId) }),
    };
    const command = TeamCommandSchema.parse(commandValue);
    assertStableCommandIdentifiers(command);
    assertInternalCommandAuthority(scope.actor, command.command_id);
    return this.#serialize(scope.runId, async () => this.#execute(scope, command));
  }

  /**
   * Create the Team and enroll the direct workers that are running at the
   * creation boundary in one durable ledger replacement. A lost-response
   * retry returns the already-committed projection and never enrolls workers
   * started after that creation boundary.
   */
  createWithRunningMembers(
    scopeValue: TeamCommandScope,
    commandIdValue: string,
    startedValues: readonly SubagentStartedData[],
  ): Promise<TeamProjection> {
    const commandId = IdentifierSchema.parse(commandIdValue);
    const scope = normalizeTeamScope(scopeValue);
    assertCoordinator(scope.actor, "Only the coordinator may create a team");
    assertExternalTeamCommandId(commandId);
    const started = startedValues.map((value) => SubagentStartedDataSchema.parse(value));
    return this.#serialize(scope.runId, async () => {
      const events = await this.#ledger.list(scope.runId);
      assertScope(events, scope);
      const command = TeamCommandSchema.parse({ command_id: commandId, operation: "create_team" });
      const commandDigest = teamCommandDigest(scope, command);
      const idempotencyKey = teamCommandIdempotencyKey(commandId);
      const duplicate = events.find((event) => event.idempotency_key === idempotencyKey);
      const current = projectTeam(events);
      if (duplicate !== undefined && (
        duplicate.type !== "team.created"
        || duplicate.data._internal_command_digest !== commandDigest
      )) {
        throw new TeamDomainError("idempotency_conflict", "Team command id was reused with a different operation");
      }
      if (duplicate !== undefined) {
        if (current === undefined) throw new TeamDomainError("invalid_team_event", "Idempotent Team creation did not replay");
        return current;
      }
      if (incompleteHeartbeatSweepLosses(events).length > 0) {
        throw new TeamDomainError(
          "idempotency_conflict",
          "An incomplete legacy heartbeat sweep must be repaired before Team creation recovery",
        );
      }
      if (events.some((event) => isTerminalEventType(event.type))) {
        throw new TeamDomainError("run_terminal", "A terminal Run cannot mutate team state");
      }
      if (current !== undefined) {
        throw new TeamDomainError("team_already_exists", "Run already has a team");
      }
      if (typeof events[0]?.data.parent_run_id === "string") {
        throw new TeamDomainError("team_required_root_run", "A child Run cannot become a team coordinator");
      }

      const timestamp = this.#now().toISOString();
      const teamId = this.#idFactory("team");
      const proposals: SessionEventProposal[] = [];
      proposals.push(this.#proposal(
        scope,
        command,
        idempotencyKey,
        "team.created",
        "Agent team created",
        {
          team_id: teamId,
          coordinator_run_id: scope.runId,
          limits: this.#defaultLimits,
          created_at: timestamp,
          _internal_command_digest: commandDigest,
        },
      ));

      const candidates = uniqueRunningMemberProofs(events, started, scope);
      if (
        candidates.length > this.#defaultLimits.max_members
        || candidates.length > this.#defaultLimits.max_parallel_workers
      ) {
        throw new TeamDomainError("team_capacity_exceeded", "Team worker limit is full");
      }
      const joinScope: NormalizedTeamScope = { ...scope, actor: { kind: "lead" } };
      for (const proof of candidates) {
        const joinCommand = TeamCommandSchema.parse({
          command_id: internalJoinCommandId(scope.runId, proof.link.subagent_id),
          operation: "join_member",
          subagent_id: proof.link.subagent_id,
          role: proof.spec.name,
        });
        const joinKey = teamCommandIdempotencyKey(joinCommand.command_id);
        assertUnoccupiedInternalCommand(events, joinKey, joinCommand.command_id);
        const joinDigest = teamCommandDigest(joinScope, joinCommand);
        proposals.push(this.#proposal(
          joinScope,
          joinCommand,
          joinKey,
          "team.member_joined",
          "Team worker joined",
          {
            team_id: teamId,
            member: activeMemberFromProof(proof, timestamp),
            _internal_command_digest: joinDigest,
          },
        ));
      }
      if (proposals.length > 0) {
        await this.#ledger.appendAtomic(atomicScope(scope), proposals);
      }
      const replayed = projectTeam(await this.#ledger.list(scope.runId));
      if (replayed === undefined) throw new TeamDomainError("invalid_team_event", "Team creation did not replay");
      return replayed;
    });
  }

  /** Append a G-07 start proof and its Team enrollment as one hash-chain tail. */
  appendStartedAndJoin(
    scopeValue: TeamCommandScope,
    startedProposalValue: SessionEventProposal,
  ): Promise<TeamProjection> {
    const scope = normalizeTeamScope(scopeValue);
    assertCoordinator(scope.actor, "Only the coordinator may enroll a started worker");
    const startedProposal = SessionEventProposalSchema.parse(startedProposalValue);
    if (startedProposal.type !== "subagent.started") {
      throw new TeamDomainError("member_join_proof_invalid", "Atomic member enrollment requires subagent.started");
    }
    if (startedProposal.idempotency_key === undefined) {
      throw new TeamDomainError("member_join_proof_invalid", "Atomic member enrollment requires a durable start receipt");
    }
    const started = SubagentStartedDataSchema.parse(startedProposal.data);
    return this.#serialize(scope.runId, async () => {
      const events = await this.#ledger.list(scope.runId);
      assertScope(events, scope);
      const current = projectTeam(events);
      if (current === undefined) throw new TeamDomainError("team_not_found", "Run has no team");
      const startedDuplicate = startedProposal.idempotency_key === undefined
        ? undefined
        : events.find((event) => event.idempotency_key === startedProposal.idempotency_key);
      if (startedDuplicate !== undefined) {
        const duplicateData = startedDuplicate.type === "subagent.started"
          ? SubagentStartedDataSchema.safeParse(startedDuplicate.data)
          : undefined;
        if (
          duplicateData?.success !== true
          || stableStringify(duplicateData.data) !== stableStringify(started)
        ) {
          throw new TeamDomainError("idempotency_conflict", "Subagent start id was reused for another worker");
        }
        const joined = current.roster.members.find(({ link }) => link.subagent_id === started.link.subagent_id);
        if (joined !== undefined) {
          if (!sameLink(joined.link, started.link) || joined.role !== started.spec.name) {
            throw new TeamDomainError("idempotency_conflict", "Subagent start retry conflicts with the Team roster");
          }
          return current;
        }
      }
      if (incompleteHeartbeatSweepLosses(events).length > 0) {
        throw new TeamDomainError(
          "idempotency_conflict",
          "An incomplete legacy heartbeat sweep must be repaired before member enrollment",
        );
      }
      if (events.some((event) => isTerminalEventType(event.type))) {
        throw new TeamDomainError("run_terminal", "A terminal Run cannot mutate team state");
      }
      assertProposalScope(startedProposal, scope);
      assertDirectStartedData(started, scope);
      if (current.roster.members.some(({ link }) => link.subagent_id === started.link.subagent_id)) {
        throw new TeamDomainError("member_already_joined", `Member ${started.link.subagent_id} already joined`);
      }
      if (
        current.roster.members.length >= current.limits.max_members
        || activeMemberCount(new Map(current.roster.members.map((member) => [member.link.subagent_id, member])))
          >= current.limits.max_parallel_workers
      ) {
        throw new TeamDomainError("team_capacity_exceeded", "Team worker limit is full");
      }
      const timestamp = this.#now().toISOString();
      assertTimestampNotBefore(timestamp, current.created_at, "Member join clock precedes team creation");
      const joinScope: NormalizedTeamScope = { ...scope, actor: { kind: "lead" } };
      const joinCommand = TeamCommandSchema.parse({
        command_id: internalJoinCommandId(scope.runId, started.link.subagent_id),
        operation: "join_member",
        subagent_id: started.link.subagent_id,
        role: started.spec.name,
      });
      const joinKey = teamCommandIdempotencyKey(joinCommand.command_id);
      assertUnoccupiedInternalCommand(events, joinKey, joinCommand.command_id);
      const joinProposal = this.#proposal(
        joinScope,
        joinCommand,
        joinKey,
        "team.member_joined",
        "Team worker joined",
        {
          team_id: current.team_id,
          member: activeMemberFromProof(started, timestamp),
          _internal_command_digest: teamCommandDigest(joinScope, joinCommand),
        },
      );
      await this.#ledger.appendAtomic(atomicScope(scope), [startedProposal, joinProposal]);
      const replayed = projectTeam(await this.#ledger.list(scope.runId));
      if (replayed === undefined) throw new TeamDomainError("invalid_team_event", "Atomic member enrollment did not replay");
      return replayed;
    });
  }

  /** Sweep uses the team's frozen timeout; callers cannot supply a shorter eviction window. */
  expireMembers(scopeValue: TeamCommandScope, commandIdPrefixValue: string): Promise<TeamProjection> {
    const commandIdPrefix = IdentifierSchema.parse(commandIdPrefixValue);
    if (redactSensitiveText(commandIdPrefix) !== commandIdPrefix) {
      throw new TeamDomainError("invalid_team_event", "Team sweep command id cannot contain a sensitive value");
    }
    const scope = {
      projectId: IdentifierSchema.parse(scopeValue.projectId),
      runId: IdentifierSchema.parse(scopeValue.runId),
      ...(scopeValue.sessionId === undefined ? {} : { sessionId: IdentifierSchema.parse(scopeValue.sessionId) }),
      actor: TeamActorSchema.parse(scopeValue.actor),
    };
    assertCoordinator(scope.actor, "Only the coordinator may expire team members");
    assertExternalTeamCommandId(commandIdPrefix);
    return this.#serialize(scope.runId, async () => {
      const events = await this.#ledger.list(scope.runId);
      assertScope(events, scope);
      const projected = projectTeam(events);
      if (projected === undefined) throw new TeamDomainError("team_not_found", "Run has no team");
      const commandDigest = sha256(stableStringify({
        domain: "tracegraph.team-sweep.v1",
        project_id: scope.projectId,
        run_id: scope.runId,
        session_id: scope.sessionId,
        actor: scope.actor,
        command_id: commandIdPrefix,
      }));
      const idempotencyKey = `team-command:${sha256(commandIdPrefix)}`;
      const duplicate = events.find((event) => event.idempotency_key === idempotencyKey);
      if (duplicate !== undefined) {
        if (
          duplicate.type !== "team.sweep_completed"
          || duplicate.data._internal_command_digest !== commandDigest
        ) {
          throw new TeamDomainError("idempotency_conflict", "Team sweep command id was reused");
        }
        return projected;
      }
      if (events.some((event) => isTerminalEventType(event.type))) {
        throw new TeamDomainError("run_terminal", "A terminal Run cannot mutate team state");
      }
      const priorLostEvents = teamSweepLostEvents(events, commandIdPrefix, projected.team_id);
      const sweptAt = priorLostEvents.length === 0
        ? this.#now().toISOString()
        : TeamMemberLostDataSchema.parse(priorLostEvents[0]!.data).lost_at;
      assertTimestampNotBefore(sweptAt, projected.created_at, "Team sweep clock precedes team creation");
      const sweptAtMs = Date.parse(sweptAt);
      const expired = projected.roster.members
        .filter((member) => (
          member.status === "active"
          && sweptAtMs - Date.parse(member.last_heartbeat_at) >= projected!.limits.heartbeat_timeout_ms
        ))
        .sort((left, right) => left.link.subagent_id.localeCompare(right.link.subagent_id));
      const proposals: SessionEventProposal[] = [];
      for (const member of expired) {
        const command: Extract<TeamCommand, { operation: "mark_member_lost" }> = {
          command_id: `team-expire:${sha256(`${commandIdPrefix}:${member.link.subagent_id}`)}`,
          operation: "mark_member_lost",
          subagent_id: member.link.subagent_id,
        };
        const derivedKey = teamCommandIdempotencyKey(command.command_id);
        // Preflight every predictable derived namespace before any append. A
        // legacy or malicious occupant must make the whole sweep a no-op.
        assertUnoccupiedInternalCommand(events, derivedKey, command.command_id);
        proposals.push(this.#mutationProposal(
          scope,
          command,
          derivedKey,
          teamCommandDigest(scope, command),
          sweptAt,
          projected,
          events,
        ));
      }
      const priorLostEventIds = priorLostEvents.map(({ event_id: eventId }) => eventId);
      await this.#ledger.appendAtomic(atomicScope(scope), proposals, (resolved) => this.#proposal(
        scope,
        { command_id: commandIdPrefix },
        idempotencyKey,
        "team.sweep_completed",
        "Team heartbeat sweep completed",
        {
          team_id: projected.team_id,
          swept_at: sweptAt,
          member_lost_event_ids: [
            ...priorLostEventIds,
            ...resolved.map(({ event_id: eventId }) => eventId),
          ],
          _internal_command_digest: commandDigest,
        },
      ));
      const replayed = projectTeam(await this.#ledger.list(scope.runId));
      if (replayed === undefined) throw new TeamDomainError("invalid_team_event", "Team sweep did not replay");
      return replayed;
    });
  }

  /**
   * Immediately retire a worker after G-07 has durably recorded its exact
   * terminal link. This avoids a ghost active member while preserving the
   * same atomic task-reopen transition used by heartbeat expiry.
   */
  retireTerminalMember(
    scopeValue: TeamCommandScope,
    subagentIdValue: string,
    commandIdValue: string,
  ): Promise<TeamProjection> {
    const subagentId = IdentifierSchema.parse(subagentIdValue);
    const commandId = IdentifierSchema.parse(commandIdValue);
    const scope = {
      projectId: IdentifierSchema.parse(scopeValue.projectId),
      runId: IdentifierSchema.parse(scopeValue.runId),
      ...(scopeValue.sessionId === undefined ? {} : { sessionId: IdentifierSchema.parse(scopeValue.sessionId) }),
      actor: TeamActorSchema.parse(scopeValue.actor),
    };
    assertCoordinator(scope.actor, "Only the coordinator may retire a terminal worker");
    return this.#serialize(scope.runId, async () => {
      const events = await this.#ledger.list(scope.runId);
      assertScope(events, scope);
      if (incompleteHeartbeatSweepLosses(events).length > 0) {
        throw new TeamDomainError(
          "idempotency_conflict",
          "An incomplete legacy heartbeat sweep must be repaired before terminal retirement",
        );
      }
      const command = TeamCommandSchema.parse({
        command_id: commandId,
        operation: "mark_member_lost",
        subagent_id: subagentId,
      });
      const commandDigest = sha256(stableStringify({
        domain: "tracegraph.team-command.v1",
        project_id: scope.projectId,
        run_id: scope.runId,
        session_id: scope.sessionId,
        actor: scope.actor,
        command,
        reason: "worker_terminal",
      }));
      const idempotencyKey = `team-command:${sha256(commandId)}`;
      const duplicate = events.find((event) => event.idempotency_key === idempotencyKey);
      const current = projectTeam(events);
      if (current === undefined) throw new TeamDomainError("team_not_found", "Run has no team");
      if (duplicate !== undefined) {
        if (duplicate.type !== "team.member_lost" || duplicate.data._internal_command_digest !== commandDigest) {
          throw new TeamDomainError("idempotency_conflict", "Terminal retirement command id was reused");
        }
        return current;
      }
      if (events.some((event) => isTerminalEventType(event.type))) {
        throw new TeamDomainError("run_terminal", "A terminal Run cannot mutate team state");
      }
      const member = requireActiveMember(current, subagentId);
      if (!hasPriorSubagentTerminalProof(events, Number.POSITIVE_INFINITY, member.link)) {
        throw new TeamDomainError(
          "member_join_proof_invalid",
          "Terminal worker retirement requires a prior exact G-07 terminal event",
        );
      }
      const timestamp = this.#now().toISOString();
      const reopenedTaskIds = current.task_board.items
        .filter((task) => task.state === "claimed" && task.owner === subagentId)
        .map(({ task_id: taskId }) => taskId)
        .sort();
      const appended = await this.#ledger.append(this.#proposal(
        scope,
        command,
        idempotencyKey,
        "team.member_lost",
        "Terminal team worker retired",
        {
          team_id: current.team_id,
          member: { ...member, status: "lost", lost_at: timestamp },
          previous_status: "active",
          reason: "worker_terminal",
          lost_at: timestamp,
          last_heartbeat_at: member.last_heartbeat_at,
          reopened_task_ids: reopenedTaskIds,
          _internal_command_digest: commandDigest,
        },
      ));
      return projectTeam([...events, appended])!;
    });
  }

  async #execute(scope: NormalizedTeamScope, command: TeamCommand): Promise<TeamProjection> {
    return this.#executeWithEvents(scope, command, await this.#ledger.list(scope.runId));
  }

  async #executeWithEvents(
    scope: NormalizedTeamScope,
    command: TeamCommand,
    events: readonly SessionEvent[],
  ): Promise<TeamProjection> {
    assertScope(events, scope);
    const commandDigest = sha256(stableStringify({
      domain: "tracegraph.team-command.v1",
      project_id: scope.projectId,
      run_id: scope.runId,
      session_id: scope.sessionId,
      actor: scope.actor,
      command,
    }));
    const idempotencyKey = `team-command:${sha256(command.command_id)}`;
    const duplicate = events.find((event) => event.idempotency_key === idempotencyKey);
    if (duplicate !== undefined) {
      if (!isTeamEventType(duplicate.type) || duplicate.data._internal_command_digest !== commandDigest) {
        throw new TeamDomainError("idempotency_conflict", "Team command id was reused with a different operation");
      }
      const replayed = projectTeam(events);
      if (replayed === undefined) throw new TeamDomainError("invalid_team_event", "Idempotent team event did not replay");
      return replayed;
    }
    if (events.some((event) => isTerminalEventType(event.type))) {
      throw new TeamDomainError("run_terminal", "A terminal Run cannot mutate team state");
    }

    const current = projectTeam(events);
    if (current !== undefined && incompleteHeartbeatSweepLosses(events).length > 0) {
      throw new TeamDomainError(
        "idempotency_conflict",
        "An incomplete legacy heartbeat sweep must be repaired before another Team mutation",
      );
    }
    const timestamp = this.#now().toISOString();
    let proposal: SessionEventProposal;

    if (command.operation === "create_team") {
      assertCoordinator(scope.actor, "Only the coordinator may create a team");
      if (current !== undefined) throw new TeamDomainError("team_already_exists", "Run already has a team");
      if (typeof events[0]?.data.parent_run_id === "string") {
        throw new TeamDomainError("team_required_root_run", "A child Run cannot become a team coordinator");
      }
      proposal = this.#proposal(scope, command, idempotencyKey, "team.created", "Agent team created", {
        team_id: this.#idFactory("team"),
        coordinator_run_id: scope.runId,
        limits: this.#defaultLimits,
        created_at: timestamp,
        _internal_command_digest: commandDigest,
      });
    } else {
      if (current === undefined) throw new TeamDomainError("team_not_found", "Run has no team");
      assertTimestampNotBefore(timestamp, current.created_at, "Team mutation clock precedes team creation");
      if (command.operation === "complete_task") {
        const member = requireActorMember(current, scope.actor);
        const verified = this.#evidenceResolver === undefined
          ? isTeamEvidenceEligible(events, command.evidence_event_ids)
          : await this.#evidenceResolver({
            projectId: scope.projectId,
            coordinatorRunId: scope.runId,
            member,
            evidenceEventIds: command.evidence_event_ids,
            ...(scope.evidenceBeforeActionId === undefined
              ? {}
              : { beforeActionId: scope.evidenceBeforeActionId }),
          });
        if (!verified) {
          throw new TeamDomainError(
            "task_evidence_invalid",
            "Team task evidence is absent, belongs to another worker, or is not independently eligible",
          );
        }
      }
      proposal = this.#mutationProposal(
        scope,
        command,
        idempotencyKey,
        commandDigest,
        timestamp,
        current,
        events,
      );
    }

    const appended = await this.#ledger.append(proposal);
    const replayedEvents = events.some(({ event_id: eventId }) => eventId === appended.event_id)
      ? events
      : [...events, appended];
    const replayed = projectTeam(replayedEvents);
    if (replayed === undefined) throw new TeamDomainError("invalid_team_event", "Appended team event did not replay");
    return replayed;
  }

  #mutationProposal(
    scope: NormalizedTeamScope,
    command: Exclude<TeamCommand, { operation: "create_team" }>,
    idempotencyKey: string,
    commandDigest: string,
    timestamp: string,
    current: TeamProjection,
    events: readonly SessionEvent[],
  ): SessionEventProposal {
    const actorAddress = requireParticipant(current, scope.actor);
    if (command.operation === "join_member") {
      assertCoordinator(scope.actor, "Only the coordinator may join a proven worker");
      if (current.roster.members.some(({ link }) => link.subagent_id === command.subagent_id)) {
        throw new TeamDomainError("member_already_joined", `Member ${command.subagent_id} already joined`);
      }
      if (
        current.roster.members.length >= current.limits.max_members
        || current.roster.members.filter(({ status }) => status === "active").length >= current.limits.max_parallel_workers
      ) {
        throw new TeamDomainError("team_capacity_exceeded", "Team worker limit is full");
      }
      const proof = findDirectSubagentProof(events, command.subagent_id);
      if (proof === undefined) {
        throw new TeamDomainError("member_join_proof_missing", "Member join requires a prior direct subagent.started fact");
      }
      if (proof.spec.name !== command.role) {
        throw new TeamDomainError("member_join_proof_invalid", "Member role must match its trusted subagent profile");
      }
      if (hasPriorSubagentTerminalProof(events, Number.POSITIVE_INFINITY, proof.link)) {
        throw new TeamDomainError("member_join_proof_invalid", "A terminal subagent cannot join as an active worker");
      }
      const member: TeamMember = {
        link: proof.link,
        role: redactSensitiveText(command.role),
        status: "active",
        joined_at: timestamp,
        last_heartbeat_at: timestamp,
      };
      return this.#proposal(scope, command, idempotencyKey, "team.member_joined", "Team worker joined", {
        team_id: current.team_id,
        member,
        _internal_command_digest: commandDigest,
      });
    }

    if (command.operation === "heartbeat") {
      const member = requireActorMember(current, scope.actor, command.subagent_id);
      if (Date.parse(timestamp) <= Date.parse(member.last_heartbeat_at)) {
        throw new TeamDomainError("heartbeat_not_advanced", "Heartbeat clock must advance monotonically");
      }
      return this.#proposal(scope, command, idempotencyKey, "team.heartbeat", "Team worker heartbeat recorded", {
        team_id: current.team_id,
        member: { ...member, last_heartbeat_at: timestamp },
        previous_heartbeat_at: member.last_heartbeat_at,
        _internal_command_digest: commandDigest,
      });
    }

    if (command.operation === "mark_member_lost") {
      assertCoordinator(scope.actor, "Only the coordinator may mark a team worker lost");
      const member = requireActiveMember(current, command.subagent_id);
      if (Date.parse(timestamp) - Date.parse(member.last_heartbeat_at) < current.limits.heartbeat_timeout_ms) {
        throw new TeamDomainError("heartbeat_not_expired", "Member heartbeat has not reached the frozen timeout");
      }
      const reopenedTaskIds = current.task_board.items
        .filter((task) => task.state === "claimed" && task.owner === command.subagent_id)
        .map(({ task_id: taskId }) => taskId)
        .sort();
      return this.#proposal(scope, command, idempotencyKey, "team.member_lost", "Team worker heartbeat expired", {
        team_id: current.team_id,
        member: { ...member, status: "lost", lost_at: timestamp },
        previous_status: "active",
        reason: "heartbeat_timeout",
        lost_at: timestamp,
        last_heartbeat_at: member.last_heartbeat_at,
        reopened_task_ids: reopenedTaskIds,
        _internal_command_digest: commandDigest,
      });
    }

    if (command.operation === "deliver_mailbox") {
      if (current.mailbox.messages.length >= current.limits.max_mailbox_messages) {
        throw new TeamDomainError("mailbox_capacity_exceeded", "Team mailbox limit is full");
      }
      if (current.mailbox.messages.some(({ message_id: messageId }) => messageId === command.message_id)) {
        throw new TeamDomainError("mailbox_message_already_exists", `Message ${command.message_id} already exists`);
      }
      assertProjectionAddress(current, command.to);
      const message: MailboxMessage = {
        message_id: command.message_id,
        from: actorAddress,
        to: command.to,
        kind: command.kind,
        payload: redactSensitiveText(command.payload),
        delivered_at: timestamp,
      };
      return this.#proposal(scope, command, idempotencyKey, "team.mailbox_delivered", "Team mailbox message delivered", {
        team_id: current.team_id,
        message,
        _internal_command_digest: commandDigest,
      });
    }

    if (command.operation === "claim_mailbox") {
      const message = current.mailbox.messages.find(({ message_id: messageId }) => messageId === command.message_id);
      if (message === undefined) {
        throw new TeamDomainError("mailbox_message_not_found", `Message ${command.message_id} does not exist`);
      }
      if (message.claimed_at !== undefined) {
        throw new TeamDomainError("mailbox_message_already_claimed", `Message ${command.message_id} is already claimed`);
      }
      if (message.to !== actorAddress) {
        throw new TeamDomainError("authority_denied", "Only the addressed recipient may claim a mailbox message");
      }
      const deliveredEvent = events.find((event) => (
        event.type === "team.mailbox_delivered"
        && (event.data.message as { message_id?: unknown } | undefined)?.message_id === command.message_id
      ));
      if (deliveredEvent === undefined) {
        throw new TeamDomainError("invalid_team_event", "Mailbox delivery event is unavailable");
      }
      return this.#proposal(scope, command, idempotencyKey, "team.mailbox_claimed", "Team mailbox message claimed", {
        team_id: current.team_id,
        message: { ...message, claimed_at: timestamp, claimed_by: actorAddress },
        delivered_event_id: deliveredEvent.event_id,
        _internal_command_digest: commandDigest,
      });
    }

    if (command.operation === "create_task") {
      if (current.task_board.items.length >= current.limits.max_tasks) {
        throw new TeamDomainError("task_capacity_exceeded", "Team task board limit is full");
      }
      if (current.task_board.items.some(({ task_id: taskId }) => taskId === command.task_id)) {
        throw new TeamDomainError("task_already_exists", `Task ${command.task_id} already exists`);
      }
      const task: TaskBoardItem = {
        task_id: command.task_id,
        title: redactSensitiveText(command.title),
        ...(command.detail === undefined ? {} : { detail: redactSensitiveText(command.detail) }),
        state: "open",
        acceptance: command.acceptance.map(redactSensitiveText),
        evidence_event_ids: [],
        version: 1,
        created_at: timestamp,
        updated_at: timestamp,
      };
      return this.#proposal(scope, command, idempotencyKey, "team.task_created", "Team task created", {
        team_id: current.team_id,
        task,
        _internal_command_digest: commandDigest,
      });
    }

    const task = current.task_board.items.find(({ task_id: taskId }) => taskId === command.task_id);
    if (task === undefined) throw new TeamDomainError("task_not_found", `Task ${command.task_id} does not exist`);
    if (task.version !== command.expected_version) {
      throw new TeamDomainError("task_version_conflict", `Task ${command.task_id} revision changed`);
    }
    assertTimestampNotBefore(timestamp, task.updated_at, `Task ${command.task_id} update clock moved backwards`);

    if (command.operation === "claim_task") {
      const member = requireActorMember(current, scope.actor);
      if (task.state !== "open") throw new TeamDomainError("task_state_conflict", "Only an open task may be claimed");
      return this.#proposal(scope, command, idempotencyKey, "team.task_claimed", "Team task claimed", {
        team_id: current.team_id,
        task: { ...task, state: "claimed", owner: member.link.subagent_id, version: task.version + 1, updated_at: timestamp },
        previous_state: "open",
        previous_version: task.version,
        _internal_command_digest: commandDigest,
      });
    }

    if (command.operation === "complete_task") {
      const member = requireActorMember(current, scope.actor);
      assertTaskOwnedBy(task, member.link.subagent_id);
      if (task.state !== "claimed" && task.state !== "blocked") {
        throw new TeamDomainError("task_state_conflict", "Only a claimed or blocked task may complete");
      }
      return this.#proposal(scope, command, idempotencyKey, "team.task_completed", "Team task completed", {
        team_id: current.team_id,
        task: {
          ...task,
          state: "done",
          evidence_event_ids: command.evidence_event_ids,
          version: task.version + 1,
          updated_at: timestamp,
        },
        previous_state: task.state,
        previous_owner: task.owner,
        previous_version: task.version,
        _internal_command_digest: commandDigest,
      });
    }

    if (command.operation === "block_task") {
      const member = requireActorMember(current, scope.actor);
      assertTaskOwnedBy(task, member.link.subagent_id);
      if (task.state !== "claimed") throw new TeamDomainError("task_state_conflict", "Only a claimed task may be blocked");
      return this.#proposal(scope, command, idempotencyKey, "team.task_blocked", "Team task blocked", {
        team_id: current.team_id,
        task: { ...task, state: "blocked", version: task.version + 1, updated_at: timestamp },
        previous_state: "claimed",
        previous_owner: task.owner,
        previous_version: task.version,
        reason: redactSensitiveText(command.reason),
        _internal_command_digest: commandDigest,
      });
    }

    assertCoordinator(scope.actor, `Only the coordinator may ${command.operation === "cancel_task" ? "cancel" : "reopen"} a task`);
    if (command.operation === "cancel_task") {
      if (task.state !== "open" && task.state !== "claimed" && task.state !== "blocked") {
        throw new TeamDomainError("task_state_conflict", "This task cannot be cancelled from its current state");
      }
      return this.#proposal(scope, command, idempotencyKey, "team.task_cancelled", "Team task cancelled", {
        team_id: current.team_id,
        task: { ...task, state: "cancelled", owner: undefined, version: task.version + 1, updated_at: timestamp },
        previous_state: task.state,
        ...(task.owner === undefined ? {} : { previous_owner: task.owner }),
        previous_version: task.version,
        reason: redactSensitiveText(command.reason),
        _internal_command_digest: commandDigest,
      });
    }
    if (task.state !== "blocked" && task.state !== "cancelled") {
      throw new TeamDomainError("task_state_conflict", "Only a blocked or cancelled task may be reopened");
    }
    return this.#proposal(scope, command, idempotencyKey, "team.task_reopened", "Team task reopened", {
      team_id: current.team_id,
      task: {
        ...task,
        state: "open",
        owner: undefined,
        evidence_event_ids: [],
        version: task.version + 1,
        updated_at: timestamp,
      },
      previous_state: task.state,
      ...(task.owner === undefined ? {} : { previous_owner: task.owner }),
      previous_version: task.version,
      reason: redactSensitiveText(command.reason),
      _internal_command_digest: commandDigest,
    });
  }

  #proposal(
    scope: NormalizedTeamScope,
    command: Pick<TeamCommand, "command_id">,
    idempotencyKey: string,
    type: SessionEvent["type"],
    summary: string,
    data: Record<string, unknown>,
  ): SessionEventProposal {
    const eventSchema = TEAM_EVENT_DATA_SCHEMAS[type as keyof typeof TEAM_EVENT_DATA_SCHEMAS];
    if (eventSchema === undefined) {
      throw new TeamDomainError("invalid_team_event", `${type} is not a registered team event`);
    }
    // JsonlEventLedger redacts every structured payload at the persistence
    // boundary. Validate that exact post-redaction shape before append so a
    // secret-shaped identifier, duplicate redacted acceptance item, or clock
    // rollback cannot commit an event that poisons subsequent replay.
    const redactedData = redactStructuredArtifactValue(data);
    const parsedData = eventSchema.safeParse(redactedData);
    if (!parsedData.success) {
      throw new TeamDomainError("invalid_team_event", `Invalid ${type} payload after persistence redaction`);
    }
    return {
      type,
      project_id: scope.projectId,
      run_id: scope.runId,
      ...(scope.sessionId === undefined ? {} : { session_id: scope.sessionId }),
      attempt: 0,
      summary,
      artifact_refs: [],
      idempotency_key: idempotencyKey,
      operation_id: command.command_id,
      data: parsedData.data,
    };
  }

  #serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#queues.set(runId, settled);
    void settled.finally(() => {
      if (this.#queues.get(runId) === settled) this.#queues.delete(runId);
    });
    return result;
  }
}

interface NormalizedTeamScope {
  readonly projectId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly actor: TeamActor;
  readonly evidenceBeforeActionId?: string;
}

function normalizeTeamScope(scopeValue: TeamCommandScope): NormalizedTeamScope {
  return {
    projectId: IdentifierSchema.parse(scopeValue.projectId),
    runId: IdentifierSchema.parse(scopeValue.runId),
    ...(scopeValue.sessionId === undefined ? {} : { sessionId: IdentifierSchema.parse(scopeValue.sessionId) }),
    actor: TeamActorSchema.parse(scopeValue.actor),
    ...(scopeValue.evidenceBeforeActionId === undefined
      ? {}
      : { evidenceBeforeActionId: IdentifierSchema.parse(scopeValue.evidenceBeforeActionId) }),
  };
}

function atomicScope(scope: NormalizedTeamScope): AtomicEventScope {
  return {
    project_id: scope.projectId,
    run_id: scope.runId,
    ...(scope.sessionId === undefined ? {} : { session_id: scope.sessionId }),
  };
}

function teamCommandIdempotencyKey(commandId: string): string {
  return `team-command:${sha256(commandId)}`;
}

function teamCommandDigest(scope: NormalizedTeamScope, command: TeamCommand): string {
  return sha256(stableStringify({
    domain: "tracegraph.team-command.v1",
    project_id: scope.projectId,
    run_id: scope.runId,
    session_id: scope.sessionId,
    actor: scope.actor,
    command,
  }));
}

function internalJoinCommandId(runId: string, subagentId: string): string {
  return `team-join:${sha256(`${runId}:${subagentId}`)}`;
}

function assertUnoccupiedInternalCommand(
  events: readonly SessionEvent[],
  idempotencyKey: string,
  commandId: string,
): void {
  if (events.some((event) => event.idempotency_key === idempotencyKey)) {
    throw new TeamDomainError(
      "idempotency_conflict",
      `Internal Team command namespace for ${commandId} is already occupied`,
    );
  }
}

function assertInternalCommandAuthority(actor: TeamActor, commandId: string): void {
  if (
    actor.kind !== "lead"
    && INTERNAL_TEAM_COMMAND_PREFIXES.slice(0, 3).some((prefix) => commandId.startsWith(prefix))
  ) {
    throw new TeamDomainError("command_id_reserved", "Team command id uses a reserved internal prefix");
  }
}

export function assertExternalTeamCommandId(commandIdValue: string): void {
  const commandId = IdentifierSchema.parse(commandIdValue);
  if (INTERNAL_TEAM_COMMAND_PREFIXES.some((prefix) => commandId.startsWith(prefix))) {
    throw new TeamDomainError("command_id_reserved", "Team command id uses a reserved internal prefix");
  }
}

function assertProposalScope(proposal: SessionEventProposal, scope: NormalizedTeamScope): void {
  if (
    proposal.project_id !== scope.projectId
    || proposal.run_id !== scope.runId
    || proposal.session_id !== scope.sessionId
  ) {
    throw new TeamDomainError("run_scope_mismatch", "Atomic subagent start does not match the Team Run scope");
  }
}

function assertDirectStartedData(started: SubagentStartedData, scope: NormalizedTeamScope): void {
  if (
    started.link.parent_run_id !== scope.runId
    || started.link.parent_session_id !== scope.sessionId
    || started.spec.parent_run_id !== scope.runId
    || started.spec.subagent_id !== started.link.subagent_id
  ) {
    throw new TeamDomainError("member_join_proof_invalid", "Worker start is not a direct child of the Team coordinator");
  }
}

function activeMemberFromProof(started: SubagentStartedData, timestamp: string): TeamMember {
  return {
    link: started.link,
    role: redactSensitiveText(started.spec.name),
    status: "active",
    joined_at: timestamp,
    last_heartbeat_at: timestamp,
  };
}

function uniqueRunningMemberProofs(
  events: readonly SessionEvent[],
  candidates: readonly SubagentStartedData[],
  scope: NormalizedTeamScope,
): SubagentStartedData[] {
  const seen = new Set<string>();
  const result: SubagentStartedData[] = [];
  for (const candidate of candidates) {
    assertDirectStartedData(candidate, scope);
    if (seen.has(candidate.link.subagent_id)) {
      throw new TeamDomainError("member_join_proof_invalid", "Running worker candidates must be unique");
    }
    seen.add(candidate.link.subagent_id);
    const proof = events.find((event) => {
      if (event.type !== "subagent.started") return false;
      const parsed = SubagentStartedDataSchema.safeParse(event.data);
      return parsed.success && stableStringify(parsed.data) === stableStringify(candidate);
    });
    if (proof === undefined) {
      throw new TeamDomainError("member_join_proof_missing", "Running Team member requires an exact subagent.started fact");
    }
    if (!hasPriorSubagentTerminalProof(events, Number.POSITIVE_INFINITY, candidate.link)) {
      result.push(candidate);
    }
  }
  return result;
}

type ParsedTaskTransition =
  | ReturnType<typeof TeamTaskClaimedDataSchema.parse>
  | ReturnType<typeof TeamTaskCompletedDataSchema.parse>
  | ReturnType<typeof TeamTaskBlockedDataSchema.parse>
  | ReturnType<typeof TeamTaskCancelledDataSchema.parse>
  | ReturnType<typeof TeamTaskReopenedDataSchema.parse>;

function isTeamEventType(type: SessionEvent["type"]): boolean {
  return TEAM_EVENT_TYPES.has(type);
}

function parseTeamEventData(event: SessionEvent): Record<string, unknown> & { team_id: string } {
  const schema = TEAM_EVENT_DATA_SCHEMAS[event.type as keyof typeof TEAM_EVENT_DATA_SCHEMAS];
  if (schema === undefined) throw new TeamDomainError("invalid_team_event", `${event.type} is not a team event`);
  const parsed = schema.safeParse(event.data);
  if (!parsed.success) {
    throw new TeamDomainError("invalid_team_event", `Invalid ${event.type} payload at sequence ${event.sequence}`);
  }
  return parsed.data as Record<string, unknown> & { team_id: string };
}

function parseTaskTransition(event: SessionEvent, data: Record<string, unknown>): ParsedTaskTransition {
  switch (event.type) {
    case "team.task_claimed": return TeamTaskClaimedDataSchema.parse(data);
    case "team.task_completed": return TeamTaskCompletedDataSchema.parse(data);
    case "team.task_blocked": return TeamTaskBlockedDataSchema.parse(data);
    case "team.task_cancelled": return TeamTaskCancelledDataSchema.parse(data);
    case "team.task_reopened": return TeamTaskReopenedDataSchema.parse(data);
    default: throw new TeamDomainError("invalid_team_event", `${event.type} is not a task transition`);
  }
}

function assertScope(events: readonly SessionEvent[], scope: NormalizedTeamScope): void {
  const first = events[0];
  if (first === undefined || first.type !== "run.created") {
    throw new TeamDomainError("run_not_found", `Run ${scope.runId} does not have a canonical ledger`);
  }
  if (
    first.project_id !== scope.projectId
    || first.run_id !== scope.runId
    || (scope.sessionId !== undefined && first.session_id !== scope.sessionId)
  ) {
    throw new TeamDomainError("run_scope_mismatch", "Team command does not match the root Run scope");
  }
}

function assertCoordinator(actor: TeamActor, message: string): void {
  if (actor.kind === "member") throw new TeamDomainError("authority_denied", message);
}

function requireParticipant(team: TeamProjection, actor: TeamActor): string {
  if (actor.kind !== "member") return TEAM_COORDINATOR_ADDRESS;
  requireActiveMember(team, actor.subagent_id);
  return actor.subagent_id;
}

function requireActorMember(
  team: TeamProjection,
  actor: TeamActor,
  expectedSubagentId?: string,
): TeamMember {
  if (actor.kind !== "member") {
    throw new TeamDomainError("authority_denied", "This operation requires a joined worker identity");
  }
  if (expectedSubagentId !== undefined && actor.subagent_id !== expectedSubagentId) {
    throw new TeamDomainError("authority_denied", "A worker cannot act as another team member");
  }
  return requireActiveMember(team, actor.subagent_id);
}

function requireMember(members: ReadonlyMap<string, TeamMember>, subagentId: string): TeamMember {
  const member = members.get(subagentId);
  if (member === undefined) throw new TeamDomainError("member_not_found", `Unknown team member ${subagentId}`);
  return member;
}

function requireActiveMember(team: TeamProjection, subagentId: string): TeamMember {
  const member = team.roster.members.find(({ link }) => link.subagent_id === subagentId);
  if (member === undefined) throw new TeamDomainError("member_not_found", `Unknown team member ${subagentId}`);
  if (member.status !== "active") throw new TeamDomainError("member_not_active", `Team member ${subagentId} is lost`);
  return member;
}

function assertProjectionAddress(team: TeamProjection, address: string): void {
  if (address === TEAM_COORDINATOR_ADDRESS) return;
  requireActiveMember(team, address);
}

function assertActiveAddress(members: ReadonlyMap<string, TeamMember>, address: string | undefined): void {
  if (address === TEAM_COORDINATOR_ADDRESS) return;
  if (address === undefined) throw new TeamDomainError("mailbox_recipient_invalid", "Mailbox address is missing");
  const member = requireMember(members, address);
  if (member.status !== "active") {
    throw new TeamDomainError("mailbox_recipient_invalid", `Mailbox member ${address} is not active`);
  }
}

function assertTaskOwnedBy(task: TaskBoardItem, subagentId: string): void {
  if (task.owner !== subagentId) {
    throw new TeamDomainError("task_owner_conflict", `Task ${task.task_id} is not owned by ${subagentId}`);
  }
}

function isTeamEvidenceEligible(
  events: readonly SessionEvent[],
  evidenceEventIds: readonly string[],
): boolean {
  for (const evidenceEventId of evidenceEventIds) {
    const evidence = events.find((event) => event.event_id === evidenceEventId);
    if (
      evidence === undefined
      || (!isEligibleTodoCompletionEvidence(evidence) && evidence.type !== "subagent.completed")
    ) {
      return false;
    }
  }
  return evidenceEventIds.length > 0;
}

function findDirectSubagentProof(
  events: readonly SessionEvent[],
  subagentId: string,
): ReturnType<typeof SubagentStartedDataSchema.parse> | undefined {
  for (const event of events) {
    if (event.type !== "subagent.started") continue;
    const parsed = SubagentStartedDataSchema.safeParse(event.data);
    if (parsed.success && parsed.data.link.subagent_id === subagentId) return parsed.data;
  }
  return undefined;
}

function assertDirectSubagentProof(
  events: readonly SessionEvent[],
  beforeSequence: number,
  link: SubagentRunLink,
  role: string,
): void {
  const proofEvent = events.find((event) => {
    if (event.sequence >= beforeSequence || event.type !== "subagent.started") return false;
    const parsed = SubagentStartedDataSchema.safeParse(event.data);
    return parsed.success
      && sameLink(parsed.data.link, link)
      && parsed.data.spec.name === role;
  });
  if (proofEvent === undefined) {
    throw new TeamDomainError("member_join_proof_missing", "Roster member has no prior direct subagent.started proof");
  }
}

function hasPriorSubagentTerminalProof(
  events: readonly SessionEvent[],
  beforeSequence: number,
  link: SubagentRunLink,
): boolean {
  return events.some((event) => {
    if (event.sequence >= beforeSequence) return false;
    const parsed = event.type === "subagent.completed"
      ? SubagentCompletedDataSchema.safeParse(event.data)
      : event.type === "subagent.failed"
        ? SubagentFailedDataSchema.safeParse(event.data)
        : event.type === "subagent.interrupted"
          ? SubagentInterruptedDataSchema.safeParse(event.data)
          : undefined;
    return parsed?.success === true && sameLink(parsed.data.link, link);
  });
}

function teamSweepLostEvents(
  events: readonly SessionEvent[],
  commandId: string,
  teamId: string,
): SessionEvent[] {
  return events.filter((event) => {
    if (event.type !== "team.member_lost") return false;
    const parsed = TeamMemberLostDataSchema.safeParse(event.data);
    return parsed.success
      && parsed.data.team_id === teamId
      && parsed.data.reason === "heartbeat_timeout"
      && event.operation_id === `team-expire:${sha256(`${commandId}:${parsed.data.member.link.subagent_id}`)}`;
  }).sort((left, right) => left.sequence - right.sequence);
}

function incompleteHeartbeatSweepLosses(events: readonly SessionEvent[]): SessionEvent[] {
  const referenced = new Set<string>();
  for (const event of events) {
    if (event.type !== "team.sweep_completed") continue;
    const parsed = TeamSweepCompletedDataSchema.safeParse(event.data);
    if (!parsed.success) continue;
    for (const eventId of parsed.data.member_lost_event_ids) referenced.add(eventId);
  }
  return events.filter((event) => {
    if (event.type !== "team.member_lost" || referenced.has(event.event_id)) return false;
    const parsed = TeamMemberLostDataSchema.safeParse(event.data);
    return parsed.success && parsed.data.reason === "heartbeat_timeout";
  });
}

function sameLink(left: SubagentRunLink, right: SubagentRunLink): boolean {
  return left.subagent_id === right.subagent_id
    && left.parent_run_id === right.parent_run_id
    && left.parent_session_id === right.parent_session_id
    && left.child_run_id === right.child_run_id
    && left.child_session_id === right.child_session_id;
}

function assertSameMemberIdentity(current: TeamMember, next: TeamMember): void {
  if (
    !sameLink(current.link, next.link)
    || current.role !== next.role
    || current.joined_at !== next.joined_at
  ) {
    throw new TeamDomainError("invalid_team_event", "Team event changes immutable member identity");
  }
}

function assertTaskIdentity(current: TaskBoardItem, next: TaskBoardItem): void {
  if (
    current.task_id !== next.task_id
    || current.title !== next.title
    || current.detail !== next.detail
    || stableStringify(current.acceptance) !== stableStringify(next.acceptance)
    || current.created_at !== next.created_at
  ) {
    throw new TeamDomainError("invalid_team_event", "Team task transition changes immutable task facts");
  }
}

function assertTimestampNotBefore(next: string, previous: string, message: string): void {
  if (Date.parse(next) < Date.parse(previous)) {
    throw new TeamDomainError("invalid_team_event", message);
  }
}

function assertStableCommandIdentifiers(command: TeamCommand): void {
  const identifiers = [command.command_id];
  switch (command.operation) {
    case "join_member":
    case "heartbeat":
    case "mark_member_lost":
      identifiers.push(command.subagent_id);
      break;
    case "deliver_mailbox":
      identifiers.push(command.message_id, command.to);
      break;
    case "claim_mailbox":
      identifiers.push(command.message_id);
      break;
    case "create_task":
    case "claim_task":
    case "block_task":
    case "cancel_task":
    case "reopen_task":
      identifiers.push(command.task_id);
      break;
    case "complete_task":
      identifiers.push(command.task_id, ...command.evidence_event_ids);
      break;
    case "create_team":
      break;
  }
  if (identifiers.some((identifier) => redactSensitiveText(identifier) !== identifier)) {
    throw new TeamDomainError(
      "invalid_team_event",
      "Team identity and reference fields cannot contain redaction-sensitive values",
    );
  }
}

function sameMessageDelivery(current: MailboxMessage, next: MailboxMessage): boolean {
  return current.message_id === next.message_id
    && current.from === next.from
    && current.to === next.to
    && current.kind === next.kind
    && current.payload === next.payload
    && current.delivered_at === next.delivered_at;
}

function publicMember(member: TeamMember): TeamMember {
  return { ...member, role: redactSensitiveText(member.role) };
}

function publicMessage(message: MailboxMessage): MailboxMessage {
  return { ...message, payload: redactSensitiveText(message.payload) };
}

function publicTask(task: TaskBoardItem): TaskBoardItem {
  return {
    ...task,
    title: redactSensitiveText(task.title),
    ...(task.detail === undefined ? {} : { detail: redactSensitiveText(task.detail) }),
    acceptance: task.acceptance.map(redactSensitiveText),
  };
}

function activeMemberCount(members: ReadonlyMap<string, TeamMember>): number {
  return [...members.values()].filter(({ status }) => status === "active").length;
}
