import { TraceGraphClient } from "@tracegraph/sdk";
import type { MemoryCandidateCreateRequest, MemoryControlItem } from "@tracegraph/contracts";

interface MemoryCommandClient {
  bootstrap(): Promise<unknown>;
  listMemoryControl(): Promise<{ items: readonly MemoryControlItem[]; conflicts: readonly unknown[] }>;
  createMemoryCandidate(input: Omit<MemoryCandidateCreateRequest, "command_id"> & { command_id?: string }): Promise<MemoryControlItem>;
  reviewMemory(memoryId: string, input: { expected_sequence: number; action: "review_activate" | "review_reject"; command_id?: string }): Promise<MemoryControlItem>;
  correctMemory(memoryId: string, input: { expected_sequence: number; claim: string; normalized_key?: string; command_id?: string }): Promise<MemoryControlItem>;
  revokeMemory(memoryId: string, input: { expected_sequence: number; command_id?: string }): Promise<MemoryControlItem>;
  deleteMemory(memoryId: string, commandId?: string): Promise<{ deletedMemoryIds: readonly string[] }>;
}

export interface MemoryCommandDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly createClient?: (baseUrl: string) => MemoryCommandClient;
  readonly write?: (value: string) => void;
}

const USAGE = [
  "Usage:",
  "  tracegraph memory list [--host-url <url>]",
  "  tracegraph memory show <memory-id> [--host-url <url>]",
  "  tracegraph memory candidate add --kind <kind> --claim <text> [--project-id <id>] [--normalized-key <key>] [--sensitivity <level>] [--allow-model-use]",
  "  tracegraph memory review <memory-id> --sequence <n> --action <activate|reject>",
  "  tracegraph memory correct <memory-id> --sequence <n> --claim <text> [--normalized-key <key>]",
  "  tracegraph memory revoke <memory-id> --sequence <n>",
  "  tracegraph memory delete <memory-id>",
  "  Add --host-url <url> to target a non-default local Host.",
].join("\n");

export async function runMemoryCommand(
  args: readonly string[],
  dependencies: MemoryCommandDependencies = {},
): Promise<void> {
  const [operation, ...rest] = args;
  if (operation === undefined || operation === "--help" || operation === "-h") {
    throw new Error(USAGE);
  }
  const env = dependencies.environment ?? process.env;
  const { hostUrl, commandArgs } = extractHostUrl(rest, env);
  const client = (dependencies.createClient ?? ((baseUrl) => new TraceGraphClient({ baseUrl })))(hostUrl);
  await client.bootstrap();

  let output: unknown;
  if (operation === "list" || operation === "show") {
    const memoryId = operation === "show" ? commandArgs[0] : undefined;
    if ((operation === "show" && (memoryId === undefined || commandArgs.length !== 1))
      || (operation === "list" && commandArgs.length !== 0)) throw new Error(USAGE);
    const result = await client.listMemoryControl();
    output = operation === "show"
      ? result.items.find((item) => item.record.memoryId === memoryId) ?? null
      : result;
    if (operation === "show" && output === null) throw new Error(`Memory ${memoryId} was not found`);
  } else if (operation === "candidate") {
    const action = commandArgs[0];
    if (action !== "add") throw new Error(USAGE);
    const flags = parseFlags(commandArgs.slice(1), ["--kind", "--claim", "--project-id", "--normalized-key", "--sensitivity", "--source-description", "--retention-policy", "--valid-until"], ["--allow-model-use"]);
    output = await client.createMemoryCandidate({
      kind: required(flags, "--kind") as MemoryCandidateCreateRequest["kind"],
      claim: required(flags, "--claim"),
      ...(flags.get("--project-id") === undefined ? {} : { project_id: flags.get("--project-id")! }),
      ...(flags.get("--normalized-key") === undefined ? {} : { normalized_key: flags.get("--normalized-key")! }),
      ...(flags.get("--sensitivity") === undefined ? {} : { sensitivity: flags.get("--sensitivity")! as MemoryCandidateCreateRequest["sensitivity"] }),
      ...(flags.get("--source-description") === undefined ? {} : { source_description: flags.get("--source-description")! }),
      ...(flags.get("--retention-policy") === undefined ? {} : { retention_policy: flags.get("--retention-policy")! }),
      ...(flags.get("--valid-until") === undefined ? {} : { valid_until: flags.get("--valid-until")! }),
      allow_model_use: flags.has("--allow-model-use"),
    });
  } else if (operation === "review") {
    const memoryId = requiredPositional(commandArgs, 0);
    const flags = parseFlags(commandArgs.slice(1), ["--sequence", "--action"]);
    const action = required(flags, "--action");
    if (action !== "activate" && action !== "reject") throw new Error("--action must be activate or reject");
    output = await client.reviewMemory(memoryId, {
      expected_sequence: positiveOrZero(required(flags, "--sequence")),
      action: action === "activate" ? "review_activate" : "review_reject",
    });
  } else if (operation === "correct") {
    const memoryId = requiredPositional(commandArgs, 0);
    const flags = parseFlags(commandArgs.slice(1), ["--sequence", "--claim", "--normalized-key"]);
    output = await client.correctMemory(memoryId, {
      expected_sequence: positiveOrZero(required(flags, "--sequence")),
      claim: required(flags, "--claim"),
      ...(flags.get("--normalized-key") === undefined ? {} : { normalized_key: flags.get("--normalized-key")! }),
    });
  } else if (operation === "revoke") {
    const memoryId = requiredPositional(commandArgs, 0);
    const flags = parseFlags(commandArgs.slice(1), ["--sequence"]);
    output = await client.revokeMemory(memoryId, { expected_sequence: positiveOrZero(required(flags, "--sequence")) });
  } else if (operation === "delete") {
    const memoryId = requiredPositional(commandArgs, 0);
    if (commandArgs.length !== 1) throw new Error(USAGE);
    output = await client.deleteMemory(memoryId);
  } else {
    throw new Error(USAGE);
  }
  (dependencies.write ?? ((value) => process.stdout.write(value)))(`${JSON.stringify(output, null, 2)}\n`);
}

function parseFlags(
  args: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) throw new Error(`Unexpected argument: ${flag ?? ""}\n${USAGE}`);
    if (booleanFlags.includes(flag)) {
      if (values.has(flag)) throw new Error(`Duplicate flag ${flag}`);
      values.set(flag, "true");
      continue;
    }
    if (!valueFlags.includes(flag)) throw new Error(`Unknown flag ${flag}\n${USAGE}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`Duplicate flag ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  return values;
}

function extractHostUrl(args: readonly string[], environment: NodeJS.ProcessEnv): { hostUrl: string; commandArgs: string[] } {
  let hostUrl = environment.TRACEGRAPH_HOST_URL ?? "http://127.0.0.1:4311";
  let hostUrlSeen = false;
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value !== "--host-url") {
      commandArgs.push(value!);
      continue;
    }
    if (hostUrlSeen) throw new Error("Duplicate flag --host-url");
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error("--host-url requires a URL");
    hostUrlSeen = true;
    hostUrl = next;
    index += 1;
  }
  return { hostUrl, commandArgs };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim().length === 0) throw new Error(`${key} is required\n${USAGE}`);
  return value;
}

function requiredPositional(args: readonly string[], index: number): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing Memory id\n${USAGE}`);
  return value;
}

function positiveOrZero(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error("--sequence must be a non-negative integer");
  return Number(value);
}
