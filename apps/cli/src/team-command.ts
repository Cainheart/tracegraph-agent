import {
  TraceGraphClient,
  type TeamMailboxClaimRequest,
  type TeamMailboxSendRequest,
  type TeamTaskWriteRequest,
} from "@tracegraph/sdk";

type TeamTaskInput = TeamTaskWriteRequest["input"];

interface TeamCommandClient {
  bootstrap(): Promise<unknown>;
  getTeam(coordinatorRunId: string): Promise<unknown>;
  createTeam(coordinatorRunId: string, request?: { readonly command_id?: string }): Promise<unknown>;
  sendTeamMailbox(
    actorRunId: string,
    request: { readonly command_id?: string; readonly input: TeamMailboxSendRequest["input"] },
  ): Promise<unknown>;
  claimTeamMailbox(
    actorRunId: string,
    request: { readonly command_id?: string; readonly input: TeamMailboxClaimRequest["input"] },
  ): Promise<unknown>;
  writeTeamTask(
    actorRunId: string,
    request: { readonly command_id?: string; readonly input: TeamTaskInput },
  ): Promise<unknown>;
  heartbeatTeam(memberRunId: string, request?: { readonly command_id?: string }): Promise<unknown>;
  sweepLostTeamMembers(
    coordinatorRunId: string,
    request?: { readonly command_id?: string },
  ): Promise<unknown>;
}

export interface TeamCommandDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly createClient?: (baseUrl: string) => TeamCommandClient;
  readonly write?: (value: string) => void;
}

type TeamInvocation =
  | { readonly operation: "show"; readonly runId: string }
  | {
      readonly operation: "create" | "heartbeat" | "sweep";
      readonly runId: string;
      readonly commandId?: string;
    }
  | {
      readonly operation: "mailbox_send";
      readonly runId: string;
      readonly input: TeamMailboxSendRequest["input"];
      readonly commandId?: string;
    }
  | {
      readonly operation: "mailbox_claim";
      readonly runId: string;
      readonly input: TeamMailboxClaimRequest["input"];
      readonly commandId?: string;
    }
  | {
      readonly operation: "task_write";
      readonly runId: string;
      readonly input: TeamTaskInput;
      readonly commandId?: string;
    };

const MAILBOX_KINDS = new Set(["steer", "handoff", "question", "answer"] as const);
const TASK_OPERATIONS = new Set(["create", "claim", "complete", "block", "cancel", "reopen"] as const);

const USAGE = [
  "Usage:",
  "  tracegraph team show <coordinator-run-id> [--host-url <url>]",
  "  tracegraph team create <coordinator-run-id> [--command-id <id>] [--host-url <url>]",
  "  tracegraph team mailbox send <actor-run-id> --to <address> --kind <steer|handoff|question|answer> --payload <text> [--command-id <id>] [--host-url <url>]",
  "  tracegraph team mailbox claim <actor-run-id> --message-id <id> [--command-id <id>] [--host-url <url>]",
  "  tracegraph team task create <actor-run-id> --task-id <id> --title <text> --acceptance <text> [--acceptance <text> ...] [--detail <text>] [--command-id <id>] [--host-url <url>]",
  "  tracegraph team task claim <actor-run-id> --task-id <id> --expected-version <n> [--command-id <id>] [--host-url <url>]",
  "  tracegraph team task complete <actor-run-id> --task-id <id> --expected-version <n> --evidence-event-id <id> [--evidence-event-id <id> ...] [--command-id <id>] [--host-url <url>]",
  "  tracegraph team task block|cancel|reopen <actor-run-id> --task-id <id> --expected-version <n> --reason <text> [--command-id <id>] [--host-url <url>]",
  "  tracegraph team heartbeat <member-run-id> [--command-id <id>] [--host-url <url>]",
  "  tracegraph team sweep <coordinator-run-id> [--command-id <id>] [--host-url <url>]",
].join("\n");

/**
 * Thin authenticated Team CLI over the typed SDK. Authority comes only from
 * the Run id in the path; actor, sender, owner, project, clock, and timeout
 * fields are deliberately not part of this command grammar.
 */
