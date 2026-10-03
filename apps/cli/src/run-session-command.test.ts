import type { RunProjection, WireSessionEvent } from "@tracegraph/contracts";
import {
  CLIENT_PROTOCOL_CONFORMANCE_FIXTURES,
  ClientEventMessageSchema,
  ClientProtocolMessageSchema,
} from "@tracegraph/sdk/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  runRunSessionCommand,
  RunSessionCommandError,
  type RunSessionCommandClient,
} from "./run-session-command.js";

const ledgerFixture = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES.find(({ name }) => name === "event.ledger")?.message;
if (ledgerFixture?.kind !== "event" || ledgerFixture.event.stream !== "ledger") {
  throw new Error("The shared protocol fixture set must include a ledger event");
}
const canonicalEvent = ledgerFixture.event.event;

function createClient(overrides: Partial<RunSessionCommandClient> = {}): RunSessionCommandClient {
  return {
    bootstrap: vi.fn(async () => ({})),
    startRun: vi.fn(async () => { throw new Error("Unexpected startRun call"); }),
    getRun: vi.fn(async () => ({ run_id: "run-fixture", timeline: [] }) as unknown as RunProjection),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    getSession: vi.fn(async () => { throw new Error("Unexpected getSession call"); }),
    streamEvents: async function* (): AsyncGenerator<WireSessionEvent, void, void> {},
    ...overrides,
  };
}

describe("CLI Run/Session client commands", () => {
  it("writes a schema-valid JSON reply to stdout without adding diagnostics", async () => {
    const output: string[] = [];
    const client = createClient();

    await runRunSessionCommand("sessions", ["list", "--project-id", "project-fixture", "--limit", "25"], {
      createClient: () => client,
      write: (line) => output.push(line),
    });

    expect(client.bootstrap).toHaveBeenCalledOnce();
    expect(client.listSessions).toHaveBeenCalledWith({
      project_id: "project-fixture",
      view: "roots",
      limit: 25,
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^\{.*\}\n$/u);
    const reply = ClientProtocolMessageSchema.parse(JSON.parse(output[0]!));
    expect(reply).toMatchObject({ kind: "reply", result: { resource: "sessions", value: { sessions: [] } } });
  });

  it("rejects invalid input before bootstrapping or writing stdout", async () => {
    const output: string[] = [];
    const client = createClient();

    await expect(runRunSessionCommand("run", ["start", "--project-id", "project-fixture"], {
      createClient: () => client,
      write: (line) => output.push(line),
    })).rejects.toBeInstanceOf(RunSessionCommandError);

    expect(client.bootstrap).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it("does not write a success-shaped line when Host bootstrap fails", async () => {
    const output: string[] = [];
    const client = createClient({
      bootstrap: vi.fn(async () => { throw new Error("Host unavailable"); }),
    });

    await expect(runRunSessionCommand("sessions", ["list"], {
      createClient: () => client,
      write: (line) => output.push(line),
    })).rejects.toThrow("Host unavailable");

    expect(output).toEqual([]);
  });

  it("emits the shared canonical ledger event envelope and resumes follow at its sequence", async () => {
    const output: string[] = [];
    const followEvent = { ...canonicalEvent, event_id: "event-run-followed", sequence: 2 };
    let streamOptions: Parameters<RunSessionCommandClient["streamEvents"]>[1];
    const client = createClient({
      getRun: vi.fn(async () => ({
        run_id: canonicalEvent.run_id,
        timeline: [canonicalEvent],
      }) as unknown as RunProjection),
      streamEvents: vi.fn(async function* (_runId, options) {
        streamOptions = options;
        yield followEvent;
      }),
    });
    const signal = new AbortController().signal;

    await runRunSessionCommand("run", ["events", canonicalEvent.run_id, "--follow"], {
      createClient: () => client,
      write: (line) => output.push(line),
      signal,
    });

    expect(streamOptions).toMatchObject({ afterSequence: 1, reconnect: true, signal });
    const messages = output.map((line) => ClientEventMessageSchema.parse(JSON.parse(line)));
    expect(messages).toEqual([
      ledgerFixture,
      {
        protocol_version: ledgerFixture.protocol_version,
        kind: "event",
        event: { stream: "ledger", event: followEvent },
      },
    ]);
  });
});
