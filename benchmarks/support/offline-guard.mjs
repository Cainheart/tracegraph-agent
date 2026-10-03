import { createRequire } from "node:module";

const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|CLIENT_?SECRET|PRIVATE_?KEY|PASSWORD|CREDENTIAL|SECRET|TOKEN|COOKIE)(?:_|$)/iu;
const PROVIDER_ENV_NAME = /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE_OPENAI|AWS|DEEPSEEK|DASHSCOPE|QWEN|MINIMAX|GLM|ZHIPUAI|LANGFUSE|OTEL_EXPORTER_OTLP)_/iu;
const NETWORK_PROXY_ENV_NAME = /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

for (const name of Object.keys(process.env)) {
  if (SENSITIVE_ENV_NAME.test(name) || PROVIDER_ENV_NAME.test(name) || NETWORK_PROXY_ENV_NAME.test(name)) {
    delete process.env[name];
  }
}

const nativeFetch = globalThis.fetch.bind(globalThis);
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    assertLoopback(url.hostname, `fetch ${url.protocol}`);
    return nativeFetch(input, init);
  },
});

const require = createRequire(import.meta.url);
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const dgram = require("node:dgram");
for (const key of ["connect", "createConnection"]) wrapConnector(net, key);
wrapSocketPrototype(net.Socket?.prototype, "connect");
wrapConnector(tls, "connect");
wrapSocketPrototype(tls.TLSSocket?.prototype, "connect");
for (const key of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt"]) {
  wrapDns(dns, key);
}
for (const key of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt"]) {
  wrapDns(dns.promises, key);
}
wrapSocketPrototype(dgram.Socket?.prototype, "connect");
wrapUdpSend(dgram.Socket?.prototype);
require("node:module").syncBuiltinESMExports();

function wrapConnector(module, key) {
  const original = module[key];
  if (typeof original !== "function") throw new Error(`Cannot install offline guard for ${key}`);
  Object.defineProperty(module, key, {
    configurable: true,
    writable: true,
    value: (...args) => {
      const host = connectionHost(args);
      if (host !== undefined) assertLoopback(host, key);
      return Reflect.apply(original, module, args);
    },
  });
}

function wrapDns(module, key) {
  const original = module[key];
  if (typeof original !== "function") return;
  Object.defineProperty(module, key, {
    configurable: true,
    writable: true,
    value: (...args) => {
      const hostname = args[0];
      if (typeof hostname === "string") assertLoopback(hostname, `dns.${key}`);
      return Reflect.apply(original, module, args);
    },
  });
}

function wrapSocketPrototype(prototype, key) {
  const original = prototype?.[key];
  if (typeof original !== "function") return;
  Object.defineProperty(prototype, key, {
    configurable: true,
    writable: true,
    value: function (...args) {
      const host = connectionHost(args);
      if (host !== undefined) assertLoopback(host, key);
      return Reflect.apply(original, this, args);
    },
  });
}

function wrapUdpSend(prototype) {
  const original = prototype?.send;
  if (typeof original !== "function") return;
  Object.defineProperty(prototype, "send", {
    configurable: true,
    writable: true,
    value: function (...args) {
      const options = args[1];
      const hostname = typeof options === "object" && options !== null
        ? options.address
        : typeof args[2] === "string" ? args[2] : typeof args[4] === "string" ? args[4] : undefined;
      if (typeof hostname !== "string") {
        throw new Error("Offline benchmark blocked UDP send without an explicit loopback address");
      }
      assertLoopback(hostname, "dgram.send");
      return Reflect.apply(original, this, args);
    },
  });
}

function connectionHost(args) {
  const first = args[0];
  if (typeof first === "string" && typeof args[1] !== "number") return undefined;
  if (typeof first === "object" && first !== null) {
    const options = first;
    if (typeof options.path === "string" && options.host === undefined && options.hostname === undefined) {
      return undefined;
    }
    const candidate = options.hostname ?? options.host;
    return typeof candidate === "string" ? candidate : "localhost";
  }
  if (typeof args[1] === "string") return args[1];
  return "localhost";
}

function assertLoopback(hostname, operation) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (LOOPBACK_HOSTS.has(normalized)) return;
  const error = new Error(`Offline benchmark blocked non-loopback ${operation} connection`);
  error.code = "ERR_TRACEGRAPH_BENCHMARK_NETWORK_BLOCKED";
  throw error;
}
