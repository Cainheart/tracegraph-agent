import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
  type ToolName,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { sha256 } from "./crypto.js";
import { JsonlEventLedger } from "./event-ledger.js";
import { createAgentRuntime } from "./runtime.js";
import { SubagentRegistry } from "./subagent.js";
import type { ModelAdapter } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("G-08 Runtime team integration", () => {
  it("archives an exact team_read page and refetches it through read_artifact", async () => {
    const harness = await createHarness();
    const rootEntered = deferred<void>();
    const releaseRead = deferred<void>();
    let turn = 0;
    let locator: string | undefined;
    let exactPage: string | undefined;
    let contentHash: string | undefined;
    const refetchedChunks: string[] = [];
    const acceptance = Array.from(
      { length: 8 },
      (_, index) => `Acceptance ${index + 1}: ${String.fromCharCode(65 + index).repeat(900)}`,
    );
    const rootModel: ModelAdapter = {
      name: "team-page-refetch-root",
      async decide(input) {
        turn += 1;
        if (turn === 1) {
          rootEntered.resolve();
          await releaseRead.promise;
          return toolDecision("decision:team-page", "action:team-page", "team_read", {
            section: "task_board",
            offset: 0,
            limit: 1,
          });
        }
        if (turn === 2) {
          const observation = input.observations.find(({ facts }) => facts.tool_name === "team_read");
          locator = typeof observation?.facts.locator === "string" ? observation.facts.locator : undefined;
          exactPage = typeof observation?.facts.content_excerpt === "string"
            ? observation.facts.content_excerpt
            : undefined;
          expect(locator).toMatch(/^artifact:/u);
          expect(exactPage).toContain('"task_id": "task:page-refetch"');
          return toolDecision("decision:team-page-refetch", "action:team-page-refetch", "read_artifact", {
            locator: locator!,
            offset: 0,
            limit: 4_000,
          });
        }
        const refetched = [...input.observations].reverse()
          .find(({ facts }) => facts.tool_name === "read_artifact");
        expect(refetched?.facts.locator).toBe(locator);
        expect(typeof refetched?.facts.content_excerpt).toBe("string");
        refetchedChunks.push(refetched!.facts.content_excerpt as string);
        contentHash = typeof refetched?.facts.content_hash === "string"
          ? refetched.facts.content_hash
          : contentHash;
        if (refetched?.facts.truncated === true) {
          expect(typeof refetched.facts.next_offset).toBe("number");
          return toolDecision(
            `decision:team-page-refetch:${turn}`,
            `action:team-page-refetch:${turn}`,
            "read_artifact",
            { locator: locator!, offset: refetched.facts.next_offset, limit: 4_000 },
          );
        }
        exactPage = refetchedChunks.join("");
        const parsedPage = JSON.parse(exactPage) as { items?: Array<{ acceptance?: string[]; detail?: string }> };
        expect(parsedPage).toMatchObject({
          section: "task_board",
          items: [{ task_id: "task:page-refetch" }],
        });
        expect(parsedPage.items?.[0]?.detail).toBe("D".repeat(4_000));
        expect(parsedPage.items?.[0]?.acceptance).toEqual(acceptance);
        return finishDecision("decision:team-page-refetch-done", "Exact Team page was refetched.");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      idFactory: sequentialIdFactory(),
    });
    const started = await runtime.startRun({
      command_id: "command:start:team-page-refetch",
      project_id: harness.workspace.project_id,
      task: "Read and refetch one exact Team task page.",
      mode: "execute",
      workspace: harness.workspace,
    });
    await rootEntered.promise;
    await runtime.createTeam(started.run_id, started.project_id, {
      command_id: "command:create:team-page-refetch",
    });
    await runtime.writeTeamTask(started.run_id, started.project_id, {
      command_id: "command:task:team-page-refetch",
      input: {
        operation: "create",
        task_id: "task:page-refetch",
        title: "Refetch this exact paged task",
        detail: "D".repeat(4_000),
        acceptance,
      },
    });
    releaseRead.resolve();

    const completed = await waitForTerminal(runtime, started.run_id);
    expect(completed.status).toBe("completed");
    const pageEvent = completed.timeline.find((event) => (
      event.type === "tool.completed" && event.data.receipt
        && (event.data.receipt as { tool_name?: unknown }).tool_name === "team_read"
    ));
    expect(pageEvent?.artifact_refs).toEqual([
      expect.objectContaining({ kind: "spilled_tool_output" }),
    ]);
    const pageArtifact = pageEvent?.artifact_refs[0];
    const receipt = pageEvent?.data.receipt as { artifact_refs?: Array<{ artifact_id?: string }> } | undefined;
    const observation = pageEvent?.data.observation as { artifact_refs?: Array<{ artifact_id?: string }> } | undefined;
    expect(receipt?.artifact_refs?.[0]?.artifact_id).toBe(pageArtifact?.artifact_id);
    expect(observation?.artifact_refs?.[0]?.artifact_id).toBe(pageArtifact?.artifact_id);
    expect(contentHash).toBe(pageArtifact?.content_hash);
    expect(exactPage === undefined ? undefined : sha256(exactPage)).toBe(pageArtifact?.content_hash);
    if (pageArtifact === undefined || exactPage === undefined) throw new Error("Team page artifact was unavailable");
    const artifactStore = new ArtifactStore(join(harness.dataDir, "artifacts"));
    const stored = await artifactStore.getInternal({
      artifactId: pageArtifact.artifact_id,
      projectId: started.project_id,
      runId: started.run_id,
    });
    expect(stored).toMatchObject({ status: "available", content: exactPage });
    const refetchEvents = completed.timeline.filter(({ type }) => type === "context.spill_refetched");
    expect(refetchEvents.length).toBeGreaterThan(2);
    expect(refetchEvents.every((event) => (
      event.data.locator === locator && event.data.content_hash === pageArtifact.content_hash
    ))).toBe(true);
  }, 15_000);

  it("binds child Tools to its canonical member identity and retires the worker before root terminal", async () => {
    const harness = await createHarness();
    const rootMayDelegate = deferred<void>();
    const rootEntered = deferred<void>();
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "team-root",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          rootEntered.resolve();
          await rootMayDelegate.promise;
          return toolDecision("decision:root:spawn", "action:root:spawn", "spawn_subagent", {
            profile_name: "team-worker",
            task_packet: { task: "Claim the shared task and report through the mailbox." },
            context_scope: "isolated",
          });
        }
        return finishDecision("decision:root:done", "Team worker reached a durable terminal state.");
      },
    };
    const childTurns = new Map<string, number>();
    let childEvidenceEventId: string | undefined;
    const childModel: ModelAdapter = {
      name: "team-worker",
      async decide(input) {
        const turn = childTurns.get(input.runId) ?? 0;
        childTurns.set(input.runId, turn + 1);
        if (turn === 0) {
          expect(input.toolSchemas.map(({ name }) => name)).toEqual(expect.arrayContaining([
            "team_read",
            "team_task_write",
            "team_mailbox_send",
            "team_mailbox_claim",
            "team_heartbeat",
          ]));
          return toolDecision("decision:child:read", "action:child:read", "read_file", {
            path: "README.md",
          });
        }
        if (turn === 1) {
          childEvidenceEventId = input.observations
            .map(({ facts }) => facts.evidence_event_id)
            .find((value): value is string => typeof value === "string");
          expect(childEvidenceEventId).toBeDefined();
          return toolDecision("decision:child:claim", "action:child:claim", "team_task_write", {
            operation: "claim",
            task_id: "task:shared",
            expected_version: 1,
          });
        }
        if (turn === 2) {
          return toolDecision("decision:child:complete", "action:child:complete", "team_task_write", {
            operation: "complete",
            task_id: "task:shared",
            expected_version: 2,
            evidence_event_ids: [childEvidenceEventId!],
          });
        }
        if (turn === 3) {
          return toolDecision("decision:child:mail", "action:child:mail", "team_mailbox_send", {
            to: "coordinator",
            kind: "answer",
            payload: "The shared task was claimed by my derived member identity.",
          });
        }
        return finishDecision("decision:child:done", "Worker finished its bounded assignment.");
      },
    };
    const teamTools: ToolName[] = [
      "read_file",
      "team_read",
      "team_task_write",
      "team_mailbox_send",
      "team_mailbox_claim",
      "team_heartbeat",
    ];
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      subagentRegistry: new SubagentRegistry([{
        name: "team-worker",
        providerKey: "provider:team-worker",
        rolePromptVersion: "team-worker.v1",
        rolePrompt: "Operate only as the canonical joined team member.",
        toolAllowlist: teamTools,
        defaultBudget: { max_steps: 8, max_tokens: 10_000 },
        budgetCeiling: { max_steps: 8, max_tokens: 10_000 },
        model: childModel,
      }]),
      maxParallelSubagents: 2,
      maxSubagentDepth: 1,
      idFactory: sequentialIdFactory(),
    });

    const started = await runtime.startRun({
      command_id: "command:start:team-runtime",
      project_id: harness.workspace.project_id,
      task: "Coordinate one worker through a shared team board.",
      mode: "execute",
      workspace: harness.workspace,
    });
    await rootEntered.promise;
    await runtime.createTeam(started.run_id, started.project_id, { command_id: "command:team:create" });
    await runtime.writeTeamTask(started.run_id, started.project_id, {
      command_id: "command:team:task:create",
      input: {
        operation: "create",
        task_id: "task:shared",
        title: "Shared child assignment",
        acceptance: ["Worker claims with canonical identity"],
      },
    });
    rootMayDelegate.resolve();

    const completed = await waitForTerminal(runtime, started.run_id);
    expect(completed.status).toBe("completed");
    expect(completed.team?.roster.members).toHaveLength(1);
    expect(completed.team?.roster.members[0]).toMatchObject({ status: "lost" });
    expect(completed.team?.task_board.items[0]).toMatchObject({
      task_id: "task:shared",
      state: "done",
      owner: completed.subagents.items[0]?.link.subagent_id,
      version: 3,
      evidence_event_ids: [childEvidenceEventId],
    });
    const subagentId = completed.subagents.items[0]?.link.subagent_id;
    expect(completed.team?.mailbox.messages[0]).toMatchObject({
      from: subagentId,
      to: "coordinator",
      kind: "answer",
    });
    expect(completed.timeline.map(({ type }) => type)).toEqual(expect.arrayContaining([
      "team.created",
      "team.member_joined",
      "team.task_claimed",
      "team.mailbox_delivered",
      "subagent.completed",
      "team.member_lost",
      "run.completed",
    ]));
    const memberLostIndex = completed.timeline.findIndex(({ type }) => type === "team.member_lost");
    const rootTerminalIndex = completed.timeline.findIndex(({ type }) => type === "run.completed");
    expect(memberLostIndex).toBeGreaterThan(-1);
    expect(memberLostIndex).toBeLessThan(rootTerminalIndex);
    expect(completed.timeline[memberLostIndex]?.data).toMatchObject({
      reason: "worker_terminal",
      reopened_task_ids: [],
    });
    expect(completed.timeline.filter(({ type }) => type === "team.task_completed")).toHaveLength(1);
    const childProjection = await runtime.getProjection(completed.subagents.items[0]!.link.child_run_id);
    const childEvidence = childProjection.timeline.find(({ event_id: eventId }) => eventId === childEvidenceEventId);
    const completionAction = childProjection.timeline.find((event) => (
      event.type === "tool.started" && event.action_id === "action:child:complete"
    ));
    expect(childEvidence).toBeDefined();
    expect(completionAction).toBeDefined();
    expect(childEvidence!.sequence).toBeLessThan(completionAction!.sequence);
  }, 15_000);

  it("rejects forged and another member's child-ledger evidence at the trusted Runtime boundary", async () => {
    const harness = await createHarness();
    const rootMayDelegate = deferred<void>();
    const rootEntered = deferred<void>();
    const childrenReady = deferred<void>();
    const releaseChildren = deferred<void>();
    const childEvidence = new Map<string, string>();
    const childTasks = new Map<string, string>();
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "team-evidence-root",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          rootEntered.resolve();
          await rootMayDelegate.promise;
          return batchDecision("decision:root:spawn-two", [{
            action_id: "action:root:spawn:a",
            tool_name: "spawn_subagent",
            arguments: {
              profile_name: "team-worker",
              task_packet: { task: "worker-a" },
              context_scope: "isolated",
            },
          }, {
            action_id: "action:root:spawn:b",
            tool_name: "spawn_subagent",
            arguments: {
              profile_name: "team-worker",
              task_packet: { task: "worker-b" },
              context_scope: "isolated",
            },
          }]);
        }
        return finishDecision("decision:root:evidence-done", "Evidence ownership checked.");
      },
    };
    const childTurns = new Map<string, number>();
    const childModel: ModelAdapter = {
      name: "team-evidence-worker",
      async decide(input) {
        const turn = childTurns.get(input.runId) ?? 0;
        childTurns.set(input.runId, turn + 1);
        childTasks.set(input.runId, input.task);
        if (turn === 0) {
          return toolDecision(
            `decision:child:read:${input.runId}`,
            `action:child:read:${input.runId}`,
            "read_file",
            { path: "README.md" },
          );
        }
        if (turn === 1) {
          return toolDecision(
            `decision:child:team-read:${input.runId}`,
            `action:child:team-read:${input.runId}`,
            "team_read",
            {},
          );
        }
        const evidenceEventId = input.observations
          .map(({ facts }) => facts.evidence_event_id)
          .find((value): value is string => typeof value === "string");
        expect(evidenceEventId).toBeDefined();
        childEvidence.set(input.runId, evidenceEventId!);
        if (childEvidence.size === 2) childrenReady.resolve();
        await releaseChildren.promise;
        return finishDecision(`decision:child:done:${input.runId}`, `${input.task} done.`);
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      subagentRegistry: new SubagentRegistry([{
        name: "team-worker",
        providerKey: "provider:team-evidence-worker",
        rolePromptVersion: "team-evidence-worker.v1",
        rolePrompt: "Produce independently attributable evidence.",
        toolAllowlist: ["read_file", "team_read"],
        defaultBudget: { max_steps: 4, max_tokens: 10_000 },
        budgetCeiling: { max_steps: 4, max_tokens: 10_000 },
        model: childModel,
      }]),
      maxParallelSubagents: 2,
      maxSubagentDepth: 1,
      idFactory: sequentialIdFactory(),
    });

    const started = await runtime.startRun({
      command_id: "command:start:team-evidence-runtime",
      project_id: harness.workspace.project_id,
      task: "Verify evidence stays bound to its worker ledger.",
      mode: "execute",
      workspace: harness.workspace,
    });
    await rootEntered.promise;
    await runtime.createTeam(started.run_id, started.project_id, {
      command_id: "command:team:evidence:create",
    });
    await runtime.writeTeamTask(started.run_id, started.project_id, {
      command_id: "command:team:evidence:task",
      input: {
        operation: "create",
        task_id: "task:evidence",
        title: "Prove evidence provenance",
        acceptance: ["Only the owner child ledger is accepted"],
      },
    });
    rootMayDelegate.resolve();
    await childrenReady.promise;

    const running = await runtime.getProjection(started.run_id);
    const childA = running.subagents.items.find(({ link }) => childTasks.get(link.child_run_id) === "worker-a")!;
    const childB = running.subagents.items.find(({ link }) => childTasks.get(link.child_run_id) === "worker-b")!;
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();
    const childAEvidence = await toolEvidenceEventId(runtime, childA.link.child_run_id, "read_file");
    const childBEvidence = await toolEvidenceEventId(runtime, childB.link.child_run_id, "read_file");
    const childAControlEvidence = await toolEvidenceEventId(runtime, childA.link.child_run_id, "team_read");
    await runtime.writeTeamTaskAsMember(started.run_id, started.project_id, childA.link.subagent_id, {
      command_id: "command:team:evidence:claim",
      input: { operation: "claim", task_id: "task:evidence", expected_version: 1 },
    });
    await expect(runtime.writeTeamTaskAsMember(
      started.run_id,
      started.project_id,
      childA.link.subagent_id,
      {
        command_id: "command:team:evidence:forged",
        input: {
          operation: "complete",
          task_id: "task:evidence",
          expected_version: 2,
          evidence_event_ids: ["event:forged"],
        },
      },
    )).rejects.toMatchObject({ code: "task_evidence_invalid" });
    await expect(runtime.writeTeamTaskAsMember(
      started.run_id,
      started.project_id,
      childA.link.subagent_id,
      {
        command_id: "command:team:evidence:other-child",
        input: {
          operation: "complete",
          task_id: "task:evidence",
          expected_version: 2,
          evidence_event_ids: [childBEvidence],
        },
      },
    )).rejects.toMatchObject({ code: "task_evidence_invalid" });
    await expect(runtime.writeTeamTaskAsMember(
      started.run_id,
      started.project_id,
      childA.link.subagent_id,
      {
        command_id: "command:team:evidence:team-control",
        input: {
          operation: "complete",
          task_id: "task:evidence",
          expected_version: 2,
          evidence_event_ids: [childAControlEvidence],
        },
      },
    )).rejects.toMatchObject({ code: "task_evidence_invalid" });
    const childLedger = new JsonlEventLedger(join(harness.dataDir, "events"));
    await childLedger.initialize();
    const bulkEvidence = [];
    for (let index = 0; index < 100; index += 1) {
      bulkEvidence.push(await childLedger.append({
        type: "action.verified",
        project_id: started.project_id,
        run_id: childA.link.child_run_id,
        session_id: childA.link.child_session_id,
        attempt: 0,
        summary: `Independent evidence ${index}`,
        artifact_refs: [],
        data: { action_id: `action:bulk-evidence:${index}` },
      }));
    }
    const acceptedEvidenceIds = [childAEvidence, ...bulkEvidence.map(({ event_id: eventId }) => eventId)];
    const accepted = await runtime.writeTeamTaskAsMember(
      started.run_id,
      started.project_id,
      childA.link.subagent_id,
      {
        command_id: "command:team:evidence:owner-child",
        input: {
          operation: "complete",
          task_id: "task:evidence",
          expected_version: 2,
          evidence_event_ids: acceptedEvidenceIds,
        },
      },
    );
    expect(accepted.team.task_board.items[0]).toMatchObject({
      state: "done",
      owner: childA.link.subagent_id,
      evidence_event_ids: acceptedEvidenceIds,
    });
    const completionEvent = (await childLedger.list(started.run_id)).find(
      ({ type }) => type === "team.task_completed",
    );
    expect((completionEvent?.data.task as { evidence_event_ids?: unknown[] }).evidence_event_ids)
      .toHaveLength(101);

    releaseChildren.resolve();
    const completed = await waitForTerminal(runtime, started.run_id);
    expect(completed.status).toBe("completed");
    expect(completed.timeline.filter(({ type }) => type === "team.task_completed")).toHaveLength(1);
  }, 15_000);

  it("backfills a running direct child when the team is created after subagent.started", async () => {
    const harness = await createHarness();
    let nowMs = Date.parse("2026-09-20T00:00:00.000Z");
    const childEntered = deferred<void>();
    const releaseChild = deferred<void>();
    const childModel: ModelAdapter = {
      name: "late-team-worker",
      async decide() {
        childEntered.resolve();
        await releaseChild.promise;
        return finishDecision("decision:late-team-child", "Late-created team observed.");
      },
    };
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "late-team-root",
      async decide() {
        rootCalls += 1;
        return rootCalls === 1
          ? toolDecision("decision:late-team-spawn", "action:late-team-spawn", "spawn_subagent", {
            profile_name: "team-worker",
            task_packet: { task: "Remain active while the team is created." },
            context_scope: "isolated",
          })
          : finishDecision("decision:late-team-root-done", "Late team backfill completed.");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      subagentRegistry: new SubagentRegistry([{
        name: "team-worker",
        providerKey: "provider:late-team-worker",
        rolePromptVersion: "late-team-worker.v1",
        rolePrompt: "Wait for a late Team creation.",
        toolAllowlist: ["read_file"],
        defaultBudget: { max_steps: 2, max_tokens: 2_000 },
        budgetCeiling: { max_steps: 2, max_tokens: 2_000 },
        model: childModel,
      }]),
      maxParallelSubagents: 1,
      maxSubagentDepth: 1,
      now: () => new Date(nowMs),
      idFactory: sequentialIdFactory(),
    });
    const started = await runtime.startRun({
      command_id: "command:start:late-team",
      project_id: harness.workspace.project_id,
      task: "Create the team after delegation starts.",
      mode: "execute",
      workspace: harness.workspace,
    });
    await childEntered.promise;
    expect((await runtime.getProjection(started.run_id)).team).toBeUndefined();

    const created = await runtime.createTeam(started.run_id, started.project_id, {
      command_id: "command:create:late-team",
    });
    const retriedCreate = await runtime.createTeam(started.run_id, started.project_id, {
      command_id: "command:create:late-team",
    });
    expect(created).toMatchObject({ disposition: "applied" });
    expect(created.event_ids).toHaveLength(2);
    expect(retriedCreate).toMatchObject({ disposition: "duplicate", event_ids: created.event_ids });
    expect(created.team.roster.members).toHaveLength(1);
    expect(created.team.roster.members[0]).toMatchObject({ status: "active" });
    expect((await runtime.getProjection(started.run_id)).timeline.filter(
      ({ type }) => type === "team.member_joined",
    )).toHaveLength(1);

    nowMs += 30_001;
    const swept = await runtime.expireTeamMembers(started.run_id, started.project_id, {
      command_id: "command:sweep:late-team",
    });
    const retriedSweep = await runtime.expireTeamMembers(started.run_id, started.project_id, {
      command_id: "command:sweep:late-team",
    });
    expect(swept.disposition).toBe("applied");
    expect(swept.event_ids).toHaveLength(2);
    expect(retriedSweep).toMatchObject({ disposition: "duplicate", event_ids: swept.event_ids });

    releaseChild.resolve();
    const completed = await waitForTerminal(runtime, started.run_id);
    expect(completed.team?.roster.members[0]).toMatchObject({ status: "lost" });
  }, 15_000);

  it("returns command-exact mutation receipts under concurrent writes and retries", async () => {
    const harness = await createHarness();
    const rootEntered = deferred<void>();
    const releaseRoot = deferred<void>();
    const rootModel: ModelAdapter = {
      name: "team-receipt-root",
      async decide() {
        rootEntered.resolve();
        await releaseRoot.promise;
        return finishDecision("decision:team-receipts", "Concurrent receipts verified.");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      idFactory: sequentialIdFactory(),
    });
    const started = await runtime.startRun({
      command_id: "command:start:team-receipts",
      project_id: harness.workspace.project_id,
      task: "Verify exact Team mutation receipts.",
      mode: "execute",
      workspace: harness.workspace,
    });
    await rootEntered.promise;
    await runtime.createTeam(started.run_id, started.project_id, {
      command_id: "command:create:team-receipts",
    });
    await expect(runtime.writeTeamTask(started.run_id, started.project_id, {
      command_id: "team-tool:caller-forged",
      input: {
        operation: "create",
        task_id: "task:reserved-runtime-command",
        title: "External callers cannot use internal Team command ids",
        acceptance: ["Rejected before append"],
      },
    })).rejects.toMatchObject({ code: "command_id_reserved" });
    const emptySweep = await runtime.expireTeamMembers(started.run_id, started.project_id, {
      command_id: "command:sweep:empty",
    });
    const emptySweepRetry = await runtime.expireTeamMembers(started.run_id, started.project_id, {
      command_id: "command:sweep:empty",
    });
    expect(emptySweep).toMatchObject({ disposition: "applied", event_ids: [expect.any(String)] });
    expect(emptySweepRetry).toMatchObject({
      disposition: "duplicate",
      event_ids: emptySweep.event_ids,
    });
    await expect(runtime.writeTeamTask(started.run_id, started.project_id, {
      command_id: "command:sweep:empty",
      input: {
        operation: "create",
        task_id: "task:must-conflict",
        title: "Top-level command namespace collision",
        acceptance: ["Rejected"],
      },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const createRequest = (suffix: string) => ({
      command_id: `command:task:${suffix}`,
      input: {
        operation: "create" as const,
        task_id: `task:${suffix}`,
        title: `Task ${suffix}`,
        acceptance: [`Task ${suffix} is durable`],
      },
    });
    const [left, right] = await Promise.all([
      runtime.writeTeamTask(started.run_id, started.project_id, createRequest("left")),
      runtime.writeTeamTask(started.run_id, started.project_id, createRequest("right")),
    ]);
    expect(left).toMatchObject({ disposition: "applied", event_ids: [expect.any(String)] });
    expect(right).toMatchObject({ disposition: "applied", event_ids: [expect.any(String)] });
    expect(left.event_ids).not.toEqual(right.event_ids);

    const retryRequest = createRequest("retry");
    const retries = await Promise.all([
      runtime.writeTeamTask(started.run_id, started.project_id, retryRequest),
      runtime.writeTeamTask(started.run_id, started.project_id, retryRequest),
    ]);
    expect(retries.map(({ disposition }) => disposition).sort()).toEqual(["applied", "duplicate"]);
    expect(retries[0]!.event_ids).toEqual(retries[1]!.event_ids);
    expect(retries[0]!.event_ids).toHaveLength(1);

    const projection = await runtime.getProjection(started.run_id);
    for (const result of [left, right, ...retries]) {
      for (const eventId of result.event_ids) {
        const event = projection.timeline.find(({ event_id: candidate }) => candidate === eventId);
        expect(event?.operation_id).toBe(result.command_id);
      }
    }
    releaseRoot.resolve();
    expect((await waitForTerminal(runtime, started.run_id)).status).toBe("completed");
  }, 15_000);
});

async function createHarness(): Promise<{ dataDir: string; workspace: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-runtime-team-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "team fixture\n");
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: "workspace:team-runtime",
      project_id: "project:team-runtime",
      real_root: await realpath(workspaceRoot),
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-09-20T00:00:00.000Z",
    }),
  };
}

