import { randomUUID } from "node:crypto";
import type { TraceGraphClient } from "@tracegraph/sdk";
import type { z } from "zod";
import { DesktopStreamIdSchema, DesktopStreamOpenSchema, DesktopStreamPacketSchema, type DesktopStreamPacket } from "./stream-contract.js";

type StreamState = { owner: number; abort: AbortController; iterator: AsyncIterator<unknown>; reading: boolean; ended: boolean };

/** Pull-driven SSE forwarding keeps memory bounded and never grants Run cancellation authority. */
export class DesktopStreamManager {
  readonly #streams = new Map<string, StreamState>();
  readonly #client: TraceGraphClient;
  constructor(client: TraceGraphClient,readonly generation=0) { this.#client = client; }

  open(owner: number, input: unknown): string {
    const request = DesktopStreamOpenSchema.parse(input);
    if(request.generation!==undefined&&request.generation!==this.generation)throw new Error("The requested Desktop stream generation is stale");
    if ([...this.#streams.values()].filter((stream) => stream.owner === owner).length >= 12) throw new Error("Desktop stream limit reached");
    const abort = new AbortController();
    const options = { signal: abort.signal, reconnect: request.reconnect };
    const iterator = request.kind === "ledger"
      ? this.#client.streamEvents(request.run_id, { ...options, afterSequence: request.after })
      : request.kind === "activity"
        ? this.#client.streamLiveActivities(request.run_id, { ...options, afterSequence: request.after })
        : this.#client.streamModelSurface(request.run_id, { ...options, afterCursor: request.after });
    const id = randomUUID();
    this.#streams.set(id, { owner, abort, iterator: taggedIterator(request.kind, iterator), reading: false, ended: false });
    return id;
  }

  async read(owner: number, input: unknown): Promise<DesktopStreamPacket> {
    const id = DesktopStreamIdSchema.parse(input);
    const stream = this.#owned(owner, id);
    if (stream.reading) throw new Error("A Desktop stream read is already pending");
    if (stream.ended) return { state: "end",generation:this.generation };
    stream.reading = true;
    try {
      const next = await stream.iterator.next();
      if (next.done || stream.abort.signal.aborted) { stream.ended = true; return { state: "end",generation:this.generation }; }
      return DesktopStreamPacketSchema.parse({...next.value as Record<string,unknown>,generation:this.generation});
    } catch {
      stream.ended = true;
      // Provider/transport exceptions can contain private URLs or credentials.
      return stream.abort.signal.aborted ? { state: "end",generation:this.generation } : { state: "error", message: "The Host public stream disconnected",generation:this.generation };
    } finally { stream.reading = false; }
  }

  async close(owner: number, input: unknown): Promise<void> {
    const id = DesktopStreamIdSchema.parse(input);
    const stream = this.#streams.get(id);
    if (stream === undefined) return;
    this.#owned(owner, id);
    this.#streams.delete(id);
    stream.abort.abort();
    await stream.iterator.return?.();
  }

  async closeOwner(owner: number): Promise<void> {
    await Promise.all([...this.#streams].filter(([, stream]) => stream.owner === owner).map(([id]) => this.close(owner, id)));
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.#streams].map(([id, stream]) => this.close(stream.owner, id)));
  }
  #owned(owner: number, id: string): StreamState {
    const stream = this.#streams.get(id);
    if (stream === undefined || stream.owner !== owner) throw new Error("Unknown Desktop stream");
    return stream;
  }
}

async function* taggedIterator(kind: z.infer<typeof DesktopStreamOpenSchema>["kind"], input: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  for await (const value of input) {
    // Compatibility thinking events never reach the renderer.
    if (kind === "model_surface" && typeof value === "object" && value !== null && "type" in value && value.type === "thinking_snapshot") continue;
    yield { state: "event", kind, value };
  }
}