export async function runTeamCommand(
  args: readonly string[],
  dependencies: TeamCommandDependencies = {},
): Promise<void> {
  const { invocation, hostUrl } = parseInvocation(args, dependencies.environment ?? process.env);
  const client = (dependencies.createClient ?? ((baseUrl) => new TraceGraphClient({ baseUrl })))(hostUrl);
  const write = dependencies.write ?? ((value: string) => process.stdout.write(value));

  await client.bootstrap();
  let output: unknown;
  switch (invocation.operation) {
    case "show":
      output = await client.getTeam(invocation.runId);
      break;
    case "create":
      output = invocation.commandId === undefined
        ? await client.createTeam(invocation.runId)
        : await client.createTeam(invocation.runId, commandRequest(invocation.commandId));
      break;
    case "mailbox_send":
      output = await client.sendTeamMailbox(invocation.runId, {
        input: invocation.input,
        ...commandField(invocation.commandId),
      });
      break;
    case "mailbox_claim":
      output = await client.claimTeamMailbox(invocation.runId, {
        input: invocation.input,
        ...commandField(invocation.commandId),
      });
      break;
    case "task_write":
      output = await client.writeTeamTask(invocation.runId, {
        input: invocation.input,
        ...commandField(invocation.commandId),
      });
      break;
    case "heartbeat":
      output = invocation.commandId === undefined
        ? await client.heartbeatTeam(invocation.runId)
        : await client.heartbeatTeam(invocation.runId, commandRequest(invocation.commandId));
      break;
    case "sweep":
      output = invocation.commandId === undefined
        ? await client.sweepLostTeamMembers(invocation.runId)
        : await client.sweepLostTeamMembers(invocation.runId, commandRequest(invocation.commandId));
      break;
  }
  write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): { invocation: TeamInvocation; hostUrl: string } {
  const family = args[0];
  if (family === "show") {
    const runId = requiredRunId(args[1]);
    const flags = parseFlags(args.slice(2), ["--host-url"]);
    return {
      invocation: { operation: "show", runId },
      hostUrl: resolveHostUrl(flags, environment),
    };
  }
  if (family === "create" || family === "heartbeat" || family === "sweep") {
    const runId = requiredRunId(args[1]);
    const flags = parseFlags(args.slice(2), ["--host-url", "--command-id"]);
    return {
      invocation: { operation: family, runId, ...parsedCommandField(flags) },
      hostUrl: resolveHostUrl(flags, environment),
    };
  }

  if (family === "mailbox") {
    const subcommand = args[1];
    const runId = requiredRunId(args[2]);
    if (subcommand === "send") {
      const flags = parseFlags(
        args.slice(3),
        ["--to", "--kind", "--payload", "--host-url", "--command-id"],
      );
      const kind = requiredFlag(flags, "--kind");
      if (!MAILBOX_KINDS.has(kind as never)) {
        throw usageError(`Invalid --kind: ${kind}`);
      }
      return {
        invocation: {
          operation: "mailbox_send",
          runId,
          input: {
            to: requiredFlag(flags, "--to"),
            kind: kind as TeamMailboxSendRequest["input"]["kind"],
            payload: requiredFlag(flags, "--payload"),
          },
          ...parsedCommandField(flags),
        },
        hostUrl: resolveHostUrl(flags, environment),
      };
    }
    if (subcommand === "claim") {
      const flags = parseFlags(args.slice(3), ["--message-id", "--host-url", "--command-id"]);
      return {
        invocation: {
          operation: "mailbox_claim",
          runId,
          input: { message_id: requiredFlag(flags, "--message-id") },
          ...parsedCommandField(flags),
        },
        hostUrl: resolveHostUrl(flags, environment),
      };
    }
    throw usageError("Unknown mailbox command");
  }

  if (family === "task") {
    const subcommand = args[1];
    if (!TASK_OPERATIONS.has(subcommand as never)) throw usageError("Unknown task command");
    const operation = subcommand as TeamTaskInput["operation"];
    const runId = requiredRunId(args[2]);
    const common = ["--task-id", "--host-url", "--command-id"];
    if (operation === "create") {
      const flags = parseFlags(
        args.slice(3),
        [...common, "--title", "--detail", "--acceptance"],
        ["--acceptance"],
      );
      return {
        invocation: {
          operation: "task_write",
          runId,
          input: {
            operation,
            task_id: requiredFlag(flags, "--task-id"),
            title: requiredFlag(flags, "--title"),
            ...(optionalFlag(flags, "--detail") === undefined
              ? {}
              : { detail: optionalFlag(flags, "--detail") }),
            acceptance: requiredFlags(flags, "--acceptance"),
          },
          ...parsedCommandField(flags),
        },
        hostUrl: resolveHostUrl(flags, environment),
      };
    }
    if (operation === "complete") {
      const flags = parseFlags(
        args.slice(3),
        [...common, "--expected-version", "--evidence-event-id"],
        ["--evidence-event-id"],
      );
      return {
        invocation: {
          operation: "task_write",
          runId,
          input: {
            operation,
            task_id: requiredFlag(flags, "--task-id"),
            expected_version: positiveIntegerFlag(flags, "--expected-version"),
            evidence_event_ids: requiredFlags(flags, "--evidence-event-id"),
          },
          ...parsedCommandField(flags),
        },
        hostUrl: resolveHostUrl(flags, environment),
      };
    }
    if (operation === "claim") {
      const flags = parseFlags(args.slice(3), [...common, "--expected-version"]);
      return {
        invocation: {
          operation: "task_write",
          runId,
          input: {
            operation,
            task_id: requiredFlag(flags, "--task-id"),
            expected_version: positiveIntegerFlag(flags, "--expected-version"),
          },
          ...parsedCommandField(flags),
        },
        hostUrl: resolveHostUrl(flags, environment),
      };
    }
    const flags = parseFlags(args.slice(3), [...common, "--expected-version", "--reason"]);
    return {
      invocation: {
        operation: "task_write",
        runId,
        input: {
          operation,
          task_id: requiredFlag(flags, "--task-id"),
          expected_version: positiveIntegerFlag(flags, "--expected-version"),
          reason: requiredFlag(flags, "--reason"),
        },
        ...parsedCommandField(flags),
      },
      hostUrl: resolveHostUrl(flags, environment),
    };
  }

  throw usageError("Unknown team command");
}

