import { TraceGraphClient } from "@tracegraph/sdk";

interface ExtensionCommandClient {
  bootstrap(): Promise<unknown>;
  listExtensions(): Promise<unknown>;
  reloadExtension(name: string): Promise<unknown>;
  runExtensionCommand(name: string, input: { args: readonly string[] }): Promise<unknown>;
}

export interface ExtensionCommandDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly createClient?: (baseUrl: string) => ExtensionCommandClient;
  readonly write?: (value: string) => void;
}

/**
 * Thin authenticated CLI projection over the typed SDK. It never reads an
 * extension module path or loads code from the current repository.
 */
export async function runExtensionsCommand(
  args: readonly string[],
  dependencies: ExtensionCommandDependencies = {},
): Promise<void> {
  const subcommand = args[0];
  const positional = args.slice(1).filter((value, index, values) => (
    value !== "--host-url" && values[index - 1] !== "--host-url"
  ));
  const name = positional[0];
  if (subcommand !== "list" && subcommand !== "reload" && subcommand !== "run") {
    throw new Error("Usage: tracegraph extensions list|reload <name>|run <command> [args...]");
  }
  if (subcommand === "reload" && !name) {
    throw new Error("Usage: tracegraph extensions reload <trusted-extension-name>");
  }
  if (subcommand === "run" && !name) {
    throw new Error("Usage: tracegraph extensions run <command> [args...]");
  }

  const environment = dependencies.environment ?? process.env;
  const baseUrl = readFlag(args, "--host-url")
    ?? environment.TRACEGRAPH_HOST_URL
    ?? "http://127.0.0.1:4311";
  const client = (dependencies.createClient ?? ((url) => new TraceGraphClient({ baseUrl: url })))(baseUrl);
  const write = dependencies.write ?? ((value: string) => process.stdout.write(value));

  // Every authenticated SDK method requires the loopback capability returned
  // by bootstrap. Do this once before dispatch so CLI calls reach the Host.
  await client.bootstrap();
  if (subcommand === "list") {
    write(`${JSON.stringify(await client.listExtensions(), null, 2)}\n`);
    return;
  }
  if (subcommand === "reload") {
    write(`${JSON.stringify(await client.reloadExtension(name!), null, 2)}\n`);
    return;
  }
  write(`${JSON.stringify(await client.runExtensionCommand(name!, { args: positional.slice(1) }), null, 2)}\n`);
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
