import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionEvent } from "@tracegraph/contracts";
import { EXTENSION_API_VERSION, SCHEMA_VERSION } from "@tracegraph/contracts";
import type { TelemetryEvent, TelemetrySink } from "@tracegraph/telemetry";
import {
  ExtensionManager,
  ExtensionManagerError,
  type Disposable,
  type TraceGraphExtension,
} from "./extension.js";
import {
  RawToolResultSchema,
  ToolRegistry,
  createArtifactToolsExtension,
  createCoreToolRegistry,
  createRunStateToolsExtension,
} from "./tool-registry.js";
import type { ToolDefinition } from "./types.js";

describe("G17 ExtensionManager", () => {
  it("rejects API mismatches before activation and exposes a safe rejected status", async () => {
    const manager = new ExtensionManager();
    const activate = vi.fn();
    await expect(manager.activate({
      name: "acme.bad-version",
      api_version: "tracegraph.extension.v2",
      activate,
    } as unknown as TraceGraphExtension)).rejects.toMatchObject({ code: "extension_api_version_mismatch" });
    expect(activate).not.toHaveBeenCalled();
    expect(manager.listStatuses()).toEqual([expect.objectContaining({
      name: "acme.bad-version",
      state: "rejected",
      error_code: "extension_api_version_mismatch",
    })]);
  });

  it("rolls back a partial activation and rejects owned registration conflicts", async () => {
    const manager = new ExtensionManager();
    await expect(manager.activate(extension("acme.partial", (context) => {
      context.registerTool(tool("acme.partial.tool"));
      context.registerCommand("acme.partial.command", async () => ({
        command_id: "unused",
        name: "acme.partial.command",
        status: "success",
        summary: "unused",
      }));
      throw new Error("activate exploded");
    }))).rejects.toThrow("activate exploded");
    expect(manager.toolRegistry.get("acme.partial.tool")).toBeUndefined();
    expect((await manager.invokeCommand({
      command_id: "command:missing",
      name: "acme.partial.command",
      args: [],
    })).status).toBe("failure");

    await manager.activate(extension("acme.owner", (context) => {
      context.registerTool(tool("acme.unique"));
    }));
    await expect(manager.activate(extension("acme.conflict", (context) => {
      context.registerTool(tool("acme.unique"));
    }))).rejects.toMatchObject({ code: "extension_tool_conflict" });
    expect(manager.toolRegistry.get("acme.unique")).toBeDefined();
  });

  it("deactivates every registration even when deactivate throws", async () => {
    const manager = new ExtensionManager();
    const deactivate = vi.fn(() => { throw new Error("deactivate failed"); });
    await manager.activate({
      ...extension("acme.cleanup", (context) => {
        context.registerTool(tool("acme.cleanup.tool"));
        context.registerPolicyRule({
          rule_id: "rule:cleanup",
          priority: 1,
          when: { tool: "acme.cleanup.tool" },
          then: "ask",
          explanation: "Ask for cleanup tool",
        });
      }),
      deactivate,
    });
    const status = await manager.deactivate("acme.cleanup");
    expect(status.state).toBe("failed");
    expect(status.registration_count).toBe(0);
    expect(manager.toolRegistry.get("acme.cleanup.tool")).toBeUndefined();
    expect(manager.policyRules()).toEqual([]);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("makes returned disposers idempotent and lease-safe after activation", async () => {
    const manager = new ExtensionManager();
    let disposable!: Disposable;
    await manager.activate(extension("acme.disposer", (context) => {
      disposable = context.registerTool(tool("acme.disposable-tool"));
    }));
    const before = manager.snapshot();
    const lease = manager.acquireRunLease();
    await expect(disposable.dispose()).rejects.toMatchObject({ code: "extension_busy" });
    expect(manager.toolRegistry.get("acme.disposable-tool")).toBeDefined();
    lease.release();

    await disposable.dispose();
    await disposable.dispose();
    expect(manager.toolRegistry.get("acme.disposable-tool")).toBeUndefined();
    expect(manager.snapshot().generation).toBe(before.generation + 1);
    expect(manager.listStatuses()[0]).toMatchObject({ state: "active", registration_count: 0 });
  });

  it("deep-freezes committed hook input, isolates failures and never dispatches extension.error", async () => {
    const manager = new ExtensionManager({ hookTimeoutMs: 50 });
    let secondCalls = 0;
    await manager.activate(extension("acme.throwing-hook", (context) => {
      context.on("run.started", async (event) => {
        (event.data as { phase?: string }).phase = "mutated";
      });
      context.on("extension.error", async () => { throw new Error("must not run"); });
    }));
    await manager.activate(extension("acme.second-hook", (context) => {
      context.on("run.started", async () => { secondCalls += 1; });
    }));
    const event = sessionEvent("run.started", { phase: "conversation" });
    const errors = await manager.dispatchEvent(event);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ extensionName: "acme.throwing-hook", phase: "event_hook" });
    expect(secondCalls).toBe(1);
    expect(event.data.phase).toBe("conversation");
    expect(await manager.dispatchEvent(sessionEvent("extension.error", {}))).toEqual([]);
  });

  it("bounds asynchronous hook and Context execution with independent timeouts", async () => {
    const manager = new ExtensionManager({ hookTimeoutMs: 10, contextTimeoutMs: 10 });
    await manager.activate(extension("acme.timeouts", (context) => {
      context.on("run.started", () => new Promise<void>(() => undefined));
      context.registerContextStrategy({
        name: "acme.timeout-context",
        contribute: () => new Promise(() => undefined),
      });
    }));
    expect(await manager.dispatchEvent(sessionEvent("run.started", {}))).toEqual([
      expect.objectContaining({ code: "extension_hook_timeout", phase: "event_hook" }),
    ]);
    expect((await manager.collectContextContributions({
      projectId: "project:timeout",
      runId: "run:timeout",
      task: "Bound extension execution",
      turn: 1,
    })).errors).toEqual([
      expect.objectContaining({ code: "extension_context_timeout", phase: "context_strategy" }),
    ]);
  });

  it("bounds context contributions and isolates an invalid strategy", async () => {
    const manager = new ExtensionManager();
    await manager.activate(extension("acme.context", (context) => {
      context.registerContextStrategy({
        name: "acme.good-context",
        contribute: async () => ({ summary: "Useful bounded context", facts: { source: "fixture" } }),
      });
      context.registerContextStrategy({
        name: "acme.bad-context",
        contribute: async () => ({ summary: "x", facts: { payload: "x".repeat(17 * 1024) } }),
      });
    }));
    const result = await manager.collectContextContributions({
      projectId: "project:one",
      runId: "run:one",
      task: "Inspect",
      turn: 1,
    });
    expect(result.contributions).toEqual([expect.objectContaining({
      extensionName: "acme.context",
      strategyName: "acme.good-context",
    })]);
    expect(result.errors).toEqual([expect.objectContaining({
      extensionName: "acme.context",
      phase: "context_strategy",
    })]);
  });

  it("fans telemetry out without allowing one extension sink to block another", async () => {
    const manager = new ExtensionManager();
    const received: TelemetryEvent[] = [];
    const fanout = manager.telemetrySink();
    expect(fanout.kind).toBe("noop");
    await manager.activate(extension("acme.telemetry", (context) => {
      context.registerTelemetrySink(sink(() => { throw new Error("sink failed"); }));
      context.registerTelemetrySink(sink((event) => { received.push(event); }));
    }));
    expect(fanout.kind).toBe("custom");
    fanout.emit(telemetryEvent());
    expect(received).toHaveLength(1);
    expect(manager.drainTelemetryErrors()).toEqual([expect.objectContaining({
      extensionName: "acme.telemetry",
      phase: "telemetry_sink",
    })]);
    fanout.emit({
      ...telemetryEvent(),
      name: "run.lifecycle",
      attributes: { event_type: "extension.error" },
    });
    expect(received).toHaveLength(1);
    expect(manager.drainTelemetryErrors()).toEqual([]);
    await manager.deactivate("acme.telemetry");
    expect(fanout.kind).toBe("noop");
  });

  it("invokes strict commands and snapshots policy registrations", async () => {
    const manager = new ExtensionManager();
    await manager.activate(extension("acme.command", (context) => {
      context.registerCommand("acme.echo", async (input) => ({
        command_id: input.command_id,
        name: input.name,
        status: "success",
        summary: input.args.join(" ") || "empty",
      }));
      context.registerPolicyRule({
        rule_id: "rule:acme-echo",
        priority: 9,
        when: { tool: "acme.echo" },
        then: "ask",
        explanation: "Ask before extension echo",
      });
    }));
    expect(await manager.invokeCommand({
      command_id: "command:echo",
      name: "acme.echo",
      args: ["hello"],
    })).toMatchObject({ status: "success", summary: "hello" });
    expect(manager.policyRules()).toEqual([expect.objectContaining({ rule_id: "rule:acme-echo" })]);
  });

  it("blocks lifecycle mutations while leased and lease acquisition during an activation race", async () => {
    const manager = new ExtensionManager();
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => { releaseActivation = resolve; });
    let activationStarted!: () => void;
    const started = new Promise<void>((resolve) => { activationStarted = resolve; });
    const activating = manager.activate(extension("acme.slow", async () => {
      activationStarted();
      await activationGate;
    }));
    // The mutation gate is synchronous: a Run cannot slip in during the
    // promise-continuation gap before activate() reaches extension code.
    expect(() => manager.acquireRunLease()).toThrowError(expect.objectContaining({ code: "extension_mutating" }));
    await started;
    expect(() => manager.acquireRunLease()).toThrowError(expect.objectContaining({ code: "extension_mutating" }));
    releaseActivation();
    await activating;

    const lease = manager.acquireRunLease();
    await expect(manager.activate(extension("acme.late", () => undefined)))
      .rejects.toMatchObject({ code: "extension_busy" });
    await expect(manager.reload("acme.slow", extension("acme.slow", () => undefined)))
      .rejects.toMatchObject({ code: "extension_busy" });
    lease.release();
  });

  it("restores the old extension registration surface when reload activation fails", async () => {
    const manager = new ExtensionManager();
    const original = extension("acme.reload", (context) => {
      context.registerTool(tool("acme.reload.tool"));
    });
    await manager.activate(original);
    await expect(manager.reload("acme.reload", extension("acme.reload", () => {
      throw new Error("new activation failed");
    }))).rejects.toThrow("new activation failed");
    expect(manager.toolRegistry.get("acme.reload.tool")).toBeDefined();
    expect(manager.listStatuses()).toEqual([expect.objectContaining({ name: "acme.reload", state: "active" })]);
  });

  it("assembles Artifact and Run-state tools as independently reversible built-in extensions", async () => {
    const registry = createCoreToolRegistry();
    const manager = new ExtensionManager({ toolRegistry: registry });
    await manager.activate(createArtifactToolsExtension());
    expect(registry.get("read_artifact")).toBeDefined();
    expect(registry.get("todo_read")).toBeUndefined();
    await manager.activate(createRunStateToolsExtension());
    expect(registry.get("todo_read")).toBeDefined();
    expect(registry.get("spawn_subagent")).toBeDefined();
    await manager.deactivate("@tracegraph/builtin-artifact-tools");
    expect(registry.get("read_artifact")).toBeUndefined();
    expect(registry.get("todo_read")).toBeDefined();
  });
});

