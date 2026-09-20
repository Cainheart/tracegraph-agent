import { TraceGraphClient } from "@tracegraph/sdk";

interface McpCommandClient {
  bootstrap(): Promise<unknown>;
  getMcpStatus(): Promise<unknown>;
  restartMcpServer(name: string, input?: { command_id?: string }): Promise<unknown>;
}

export interface McpCommandDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly createClient?: (baseUrl: string) => McpCommandClient;
  readonly write?: (value: string) => void;
}

/** Authenticated status/restart projection for the Host-owned MCP manager. */
export async function runMcpCommand(
  args: readonly string[],
  dependencies: McpCommandDependencies = {},
): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "list" && subcommand !== "restart") {
    throw new Error("Usage: tracegraph mcp list|restart <server>");
  }
  const name = args[1];
  if (subcommand === "restart" && (name === undefined || name.startsWith("--"))) {
    throw new Error("Usage: tracegraph mcp restart <server>");
  }
  const environment = dependencies.environment ?? process.env;
  const baseUrl = readFlag(args, "--host-url")
    ?? environment.TRACEGRAPH_HOST_URL
    ?? "http://127.0.0.1:4311";
  const client = (dependencies.createClient ?? ((url) => new TraceGraphClient({ baseUrl: url })))(baseUrl);
  const write = dependencies.write ?? ((value: string) => process.stdout.write(value));
  await client.bootstrap();
  const result = subcommand === "list"
    ? await client.getMcpStatus()
    : await client.restartMcpServer(name!);
  write(`${JSON.stringify(result, null, 2)}\n`);
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