function toolDecision(
  decisionId: string,
  actionId: string,
  toolName: ToolName,
  arguments_: Record<string, unknown>,
) {
  return {
    decision_id: decisionId,
    kind: "tool_call" as const,
    public_reason: `Use ${toolName}.`,
    evidence_refs: [],
    risk: "low" as const,
    expected_effect: "Produce a bounded team receipt.",
    tool_call: { action_id: actionId, tool_name: toolName, arguments: arguments_ },
  };
}

function batchDecision(
  decisionId: string,
  toolCalls: Array<{
    action_id: string;
    tool_name: "spawn_subagent";
    arguments: Record<string, unknown>;
  }>,
) {
  return {
    decision_id: decisionId,
    kind: "tool_call" as const,
    public_reason: "Delegate independent bounded tasks.",
    evidence_refs: [],
    risk: "low" as const,
    expected_effect: "Return independently attributable child evidence.",
    tool_calls: toolCalls,
  };
}

function finishDecision(decisionId: string, answer: string) {
  return {
    decision_id: decisionId,
    kind: "finish" as const,
    public_reason: answer,
    evidence_refs: [],
    risk: "none" as const,
    final_answer: answer,
  };
}

function sequentialIdFactory(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}:g08:${String(++sequence).padStart(6, "0")}`;
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value as T) };
}

async function waitForTerminal(
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
  runId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (["completed", "failed", "cancelled"].includes(projection.status)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal team Run");
}

async function toolEvidenceEventId(
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
  runId: string,
  toolName: ToolName,
): Promise<string> {
  const projection = await runtime.getProjection(runId);
  const event = projection.timeline.find((candidate) => (
    candidate.type === "tool.completed"
    && (candidate.data.receipt as { tool_name?: unknown } | undefined)?.tool_name === toolName
  ));
  expect(event).toBeDefined();
  return event!.event_id;
}
