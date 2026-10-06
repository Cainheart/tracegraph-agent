import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { startLocalHost, connectLocalHost } from "@tracegraph/host";
import { maybeRunWorkbenchCommand } from "./workbench-command.js";

describe("real CLI/provider capability receipts", () => {
  it("executes selected native tests once, reconciles read-only, and distinguishes failures/unknown without paid keys", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "outlive-capability-cli-"))); let phase: "pass" | "auth" | "drop" = "pass", requests = 0;
    const server = createServer(async (req, res) => { let raw = ""; for await (const bytes of req) raw += bytes; const body = JSON.parse(raw); requests++; if (phase === "drop") { req.socket.destroy(); return; } if (phase === "auth") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "PRIVATE_PROVIDER_DIAGNOSTIC" })); return; } const challenge = /[a-f\d]{8}-[a-f\d-]{27}/u.exec(body.messages[0].content)?.[0]; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: body.tools ? "tool_calls" : "stop", message: body.tools ? { tool_calls: [{ id: "fixture-tool", type: "function", function: { name: "outlive_probe", arguments: JSON.stringify({ challenge, value: 7 }) } }] } : { content: body.response_format ? JSON.stringify({ challenge, value: 7 }) : challenge } }], usage: { prompt_tokens: 11, completion_tokens: 8 } })); });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const owner = await startLocalHost({ profileRoot: root, httpPort: 0, credentialBackend: "private-file" }); const native = await connectLocalHost({ profileRoot: root });
    const writes: string[] = [], errors: string[] = []; const options = { connect: async () => await connectLocalHost({ profileRoot: root }), write: (text: string) => writes.push(text), writeError: (text: string) => errors.push(text) };
    try {
      await native.client.saveModelConnection({ command_id: "cli:save", connection_id: "fixture", label: "CLI fixture", provider: "custom", protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "cli-fixture-model", api_key: "synthetic-only-cli-key" });
      const input = { expected_revision: 0, model: "cli-fixture-model", features: ["text", "tools", "structured"], confirmed: true };
      const argv = ["models", "capability-test", "fixture", "--command-id", "cli:probe", "--input-json", JSON.stringify(input)]; expect(await maybeRunWorkbenchCommand(argv, options)).toBe(0); const result = JSON.parse(writes.at(-1)!); expect(result.results.map((item: { status: string }) => item.status)).toEqual(["passed", "passed", "passed"]); expect(result.results.every((item: { usage: { total_tokens: number; cost?: unknown } }) => item.usage.total_tokens === 19 && !item.usage.cost)).toBe(true); expect(requests).toBe(3);
      expect(await maybeRunWorkbenchCommand(argv, options)).toBe(0); expect(requests).toBe(3); expect(await maybeRunWorkbenchCommand(["models", "capability-receipt", "cli:probe"], options)).toBe(0); expect(JSON.parse(writes.at(-1)!)).toMatchObject({ command_id: "cli:probe", state: "completed" }); expect(requests).toBe(3);
      expect(await maybeRunWorkbenchCommand(["models", "capability-test", "fixture", "--input-json", JSON.stringify({ ...input, confirmed: false })], options)).toBe(1); expect(requests).toBe(3);
      phase = "auth"; expect(await maybeRunWorkbenchCommand(["models", "capability-test", "fixture", "--command-id", "cli:auth", "--input-json", JSON.stringify({ ...input, features: ["tools"] })], options)).toBe(1); expect(JSON.parse(writes.at(-1)!).results[0]).toMatchObject({ status: "failed", code: "model_authentication_failed" });
      phase = "drop"; expect(await maybeRunWorkbenchCommand(["models", "capability-test", "fixture", "--command-id", "cli:unknown", "--input-json", JSON.stringify({ ...input, features: ["text"] })], options)).toBe(3); expect(requests).toBe(5); expect(await maybeRunWorkbenchCommand(["models", "capability-receipt", "cli:unknown"], options)).toBe(3); expect(requests).toBe(5); expect(JSON.parse(writes.at(-1)!)).toMatchObject({ state: "completed", result: { results: [{ status: "unknown" }] } }); expect(writes.join("") + errors.join("")).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC"); expect(writes.join("")).not.toContain("synthetic-only-cli-key");
    } finally { await native.close(); await owner.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
