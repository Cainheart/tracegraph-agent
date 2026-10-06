import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseSseData } from "@tracegraph/sdk";
import { createLocalFetch } from "./local-fetch.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "outlive-private-sse-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\outlive-sse-${directory.split(/[\\/]/u).at(-1)}` : join(directory, "host.sock");
  const sockets = new Set<Socket>();
  let accepted!: (response: ServerResponse) => void;
  const responseReady = new Promise<ServerResponse>(resolve => { accepted = resolve; });
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": private idle stream\n\n");
    accepted(response);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const transport = createLocalFetch(socketPath, "private-test-only-no-user-credential");
  return { transport, responseReady, sockets, async close() { transport.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); } };
}
async function closed(response: ServerResponse): Promise<boolean> {
  if (response.destroyed) return true;
  let timer: ReturnType<typeof setTimeout>;
  return new Promise(resolve => {
    const onClose = () => { clearTimeout(timer); resolve(true); };
    response.once("close", onClose);
    timer = setTimeout(() => { response.off("close", onClose); resolve(false); }, 300);
  });
}

describe("real private HTTP SSE client lifetime", () => {
  it("ends an idle private SSE read when the client signal aborts without touching a Run", async () => {
    const f = await fixture();
    try {
      const abort = new AbortController();
      const response = await f.transport.fetch("http://outlive.local/api/runs/fixture/events/stream", { signal: abort.signal });
      const serverResponse = await f.responseReady;
      const iterator = parseSseData(response.body!, abort.signal);
      const pending = iterator.next();
      // Enter an actual idle socket-backed read, not a mock that resolves on abort.
      await new Promise(resolve => setImmediate(resolve));
      abort.abort();
      await Promise.allSettled([pending, iterator.return()]);
      expect(await closed(serverResponse)).toBe(true);
    } finally { await f.close(); }
  });

  it("releases the private response when an SSE consumer returns after a public event", async () => {
    const f = await fixture();
    try {
      const response = await f.transport.fetch("http://outlive.local/api/runs/fixture/events/stream");
      const serverResponse = await f.responseReady;
      const iterator = parseSseData(response.body!);
      const pending = iterator.next();
      serverResponse.write("data: public fixture event\n\n");
      expect(await pending).toEqual({ done: false, value: "public fixture event" });
      await iterator.return();
      expect(await closed(serverResponse), "Returning an SSE iterator must close its private response").toBe(true);
    } finally { await f.close(); }
  });
});
