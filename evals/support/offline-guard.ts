import { createRequire } from "node:module";

const CREDENTIAL_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|CLIENT_?SECRET|PRIVATE_?KEY|PASSWORD)$/iu;
const PROVIDER_ENV_NAME = /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE_OPENAI|AWS|DEEPSEEK|DASHSCOPE|QWEN|MINIMAX|GLM|ZHIPUAI)_/iu;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

for (const name of Object.keys(process.env)) {
  if (CREDENTIAL_ENV_NAME.test(name) || PROVIDER_ENV_NAME.test(name)) delete process.env[name];
}

process.env.NO_PROXY = "127.0.0.1,localhost,::1";
process.env.no_proxy = process.env.NO_PROXY;

const nativeFetch = globalThis.fetch.bind(globalThis);
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    assertLoopback(url.hostname, `fetch ${url.protocol}`);
    return nativeFetch(input, init);
  },
});

// Defence in depth for libraries that bypass global fetch. Unix sockets remain
// local; TCP/TLS connections are permitted only to explicit loopback hosts.
const require = createRequire(import.meta.url);
const net = require("node:net") as Record<string, unknown>;
const tls = require("node:tls") as Record<string, unknown>;
wrapConnector(net, "connect");
wrapConnector(net, "createConnection");
wrapConnector(tls, "connect");

function wrapConnector(module: Record<string, unknown>, key: string): void {
  const original = module[key];
  if (typeof original !== "function") throw new Error(`Cannot install offline eval guard for ${key}`);
  Object.defineProperty(module, key, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      const host = connectionHost(args);
      if (host !== undefined) assertLoopback(host, key);
      return Reflect.apply(original, module, args);
    },
  });
}

function connectionHost(args: readonly unknown[]): string | undefined {
  const first = args[0];
  // A single string without a numeric port is a local Unix-domain socket.
  if (typeof first === "string" && typeof args[1] !== "number") return undefined;
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: unknown; hostname?: unknown; path?: unknown };
    if (typeof options.path === "string" && options.host === undefined && options.hostname === undefined) {
      return undefined;
    }
    const candidate = options.hostname ?? options.host;
    return typeof candidate === "string" ? candidate : "localhost";
  }
  if (typeof args[1] === "string") return args[1];
  return "localhost";
}

function assertLoopback(hostname: string, operation: string): void {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (LOOPBACK_HOSTS.has(normalized)) return;
  throw new Error(`Offline eval blocked non-loopback ${operation} connection`);
}
