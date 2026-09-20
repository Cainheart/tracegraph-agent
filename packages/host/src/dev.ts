import { resolve } from "node:path";
import { createAgentRuntime, createReadonlyWorkspaceHandle } from "@tracegraph/core";
import { createTraceGraphHost } from "./index.js";

const dataDir = resolve(process.cwd(), ".tracegraph");
const runtime = await createAgentRuntime({ dataDir });
const workspace = await createReadonlyWorkspaceHandle({
  projectId: "local-project",
  root: process.cwd(),
});
const host = await createTraceGraphHost({
  runtime,
  projects: [{ label: "Current directory (read-only)", workspace }],
  logger: true,
});
const address = await host.listen();

process.stdout.write(`TraceGraph Host listening at ${address}\n`);
process.stdout.write(`Capability token expires at ${host.expiresAt}\n`);

const shutdown = async (): Promise<void> => {
  await host.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
