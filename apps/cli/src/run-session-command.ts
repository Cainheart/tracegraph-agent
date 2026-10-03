import { randomUUID } from "node:crypto";
import { TraceGraphClient, type StreamOptions } from "@tracegraph/sdk";
import {
  ClientEventMessageSchema,
  ClientCommandMessageSchema,
  ClientQueryMessageSchema,
  ClientReplyMessageSchema,
  CLIENT_PROTOCOL_VERSION,
} from "@tracegraph/sdk/protocol";
import type {
  RunProjection,
  SessionListQuery,
  SessionListResponse,
  SessionReadResult,
  StartRunRequest,
  WireSessionEvent,
} from "@tracegraph/contracts";

export interface RunSessionCommandClient {
  bootstrap(): Promise<unknown>;
  startRun(input: StartRunRequest): Promise<RunProjection>;
  getRun(runId: string): Promise<RunProjection>;
  listSessions(input?: Partial<SessionListQuery>): Promise<SessionListResponse>;
  getSession(sessionId: string): Promise<SessionReadResult>;
  streamEvents(runId: string, options?: StreamOptions): AsyncGenerator<WireSessionEvent, void, void>;
}

export interface RunSessionCommandDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly createClient?: (baseUrl: string) => RunSessionCommandClient;
  readonly write?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export class RunSessionCommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "RunSessionCommandError";
    this.exitCode = exitCode;
  }
}

const RUN_USAGE = [
  "Usage:",
  "  outlive run start --project-id <id> --task <text> [--mode plan|execute] [--session-id <id>] [--command-id <id>] [--host-url <url>]",
  "  outlive run get <run-id> [--host-url <url>]",
  "  outlive run events <run-id> [--after-sequence <n>] [--follow] [--host-url <url>]",
].join("\n");

const SESSIONS_USAGE = [
  "Usage:",
  "  outlive sessions list [--project-id <id>] [--view roots|all] [--limit <n>] [--q <text>] [--cursor <cursor>] [--host-url <url>]",
  "  outlive sessions get <session-id> [--host-url <url>]",
].join("\n");

type ValueFlag =
  | "--host-url"
  | "--project-id"
  | "--task"
  | "--mode"
  | "--session-id"
  | "--command-id"
  | "--after-sequence"
  | "--view"
  | "--limit"
  | "--q"
  | "--cursor";
type BooleanFlag = "--follow";

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<ValueFlag, string>;
  readonly booleans: ReadonlySet<BooleanFlag>;
}

/** Run the CLI Run/Session slice through shared protocol envelopes and Host SDK routes. */
export async function runRunSessionCommand(
  command: "run" | "sessions",
  args: readonly string[],
  dependencies: RunSessionCommandDependencies = {},
): Promise<void> {
  const subcommand = args[0];
  if (command === "run" && subcommand !== "start" && subcommand !== "get" && subcommand !== "events") {
    throw new RunSessionCommandError(RUN_USAGE);
  }
  if (command === "sessions" && subcommand !== "list" && subcommand !== "get") {
    throw new RunSessionCommandError(SESSIONS_USAGE);
  }

  const valueFlags: readonly ValueFlag[] = command === "run"
    ? ["--host-url", ...(subcommand === "start"
      ? ["--project-id", "--task", "--mode", "--session-id", "--command-id"] as const
      : subcommand === "events" ? ["--after-sequence"] as const : [])]
    : ["--host-url", ...(subcommand === "list"
      ? ["--project-id", "--view", "--limit", "--q", "--cursor"] as const
      : [])];
  const booleanFlags: readonly BooleanFlag[] = command === "run" && subcommand === "events" ? ["--follow"] : [];
  const parsed = parseArguments(args.slice(1), valueFlags, booleanFlags);
  const env = dependencies.environment ?? process.env;
  const hostUrl = parsed.values.get("--host-url")
    ?? env.TRACEGRAPH_HOST_URL
    ?? "http://127.0.0.1:4311";
  const client = (dependencies.createClient ?? ((baseUrl) => new TraceGraphClient({ baseUrl })))(hostUrl);
  const write = dependencies.write ?? ((line: string) => process.stdout.write(line));

  if (command === "run" && subcommand === "start") {
    assertNoPositionals(parsed, RUN_USAGE);
    const commandId = parsed.values.get("--command-id") ?? randomUUID();
    const request = ClientCommandMessageSchema.parse({
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "command",
      request_id: randomUUID(),
      command: {
        type: "start_run",
        command_id: commandId,
        input: {
          command_id: commandId,
          project_id: required(parsed.values, "--project-id", RUN_USAGE),
          task: required(parsed.values, "--task", RUN_USAGE),
          mode: parsed.values.get("--mode") ?? "plan",
          ...(parsed.values.get("--session-id") === undefined
            ? {}
            : { session_id: parsed.values.get("--session-id")! }),
        },
      },
    });
    if (request.command.type !== "start_run") throw new RunSessionCommandError(RUN_USAGE);
    await client.bootstrap();
    const projection = await client.startRun(request.command.input);
    writeReply(request.request_id, { resource: "run", value: projection }, write);
    return;
  }

  if (command === "run" && subcommand === "get") {
    const runId = onlyPositional(parsed, RUN_USAGE);
    const query = ClientQueryMessageSchema.parse({
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "query",
      request_id: randomUUID(),
      query: { operation: "run.get", run_id: runId },
    });
    if (query.query.operation !== "run.get") throw new RunSessionCommandError(RUN_USAGE);
    await client.bootstrap();
    const projection = await client.getRun(query.query.run_id);
    writeReply(query.request_id, { resource: "run", value: projection }, write);
    return;
  }

  if (command === "run" && subcommand === "events") {
    const runId = onlyPositional(parsed, RUN_USAGE);
    const query = ClientQueryMessageSchema.parse({
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "query",
      request_id: randomUUID(),
      query: { operation: "run.get", run_id: runId },
    });
    if (query.query.operation !== "run.get") throw new RunSessionCommandError(RUN_USAGE);
    const afterSequence = nonNegativeInteger(parsed.values.get("--after-sequence") ?? "0", RUN_USAGE);
    await client.bootstrap();
    const projection = await client.getRun(query.query.run_id);
    let cursor = afterSequence;
    for (const event of projection.timeline) {
      if (event.sequence <= cursor) continue;
      writeEvent(event, write);
      cursor = event.sequence;
    }
    if (!parsed.booleans.has("--follow")) return;

    await followEvents(client, runId, cursor, dependencies.signal, write);
    return;
  }

  if (command === "sessions" && subcommand === "list") {
    assertNoPositionals(parsed, SESSIONS_USAGE);
    const query = ClientQueryMessageSchema.parse({
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "query",
      request_id: randomUUID(),
      query: {
        operation: "session.list",
        input: {
          ...(parsed.values.get("--project-id") === undefined
            ? {}
            : { project_id: parsed.values.get("--project-id")! }),
          ...(parsed.values.get("--q") === undefined ? {} : { q: parsed.values.get("--q")! }),
          view: parsed.values.get("--view") ?? "roots",
          limit: parsed.values.get("--limit") ?? "50",
          ...(parsed.values.get("--cursor") === undefined
            ? {}
            : { cursor: parsed.values.get("--cursor")! }),
        },
      },
    });
    if (query.query.operation !== "session.list") throw new RunSessionCommandError(SESSIONS_USAGE);
    await client.bootstrap();
    const result = await client.listSessions(query.query.input);
    writeReply(query.request_id, { resource: "sessions", value: result }, write);
    return;
  }

  const sessionId = onlyPositional(parsed, SESSIONS_USAGE);
  const query = ClientQueryMessageSchema.parse({
    protocol_version: CLIENT_PROTOCOL_VERSION,
    kind: "query",
    request_id: randomUUID(),
    query: { operation: "session.get", session_id: sessionId },
  });
  if (query.query.operation !== "session.get") throw new RunSessionCommandError(SESSIONS_USAGE);
  await client.bootstrap();
  const result = await client.getSession(query.query.session_id);
  writeReply(query.request_id, { resource: "session", value: result }, write);
}