function extension(
  name: string,
  activate: TraceGraphExtension["activate"],
): TraceGraphExtension {
  return { name, api_version: EXTENSION_API_VERSION, activate };
}

function tool(name: string): ToolDefinition<Record<string, never>> {
  return {
    name,
    description: "Fixture extension tool",
    inputSchema: z.object({}).strict(),
    outputSchema: RawToolResultSchema,
    capability: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    concurrencySafe: true,
    sideEffect: "read",
    maxResultBytes: 4_096,
    presentation: { callLabel: "Fixture", resultLabel: "Fixture result" },
    async execute() {
      return { status: "success", code: "ok", summary: "Extension tool succeeded" };
    },
    render(_input, output) {
      return output;
    },
  };
}

function sink(emit: (event: TelemetryEvent) => void): TelemetrySink {
  return { kind: "custom", emit, flush: async () => undefined };
}

function telemetryEvent(): TelemetryEvent {
  return {
    kind: "log",
    name: "fixture.event",
    at: "2026-09-19T00:00:00.000Z",
    run_id: "run:one",
    attributes: {},
    severity: "info",
  };
}

function sessionEvent(type: SessionEvent["type"], data: Record<string, unknown>): SessionEvent {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: `event:${type}`,
    project_id: "project:one",
    run_id: "run:one",
    session_id: "session:one",
    sequence: 1,
    occurred_at: "2026-09-19T00:00:00.000Z",
    attempt: 0,
    summary: type,
    artifact_refs: [],
    type,
    data,
    event_hash: `sha256:${"0".repeat(64)}`,
  };
}
