#!/usr/bin/env node
import { resolve } from "node:path";
import { createRetrievalService } from "./server.js";

const port = parsePort(process.env.TRACEGRAPH_RETRIEVAL_PORT ?? "4312");
const dataDir = resolve(
  process.env.TRACEGRAPH_RETRIEVAL_DATA_DIR
    ?? resolve(process.cwd(), ".tracegraph", "retrieval-index"),
);
const configuredToken = process.env.TRACEGRAPH_RETRIEVAL_TOKEN;
const token = configuredToken === undefined || configuredToken.length === 0
  ? undefined
  : configuredToken;
const service = await createRetrievalService({
  dataDir,
  ...(token === undefined ? {} : { authorizationToken: token }),
  logger: true,
});
const address = await service.listen({ port });

process.stdout.write(`TraceGraph retrieval-service listening at ${address}\n`);
process.stdout.write(`Index directory: ${dataDir}\n`);
if (token === undefined) {
  process.stdout.write("Bearer authentication is disabled; the listener remains loopback-only.\n");
}

const shutdown = async (): Promise<void> => {
  await service.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new TypeError("TRACEGRAPH_RETRIEVAL_PORT must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("TRACEGRAPH_RETRIEVAL_PORT must be between 1 and 65535");
  }
  return parsed;
}