function writeReply(
  requestId: string,
  result: { resource: "run"; value: RunProjection }
    | { resource: "sessions"; value: SessionListResponse }
    | { resource: "session"; value: SessionReadResult },
  write: (line: string) => void,
): void {
  const message = ClientReplyMessageSchema.parse({
    protocol_version: CLIENT_PROTOCOL_VERSION,
    kind: "reply",
    request_id: requestId,
    result,
  });
  write(`${JSON.stringify(message)}\n`);
}

function writeEvent(event: WireSessionEvent, write: (line: string) => void): void {
  const message = ClientEventMessageSchema.parse({
    protocol_version: CLIENT_PROTOCOL_VERSION,
    kind: "event",
    event: { stream: "ledger", event },
  });
  write(`${JSON.stringify(message)}\n`);
}

async function followEvents(
  client: RunSessionCommandClient,
  runId: string,
  afterSequence: number,
  providedSignal: AbortSignal | undefined,
  write: (line: string) => void,
): Promise<void> {
  const controller = providedSignal === undefined ? new AbortController() : undefined;
  const signal = providedSignal ?? controller!.signal;
  const onInterrupt = (): void => {
    process.exitCode = 130;
    controller!.abort();
  };
  if (controller !== undefined) process.once("SIGINT", onInterrupt);
  try {
    for await (const event of client.streamEvents(runId, { afterSequence, signal, reconnect: true })) {
      writeEvent(event, write);
      afterSequence = Math.max(afterSequence, event.sequence);
    }
  } finally {
    if (controller !== undefined) process.removeListener("SIGINT", onInterrupt);
  }
}

function parseArguments(
  args: readonly string[],
  valueFlags: readonly ValueFlag[],
  booleanFlags: readonly BooleanFlag[],
): ParsedArguments {
  const values = new Map<ValueFlag, string>();
  const booleans = new Set<BooleanFlag>();
  const positionals: string[] = [];
  const valueFlagSet = new Set<string>(valueFlags);
  const booleanFlagSet = new Set<string>(booleanFlags);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (booleanFlagSet.has(argument)) {
      if (booleans.has(argument as BooleanFlag)) throw new RunSessionCommandError(`Repeated flag ${argument}`);
      booleans.add(argument as BooleanFlag);
      continue;
    }
    if (!valueFlagSet.has(argument)) throw new RunSessionCommandError(`Unknown flag ${argument}`);
    const name = argument as ValueFlag;
    if (values.has(name)) throw new RunSessionCommandError(`Repeated flag ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new RunSessionCommandError(`Missing value for ${argument}`);
    values.set(name, value);
    index += 1;
  }
  return { positionals, values, booleans };
}

function required(values: ReadonlyMap<ValueFlag, string>, flag: ValueFlag, usage: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim().length === 0) throw new RunSessionCommandError(usage);
  return value;
}

function assertNoPositionals(parsed: ParsedArguments, usage: string): void {
  if (parsed.positionals.length !== 0) throw new RunSessionCommandError(usage);
}

function onlyPositional(parsed: ParsedArguments, usage: string): string {
  if (parsed.positionals.length !== 1 || parsed.positionals[0]!.length === 0) {
    throw new RunSessionCommandError(usage);
  }
  return parsed.positionals[0]!;
}

function nonNegativeInteger(value: string, usage: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RunSessionCommandError(usage);
  return parsed;
}