function requiredRunId(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw usageError("A Run id is required");
  }
  return value;
}

function parseFlags(
  args: readonly string[],
  allowed: readonly string[],
  repeatable: readonly string[] = [],
): ReadonlyMap<string, readonly string[]> {
  const allowedSet = new Set(allowed);
  const repeatableSet = new Set(repeatable);
  const parsed = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || !name.startsWith("--") || !allowedSet.has(name)) {
      throw usageError(`Unknown option: ${name ?? "<missing>"}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Missing value for ${name}`);
    }
    const values = parsed.get(name) ?? [];
    if (values.length > 0 && !repeatableSet.has(name)) {
      throw usageError(`Option may only be specified once: ${name}`);
    }
    values.push(value);
    parsed.set(name, values);
  }
  return parsed;
}

function requiredFlag(flags: ReadonlyMap<string, readonly string[]>, name: string): string {
  const value = flags.get(name)?.[0];
  if (value === undefined) throw usageError(`Missing required option: ${name}`);
  return value;
}

function requiredFlags(flags: ReadonlyMap<string, readonly string[]>, name: string): string[] {
  const values = flags.get(name);
  if (values === undefined || values.length === 0) {
    throw usageError(`Missing required option: ${name}`);
  }
  return [...values];
}

function optionalFlag(flags: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

function parsedCommandField(
  flags: ReadonlyMap<string, readonly string[]>,
): { readonly commandId?: string } {
  const commandId = optionalFlag(flags, "--command-id");
  return commandId === undefined ? {} : { commandId };
}

function commandField(commandId: string | undefined): { readonly command_id?: string } {
  return commandId === undefined ? {} : { command_id: commandId };
}

function commandRequest(commandId: string | undefined): { readonly command_id?: string } {
  return commandField(commandId);
}

function positiveIntegerFlag(flags: ReadonlyMap<string, readonly string[]>, name: string): number {
  const value = requiredFlag(flags, name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw usageError(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw usageError(`${name} must be a positive integer`);
  return parsed;
}

function resolveHostUrl(
  flags: ReadonlyMap<string, readonly string[]>,
  environment: NodeJS.ProcessEnv,
): string {
  return optionalFlag(flags, "--host-url")
    ?? environment.TRACEGRAPH_HOST_URL
    ?? "http://127.0.0.1:4311";
}

function usageError(message: string): Error {
  return new Error(`${message}\n${USAGE}`);
}
