import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  TeamProjectionSchema,
  type TeamMutationResult,
  type TeamProjection,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import {
  createDefaultToolRegistry,
  executeToolDefinition,
  ListArtifactsInputSchema,
  ReadArtifactInputSchema,
  validateToolCall,
} from "./tool-registry.js";
import type { ToolDefinition, ToolExecutionContext } from "./types.js";
import {
  createReadonlyWorkspaceHandle,
  createManagedWorkspaceHandle,
  removeControlledTemporaryDirectory,
} from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("bounded file tools", () => {
  it("projects an explicit model schema whitelist and keeps all Host fields private", () => {
    const registry = createDefaultToolRegistry();
    const schemas = registry.modelSchemas();

    expect(schemas).toHaveLength(20);
    expect(schemas.map(({ name }) => name)).toEqual([
      "read_file",
      "read_artifact",
      "list_artifacts",
      "load_skill",
      "todo_read",
      "todo_write",
      "spawn_subagent",
      "send_subagent_message",
      "list_subagents",
      "interrupt_subagent",
      "team_read",
      "team_task_write",
      "team_mailbox_send",
      "team_mailbox_claim",
      "team_heartbeat",
      "list_dir",
      "search",
      "preview_patch",
      "commit_patch",
      "run_test",
    ]);
    for (const schema of schemas) {
      expect(Object.keys(schema).sort()).toEqual(["description", "input_schema", "name"]);
      for (const hostOnly of [
        "output_schema",
        "timeout_ms",
        "concurrency_safe",
        "side_effect",
        "max_result_bytes",
        "execute",
        "render",
      ]) {
        expect(Object.hasOwn(schema, hostOnly)).toBe(false);
      }
    }
    expect(registry.descriptors()).toHaveLength(20);
    expect(registry.descriptors().find(({ name }) => name === "commit_patch")).toMatchObject({
      concurrency_safe: false,
      side_effect: "write",
    });
  });

  it("deep-freezes Tool input before invoking an executor", async () => {
    const root = await temporaryRoot("deep-freeze");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:freeze", root });
    const base = createDefaultToolRegistry().get("search");
    if (!base) throw new Error("search tool is missing");
    let frozen = false;
    const definition = {
      ...base,
      async execute(input: { nested: { values: string[] } }) {
        frozen = Object.isFrozen(input)
          && Object.isFrozen(input.nested)
          && Object.isFrozen(input.nested.values);
        expect(() => input.nested.values.push("mutation")).toThrow();
        return { status: "success", code: "frozen", summary: "Input was frozen" } as const;
      },
    } as unknown as ToolDefinition<{ nested: { values: string[] } }>;

    const input = { nested: { values: ["original"] } };
    await expect(executeToolDefinition(definition, input, {
      projectId: workspace.project_id,
      runId: "run:freeze",
      workspace,
    })).resolves.toMatchObject({ status: "success", code: "frozen" });
    expect(frozen).toBe(true);
  });

  it("rejects unknown input keys for every built-in Tool", async () => {
    const root = await temporaryRoot("strict-tool-inputs");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:strict-inputs", root });
    const registry = createDefaultToolRegistry();
    const hash = `sha256:${"a".repeat(64)}`;
    const calls = [
      { tool_name: "read_file", arguments: { path: "README.md", host_only: true } },
      { tool_name: "read_artifact", arguments: { locator: "artifact:source", host_only: true } },
      { tool_name: "list_artifacts", arguments: { host_only: true } },
      { tool_name: "todo_read", arguments: { host_only: true } },
      { tool_name: "todo_write", arguments: { operation: "create", todo_id: "todo:strict", title: "Strict", host_only: true } },
      { tool_name: "team_read", arguments: { host_only: true } },
      { tool_name: "team_task_write", arguments: { operation: "create", task_id: "task:strict", title: "Strict", acceptance: ["Pass"], host_only: true } },
      { tool_name: "team_mailbox_send", arguments: { to: "coordinator", kind: "question", payload: "Strict", host_only: true } },
      { tool_name: "team_mailbox_claim", arguments: { message_id: "message:strict", host_only: true } },
      { tool_name: "team_heartbeat", arguments: { host_only: true } },
      { tool_name: "list_dir", arguments: { path: ".", host_only: true } },
      { tool_name: "search", arguments: { pattern: "needle", host_only: true } },
      { tool_name: "preview_patch", arguments: { path: "README.md", expected: "before", replacement: "after", host_only: true } },
      { tool_name: "commit_patch", arguments: { path: "README.md", expected: "before", replacement: "after", base_hash: hash, patch_hash: hash, host_only: true } },
      { tool_name: "run_test", arguments: { suite: "fixture", host_only: true } },
    ] as const;

    for (const [index, candidate] of calls.entries()) {
      let rejection: unknown;
      try {
        validateToolCall({
          call: {
            action_id: `action:strict-input:${index}`,
            tool_name: candidate.tool_name,
            arguments: candidate.arguments,
          },
          registry,
          projectId: workspace.project_id,
          runId: "run:strict-inputs",
          workspace,
          mode: "execute",
          sandboxMode: "workspace-write",
          now: new Date("2026-09-18T00:00:00.000Z"),
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({ code: "schema_invalid" });
    }
  });

  it("returns one maximum-size contract-valid Team task without truncating JSON", async () => {
    const registry = createDefaultToolRegistry();
    const read = registry.get("team_read");
    if (read === undefined) throw new Error("team_read tool is missing");
    const team = maximumTaskTeam();

    const result = await executeToolDefinition(read, {
      section: "task_board",
      offset: 0,
      limit: 1,
    }, teamToolContext(team));
    const page = JSON.parse(result.content ?? "null") as {
      team: { last_sequence: number };
      items: Array<{ acceptance: string[]; evidence_event_ids: string[] }>;
      returned_count: number;
      truncated: boolean;
    };

    expect(registry.descriptors().find(({ name }) => name === "team_read"))
      .toMatchObject({ max_result_bytes: 640 * 1024 });
    expect(result).toMatchObject({
      status: "success",
      code: "team_read",
      facts: {
        section: "task_board",
        returned_count: 1,
        offset: 0,
        truncated: false,
      },
    });
    expect(result.facts?.output_truncated).not.toBe(true);
    expect(Buffer.byteLength(result.content ?? "", "utf8")).toBeLessThan(512 * 1024);
    expect(page).toMatchObject({
      team: { last_sequence: team.last_sequence },
      returned_count: 1,
      truncated: false,
    });
    expect(page.items[0]?.acceptance).toHaveLength(32);
    expect(page.items[0]?.evidence_event_ids).toHaveLength(256);
  });

  it("byte-pages Team sections and rejects a changed snapshot between pages", async () => {
    const registry = createDefaultToolRegistry();
    const read = registry.get("team_read");
    if (read === undefined) throw new Error("team_read tool is missing");
    let team = mailboxTeam(24, 100);
    const seen: string[] = [];
    let offset = 0;
    let expectedLastSequence: number | undefined;
    let firstNextOffset: number | undefined;

    for (;;) {
      const result = await executeToolDefinition(read, {
        section: "mailbox",
        offset,
        limit: 100,
        ...(expectedLastSequence === undefined
          ? {}
          : { expected_last_sequence: expectedLastSequence }),
      }, teamToolContext(team));
      const page = JSON.parse(result.content ?? "null") as {
        team: { last_sequence: number };
        items: Array<{ message_id: string }>;
        returned_count: number;
        truncated: boolean;
        next_offset?: number;
      };
      expect(result.status).toBe("success");
      expect(result.facts?.output_truncated).not.toBe(true);
      expect(page.returned_count).toBeGreaterThan(0);
      expectedLastSequence ??= page.team.last_sequence;
      seen.push(...page.items.map(({ message_id: messageId }) => messageId));
      if (!page.truncated) break;
      firstNextOffset ??= page.next_offset;
      expect(page.next_offset).toBe(offset + page.returned_count);
      offset = page.next_offset!;
    }

    expect(seen).toEqual(team.mailbox.messages.map(({ message_id: messageId }) => messageId));
    expect(new Set(seen).size).toBe(seen.length);
    expect(firstNextOffset).toBeDefined();

    const pastEnd = await executeToolDefinition(read, {
      section: "mailbox",
      offset: 2_000,
      limit: 25,
      expected_last_sequence: expectedLastSequence,
    }, teamToolContext(team));
    expect(JSON.parse(pastEnd.content ?? "null")).toMatchObject({
      items: [],
      returned_count: 0,
      offset: 2_000,
      truncated: false,
    });

    team = TeamProjectionSchema.parse({
      ...team,
      last_sequence: team.last_sequence + 1,
      mailbox: { ...team.mailbox, last_sequence: team.mailbox.last_sequence + 1 },
    });
    const changed = await executeToolDefinition(read, {
      section: "mailbox",
      offset: firstNextOffset,
      limit: 100,
      expected_last_sequence: expectedLastSequence,
    }, teamToolContext(team));
    expect(changed).toMatchObject({
      status: "failure",
      code: "team_snapshot_changed",
      facts: {
        section: "mailbox",
        offset: firstNextOffset,
        expected_last_sequence: expectedLastSequence,
        current_last_sequence: team.last_sequence,
      },
    });
    expect(changed.content).toBeUndefined();
  });

  it("returns compact Team mutation receipts instead of the complete projection", async () => {
    const registry = createDefaultToolRegistry();
    const team = TeamProjectionSchema.parse({
      ...maximumTaskTeam(),
      mailbox: mailboxTeam(12, 999).mailbox,
      last_sequence: 999,
      task_board: { ...maximumTaskTeam().task_board, last_sequence: 999 },
      roster: { ...maximumTaskTeam().roster, last_sequence: 999 },
    });
    const mutation: TeamMutationResult = {
      command_id: "command:team:compact",
      disposition: "applied",
      event_ids: ["event:team:compact"],
      team,
    };
    const context = teamToolContext(team, mutation);
    const cases = [
      ["team_task_write", {
        operation: "claim",
        task_id: team.task_board.items[0]!.task_id,
        expected_version: 1,
      }],
      ["team_mailbox_send", { to: team.roster.members[0]!.link.subagent_id, kind: "question", payload: "Status?" }],
      ["team_mailbox_claim", { message_id: team.mailbox.messages[0]!.message_id }],
      ["team_heartbeat", {}],
    ] as const;

    for (const [name, input] of cases) {
      const tool = registry.get(name);
      if (tool === undefined) throw new Error(`${name} tool is missing`);
      const result = await executeToolDefinition(tool, input, context);
      const receipt = JSON.parse(result.content ?? "null") as {
        command_id: string;
        event_ids: string[];
        team: Record<string, unknown>;
      };
      expect(registry.descriptors().find(({ name: toolName }) => toolName === name))
        .toMatchObject({ max_result_bytes: 32 * 1024 });
      expect(result).toMatchObject({
        status: "success",
        facts: {
          command_id: mutation.command_id,
          event_ids: mutation.event_ids,
          team_id: team.team_id,
          member_count: 1,
          mailbox_count: 12,
          task_count: 1,
        },
      });
      expect(result.facts?.output_truncated).not.toBe(true);
      expect(receipt).toMatchObject({
        command_id: mutation.command_id,
        event_ids: mutation.event_ids,
        team: {
          team_id: team.team_id,
          last_sequence: team.last_sequence,
        },
      });
      expect(Object.keys(receipt.team).sort()).toEqual(["counts", "last_sequence", "team_id"]);
      expect(result.content).not.toContain('"roster"');
      expect(result.content).not.toContain('"task_board"');
    }
  });

  it("keeps commit_patch approval-gated and denies it in read-only sandbox mode", async () => {
    const root = await temporaryRoot("sandbox-write-policy");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:sandbox-policy", root });
    const registry = createDefaultToolRegistry();
    const hash = `sha256:${"a".repeat(64)}`;
    const input = {
      call: {
        action_id: "action:sandbox-policy",
        tool_name: "commit_patch" as const,
        arguments: {
          path: "README.md",
          expected: "before",
          replacement: "after",
          base_hash: hash,
          patch_hash: hash,
        },
      },
      registry,
      projectId: workspace.project_id,
      runId: "run:sandbox-policy",
      workspace,
      mode: "execute" as const,
      now: new Date("2026-09-19T00:00:00.000Z"),
    };

    expect(() => validateToolCall({
      ...input,
      sandboxMode: "workspace-write",
    })).toThrowError(expect.objectContaining({ code: "approval_required" }));
    expect(() => validateToolCall({
      ...input,
      sandboxMode: "read-only",
      approvalId: "approval:sandbox-policy",
    })).toThrowError(expect.objectContaining({ code: "sandbox_denied" }));
  });

  it("settles on timeout even when an executor ignores cancellation", async () => {
    const root = await temporaryRoot("tool-timeout");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:timeout", root });
    const base = createDefaultToolRegistry().get("search");
    if (!base) throw new Error("search tool is missing");
    const definition = {
      ...base,
      timeoutMs: 20,
      async execute() {
        return new Promise<never>(() => undefined);
      },
    } as ToolDefinition;
    const startedAt = Date.now();

    const result = await executeToolDefinition(definition, { pattern: "needle" }, {
      projectId: workspace.project_id,
      runId: "run:timeout",
      workspace,
    });

    expect(result).toMatchObject({ status: "failure", code: "timeout", facts: { timeout_ms: 20 } });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("rethrows a Host durability boundary before translating an aborted parent signal", async () => {
    const root = await temporaryRoot("host-boundary-priority");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:host-boundary", root });
    const base = createDefaultToolRegistry().get("search");
    if (!base) throw new Error("search tool is missing");
    const controller = new AbortController();
    const boundary = new Error("HOST_DURABILITY_BOUNDARY");
    const definition = {
      ...base,
      async execute(): Promise<never> {
        controller.abort(new Error("parent stopped"));
        throw boundary;
      },
    } as ToolDefinition;

    await expect(executeToolDefinition(definition, { pattern: "needle" }, {
      projectId: workspace.project_id,
      runId: "run:host-boundary",
      workspace,
      signal: controller.signal,
      isHostBoundaryError: (error) => error === boundary,
    })).rejects.toBe(boundary);
  });

  it("rejects invalid Tool output before render without leaking dirty data", async () => {
    const root = await temporaryRoot("output-contract");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:contract", root });
    let rendered = false;
    const base = createDefaultToolRegistry().get("search");
    if (!base) throw new Error("search tool is missing");
    const definition = {
      ...base,
      outputSchema: z.object({ safe: z.string() }).strict(),
      async execute() {
        return { safe: "expected", secret_payload: "DIRTY_OUTPUT_MUST_NOT_LEAK" };
      },
      render() {
        rendered = true;
        return { status: "success", code: "unsafe", summary: "DIRTY_OUTPUT_MUST_NOT_LEAK" };
      },
    } as unknown as ToolDefinition<unknown, { safe: string }>;

    const result = await executeToolDefinition(definition, {}, {
      projectId: workspace.project_id,
      runId: "run:contract",
      workspace,
    });

    expect(result).toMatchObject({ status: "failure", code: "output_contract_violation" });
    expect(rendered).toBe(false);
    expect(JSON.stringify(result)).not.toContain("DIRTY_OUTPUT_MUST_NOT_LEAK");
  });

  it("rejects result codes that cannot fit the durable batch contract", async () => {
    const root = await temporaryRoot("result-code-contract");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:result-code", root });
    const base = createDefaultToolRegistry().get("search");
    if (!base) throw new Error("search tool is missing");
    const definition = {
      ...base,
      async execute() {
        return {
          status: "success",
          code: "x".repeat(161),
          summary: "This result must fail before Runtime emits a batch member event",
        } as const;
      },
    } as ToolDefinition;

    const result = await executeToolDefinition(definition, { pattern: "needle" }, {
      projectId: workspace.project_id,
      runId: "run:result-code",
      workspace,
    });

    expect(result).toMatchObject({ status: "failure", code: "output_contract_violation" });
  });

  it("classifies executor exceptions as internal without exposing exception text", async () => {
    const root = await temporaryRoot("tool-internal");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:internal", root });
    const base = createDefaultToolRegistry().get("search");
    if (!base) throw new Error("search tool is missing");
    const definition = {
      ...base,
      async execute(): Promise<never> {
        throw new Error("PRIVATE_INTERNAL_DETAIL");
      },
    } as ToolDefinition;

    const result = await executeToolDefinition(definition, { pattern: "needle" }, {
      projectId: workspace.project_id,
      runId: "run:internal",
      workspace,
    });

    expect(result).toMatchObject({ status: "failure", code: "internal" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_INTERNAL_DETAIL");
  });

  it("bounds the final rendered UTF-8 envelope", async () => {
    const root = await temporaryRoot("output-limit");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:limit", root });
    const base = createDefaultToolRegistry().get("read_artifact");
    if (!base) throw new Error("read_artifact tool is missing");
    const definition = {
      ...base,
      maxResultBytes: 512,
      async execute() {
        return {
          status: "success",
          code: "large",
          summary: "Bound a large result",
          content: "🙂原文".repeat(2_000),
          facts: { detail: "证据".repeat(2_000) },
        } as const;
      },
    } as ToolDefinition;

    const result = await executeToolDefinition(definition, {}, {
      projectId: workspace.project_id,
      runId: "run:limit",
      workspace,
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(512);
    expect(JSON.stringify(result)).not.toContain("�");
    expect(result.facts).toMatchObject({ output_truncated: true });
  });

  it("lists only stable paged metadata from the current Run", async () => {
    expect(ListArtifactsInputSchema.parse({})).toEqual({ offset: 0, limit: 50 });
    expect(() => ListArtifactsInputSchema.parse({ project_id: "project:other" })).toThrow();
    const root = await temporaryRoot("artifact-list");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:artifacts", root });
    const tool = createDefaultToolRegistry().get("list_artifacts");
    if (!tool) throw new Error("list_artifacts tool is missing");
    const refs = [
      artifactRef("artifact:b", workspace.project_id, "run:artifacts", "2026-09-18T00:00:02.000Z"),
      artifactRef("artifact:a", workspace.project_id, "run:artifacts", "2026-09-18T00:00:01.000Z"),
      { ...artifactRef("artifact:recovery", workspace.project_id, "run:artifacts", "2026-09-18T00:00:00.500Z"), kind: "recovery_state" as const },
      artifactRef("artifact:foreign", workspace.project_id, "run:foreign", "2026-09-18T00:00:00.000Z"),
    ];
    const context = {
      projectId: workspace.project_id,
      runId: "run:artifacts",
      workspace,
      async listArtifacts() {
        return refs;
      },
    };

    const first = await executeToolDefinition(tool, { offset: 0, limit: 1 }, context);
    expect(first.facts).toMatchObject({
      artifacts: [{ artifact_id: "artifact:a", locator: "artifact:artifact:a" }],
      count: 1,
      total: 2,
      truncated: true,
      next_offset: 1,
    });
    expect(first.content).toContain('"artifact_id": "artifact:a"');
    expect(JSON.stringify(first)).not.toContain("project:artifacts");
    expect(JSON.stringify(first)).not.toContain("artifact:foreign");
    expect(JSON.stringify(first)).not.toContain("artifact:recovery");

    const second = await executeToolDefinition(tool, { offset: 1, limit: 1 }, context);
    expect(second.facts).toMatchObject({
      artifacts: [{ artifact_id: "artifact:b" }],
      total: 2,
      truncated: false,
    });
  });

  it("retrieves a scoped archived Context source through its opaque locator", async () => {
    const root = await temporaryRoot("artifact-read");
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:artifact-read", root });
    const tool = createDefaultToolRegistry().get("read_artifact");
    if (!tool) throw new Error("read_artifact tool is missing");

    const result = await tool.execute({ locator: "artifact:context-source-1", offset: 0, limit: 4_000 }, {
      projectId: "project:artifact-read",
      runId: "run:artifact-read",
      workspace,
      async readArtifact(input) {
        expect(input).toEqual({ locator: "artifact:context-source-1", offset: 0, limit: 4_000 });
        return {
          artifactId: "context-source-1",
          content: "archived observation bytes",
          contentHash: "sha256:7f8c4b300bcf530bf98e08b0bf56bc8f452708aa851c8de35ef15f4c9c1971d5",
          mimeType: "text/plain",
          offset: 0,
          returnedBytes: 26,
          totalBytes: 26,
          truncated: false,
        };
      },
    });

    expect(result).toMatchObject({
      status: "success",
      code: "artifact_read",
      content: "archived observation bytes",
      facts: {
        locator: "artifact:context-source-1",
        artifact_id: "context-source-1",
        offset: 0,
        truncated: false,
      },
    });
  });

  it("validates bounded Artifact pages and keeps run-scoped reads independent from workspace reads", async () => {
    expect(ReadArtifactInputSchema.parse({ locator: "artifact:source" })).toEqual({
      locator: "artifact:source",
      offset: 0,
      limit: 4_000,
    });
    expect(() => ReadArtifactInputSchema.parse({ locator: "artifact://source" })).toThrow();
    expect(() => ReadArtifactInputSchema.parse({ locator: "artifact:source", limit: 4_001 })).toThrow();

    const root = await temporaryRoot("artifact-zero-capability");
    const base = await createManagedWorkspaceHandle({ projectId: "project:artifact-zero-capability", root });
    const workspace = {
      ...base,
      capabilities: {
        index: false,
        read: false,
        search: false,
        run_command: false,
        preview_patch: false,
        commit_patch: false,
        test: false,
      },
    };
    const registry = createDefaultToolRegistry();
    expect(() => validateToolCall({
      call: {
        action_id: "action:artifact-page",
        tool_name: "read_artifact",
        arguments: { locator: "artifact:source", offset: 0, limit: 4_000 },
      },
      registry,
      projectId: workspace.project_id,
      runId: "run:artifact-page",
      workspace,
      mode: "plan",
      sandboxMode: "workspace-write",
      now: new Date("2026-09-18T00:00:00.000Z"),
    })).not.toThrow();
    expect(() => validateToolCall({
      call: {
        action_id: "action:artifact-list",
        tool_name: "list_artifacts",
        arguments: { offset: 0, limit: 50 },
      },
      registry,
      projectId: workspace.project_id,
      runId: "run:artifact-list",
      workspace,
      mode: "plan",
      sandboxMode: "workspace-write",
      now: new Date("2026-09-18T00:00:00.000Z"),
    })).not.toThrow();
    expect(() => validateToolCall({
      call: {
        action_id: "action:file-read",
        tool_name: "read_file",
        arguments: { path: "src/index.ts" },
      },
      registry,
      projectId: workspace.project_id,
      runId: "run:file-read",
      workspace,
      mode: "plan",
      sandboxMode: "workspace-write",
      now: new Date("2026-09-18T00:00:00.000Z"),
    })).toThrow("read is disabled by WorkspaceHandle");
  });

  it("previews and commits a new file inside an existing managed directory", async () => {
    const root = await temporaryRoot("managed-create");
    await mkdir(join(root, "src"));
    const workspace = await createManagedWorkspaceHandle({ projectId: "project:managed", root });
    const registry = createDefaultToolRegistry();
    const preview = registry.get("preview_patch");
    const commit = registry.get("commit_patch");
    if (!preview || !commit) throw new Error("patch tools are missing");
    const context = { projectId: "project:managed", runId: "run:create", workspace };
    const prepared = await preview.execute({ path: "src/greeting.ts", expected: "", replacement: "export const greeting = 'hello';\n" }, context);
    expect(prepared).toMatchObject({ status: "success", code: "patch_preview_created" });
    expect(prepared.content).toContain("--- /dev/null");
    const facts = prepared.facts as { base_hash: string; patch_hash: string };
    const applied = await commit.execute({ path: "src/greeting.ts", expected: "", replacement: "export const greeting = 'hello';\n", ...facts }, context);
    expect(applied).toMatchObject({ status: "success", code: "patch_committed" });
    await expect(readFile(join(root, "src/greeting.ts"), "utf8")).resolves.toBe("export const greeting = 'hello';\n");
  });

  it("rejects unbounded or invalid limit configuration", () => {
    expect(() => createDefaultToolRegistry({
      fileToolLimits: { maxFileBytes: Number.MAX_SAFE_INTEGER },
    })).toThrow(/maxFileBytes must be a safe integer/u);
    expect(() => createDefaultToolRegistry({
      fileToolLimits: { maxDepth: -1 },
    })).toThrow(/maxDepth must be a safe integer/u);
  });

  it("reads only maxFileBytes instead of materializing an oversized file", async () => {
    const root = await temporaryRoot("bounded-read");
    await writeFile(join(root, "large.txt"), Buffer.alloc(5 * 1024 * 1024, "x"));
    const workspace = await createReadonlyWorkspaceHandle({ projectId: "project:test", root });
    const tool = createDefaultToolRegistry({
      fileToolLimits: { maxFileBytes: 1_024 },
    }).get("read_file");
    if (!tool) throw new Error("read_file tool is missing");

    const result = await tool.execute({ path: "large.txt" }, {
      projectId: "project:test",
      runId: "run:test",
      workspace,
    });

    expect(result).toMatchObject({
      status: "success",
      code: "file_read",
      facts: { bytes_read: 1_024, truncated: true },
    });
    expect(Buffer.byteLength(result.content ?? "", "utf8")).toBe(1_024);
  });

  it("bounds search by file count, aggregate bytes, depth, and sensitive paths", async () => {
    const root = await temporaryRoot("bounded-search");
    await writeFile(join(root, ".env"), "needle=credential\n");
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(root, `file-${index}.txt`), `${"x".repeat(60)}needle\n`);
    }
    await mkdir(join(root, "level-1", "level-2"), { recursive: true });
    await writeFile(join(root, "level-1", "level-2", "deep.txt"), "deep-needle\n");
    const workspace = await createReadonlyWorkspaceHandle({ projectId: "project:test", root });
    const registry = createDefaultToolRegistry({
      fileToolLimits: {
        maxFileBytes: 32,
        maxFiles: 4,
        maxBytes: 64,
        maxDepth: 1,
        maxMatches: 10,
      },
    });
    const tool = registry.get("search");
    if (!tool) throw new Error("search tool is missing");

    const result = await tool.execute({ pattern: "needle" }, {
      projectId: "project:test",
      runId: "run:test",
      workspace,
    });
    const facts = result.facts as {
      files_scanned: number;
      bytes_scanned: number;
      incomplete: boolean;
      limit_reasons: string[];
      matches: Array<{ path: string }>;
    };

    expect(facts.files_scanned).toBeLessThanOrEqual(4);
    expect(facts.bytes_scanned).toBeLessThanOrEqual(64);
    expect(facts.incomplete).toBe(true);
    expect(facts.limit_reasons).toEqual(expect.arrayContaining(["max_bytes", "max_file_bytes"]));
    expect(facts.matches.every((match) => match.path !== ".env")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("credential");

    const fileCountTool = createDefaultToolRegistry({
      fileToolLimits: {
        maxFileBytes: 32,
        maxFiles: 3,
        maxBytes: 1_000,
        maxDepth: 1,
      },
    }).get("search");
    if (!fileCountTool) throw new Error("search tool is missing");
    const fileCountResult = await fileCountTool.execute({ pattern: "needle" }, {
      projectId: "project:test",
      runId: "run:test",
      workspace,
    });
    expect(fileCountResult.facts).toMatchObject({
      files_scanned: 3,
      incomplete: true,
      limit_reasons: expect.arrayContaining(["max_files"]),
    });
  });

  it("reports maxDepth when a deeper subtree is deliberately not traversed", async () => {
    const root = await temporaryRoot("bounded-depth");
    await mkdir(join(root, "level-1", "level-2"), { recursive: true });
    await writeFile(join(root, "level-1", "level-2", "deep.txt"), "needle\n");
    const workspace = await createReadonlyWorkspaceHandle({ projectId: "project:test", root });
    const tool = createDefaultToolRegistry({
      fileToolLimits: { maxDepth: 1 },
    }).get("search");
    if (!tool) throw new Error("search tool is missing");

    const result = await tool.execute({ pattern: "needle" }, {
      projectId: "project:test",
      runId: "run:test",
      workspace,
    });

    expect(result.facts).toMatchObject({
      matches: [],
      incomplete: true,
      limit_reasons: ["max_depth"],
    });
  });

  it("honors AbortSignal and a deterministic deadline", async () => {
    const root = await temporaryRoot("bounded-cancel");
    await writeFile(join(root, "a.txt"), "needle\n");
    const workspace = await createReadonlyWorkspaceHandle({ projectId: "project:test", root });
    const controller = new AbortController();
    controller.abort(new Error("stop requested"));
    const abortedTool = createDefaultToolRegistry().get("search");
    if (!abortedTool) throw new Error("search tool is missing");

    await expect(abortedTool.execute({ pattern: "needle" }, {
      projectId: "project:test",
      runId: "run:test",
      workspace,
      signal: controller.signal,
    })).resolves.toMatchObject({ status: "failure", code: "tool_aborted" });

    let tick = 0;
    const deadlineTool = createDefaultToolRegistry({
      fileToolLimits: { deadlineMs: 1 },
      nowMs: () => tick++ * 2,
    }).get("search");
    if (!deadlineTool) throw new Error("search tool is missing");
    const deadlineResult = await deadlineTool.execute({ pattern: "needle" }, {
      projectId: "project:test",
      runId: "run:test",
      workspace,
    });
    expect(deadlineResult.facts).toMatchObject({
      files_scanned: 0,
      incomplete: true,
      limit_reasons: ["deadline"],
    });

    let readTick = 0;
    const deadlineRead = createDefaultToolRegistry({
      fileToolLimits: { deadlineMs: 1 },
      nowMs: () => readTick++ * 2,
    }).get("read_file");
    if (!deadlineRead) throw new Error("read_file tool is missing");
    await expect(deadlineRead.execute({ path: "a.txt" }, {
      projectId: "project:test",
      runId: "run:test",
      workspace,
    })).resolves.toMatchObject({ status: "failure", code: "read_deadline_exceeded" });
  });
});

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-${name}-`));
  roots.push(root);
  return root;
}

function artifactRef(
  artifactId: string,
  projectId: string,
  runId: string,
  createdAt: string,
) {
  return {
    artifact_id: artifactId,
    kind: "tool_output" as const,
    content_hash: `sha256:${"a".repeat(64)}`,
    mime_type: "text/plain",
    byte_length: 123,
    project_id: projectId,
    run_id: runId,
    created_at: createdAt,
  };
}

const TEAM_NOW = "2026-09-20T00:00:00.000Z";

function maximumEscapedIdentifier(prefix: string, index: number): string {
  return `${prefix}:${index.toString().padStart(4, "0")}${"\0".repeat(160)}`.slice(0, 160);
}

function maximumEscapedText(prefix: string, index: number, length: number): string {
  return `${prefix}:${index.toString().padStart(4, "0")}${"\0".repeat(length)}`.slice(0, length);
}

function teamMember(subagentId: string) {
  return {
    link: {
      subagent_id: subagentId,
      parent_run_id: "run:team-root",
      parent_session_id: "session:team-root",
      child_run_id: "run:team-worker",
      child_session_id: "session:team-worker",
    },
    role: "worker",
    status: "active" as const,
    joined_at: TEAM_NOW,
    last_heartbeat_at: TEAM_NOW,
  };
}

function teamProjection(input: {
  lastSequence: number;
  mailbox?: unknown[];
  tasks?: unknown[];
}): TeamProjection {
  const workerId = maximumEscapedIdentifier("worker", 0);
  return TeamProjectionSchema.parse({
    team_id: maximumEscapedIdentifier("team", 0),
    coordinator_run_id: maximumEscapedIdentifier("coordinator-run", 0),
    limits: {
      max_parallel_workers: 1,
      heartbeat_timeout_ms: 30_000,
      max_members: 500,
      max_mailbox_messages: 2_000,
      max_tasks: 500,
    },
    created_event_id: maximumEscapedIdentifier("created-event", 0),
    created_at: TEAM_NOW,
    roster: {
      members: [teamMember(workerId)],
      last_sequence: input.lastSequence,
    },
    mailbox: {
      messages: input.mailbox ?? [],
      last_sequence: input.lastSequence,
    },
    task_board: {
      items: input.tasks ?? [],
      last_sequence: input.lastSequence,
    },
    last_sequence: input.lastSequence,
  });
}

function maximumTaskTeam(): TeamProjection {
  const workerId = maximumEscapedIdentifier("worker", 0);
  return teamProjection({
    lastSequence: 999,
    tasks: [{
      task_id: maximumEscapedIdentifier("task", 0),
      title: "\0".repeat(500),
      detail: "\0".repeat(4_000),
      state: "done",
      owner: workerId,
      acceptance: Array.from({ length: 32 }, (_, index) => (
        maximumEscapedText("acceptance", index, 1_000)
      )),
      evidence_event_ids: Array.from({ length: 256 }, (_, index) => (
        maximumEscapedIdentifier("evidence", index)
      )),
      version: Number.MAX_SAFE_INTEGER,
      created_at: TEAM_NOW,
      updated_at: TEAM_NOW,
    }],
  });
}

function mailboxTeam(messageCount: number, lastSequence: number): TeamProjection {
  const workerId = maximumEscapedIdentifier("worker", 0);
  return teamProjection({
    lastSequence,
    mailbox: Array.from({ length: messageCount }, (_, index) => ({
      message_id: maximumEscapedIdentifier("message", index),
      from: "coordinator",
      to: workerId,
      kind: "question",
      payload: maximumEscapedText("payload", index, 8_000),
      delivered_at: TEAM_NOW,
    })),
  });
}

function teamToolContext(
  team: TeamProjection,
  mutation: TeamMutationResult = {
    command_id: "command:team:test",
    disposition: "noop",
    event_ids: [],
    team,
  },
): ToolExecutionContext {
  return {
    projectId: "project:team-tools",
    runId: "run:team-root",
    workspace: teamWorkspace(),
    team: {
      async read() { return { team }; },
      async writeTask() { return mutation; },
      async sendMailbox() { return mutation; },
      async claimMailbox() { return mutation; },
      async heartbeat() { return mutation; },
    },
  };
}

function teamWorkspace(): WorkspaceHandle {
  return {
    handle_id: "workspace:team-tools",
    project_id: "project:team-tools",
    real_root: "/tmp/tracegraph-team-tools",
    workspace_kind: "readonly_local",
    capabilities: {
      index: true,
      read: true,
      search: true,
      run_command: false,
      preview_patch: false,
      commit_patch: false,
      test: false,
    },
    created_at: TEAM_NOW,
  };
}
