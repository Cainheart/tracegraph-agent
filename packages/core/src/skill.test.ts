import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceHandleSchema, type RunProjection, type WorkspaceHandle } from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_BUILTIN_PERMISSION_PRESETS, createEffectivePermissionPolicy } from "./policy-engine.js";
import { SkillRegistry } from "./skill.js";
import { createAgentRuntime } from "./runtime.js";
import type { ModelAdapter, ModelInput } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("G10 Skill registry", () => {
  it("skips invalid frontmatter, keeps project precedence, and records diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-skill-"));
    roots.push(root);
    const projectSkills = join(root, "project", ".tracegraph", "skills");
    const userSkills = join(root, "user");
    await mkdir(join(projectSkills, "review"), { recursive: true });
    await mkdir(join(projectSkills, "broken"), { recursive: true });
    await mkdir(join(userSkills, "review"), { recursive: true });
    await writeFile(join(projectSkills, "review", "SKILL.md"), [
      "---",
      "name: review",
      "description: Project review",
      "version: 2.0.0",
      "allowed_tools: [read_file]",
      "---",
      "Project instructions",
      "",
    ].join("\n"));
    await writeFile(join(userSkills, "review", "SKILL.md"), [
      "---",
      "name: review",
      "description: User review",
      "version: 1.0.0",
      "allowed_tools: [search]",
      "---",
      "User instructions",
      "",
    ].join("\n"));
    await writeFile(join(projectSkills, "broken", "SKILL.md"), "name: broken\n");

    const snapshot = await new SkillRegistry({ userSkillsRoot: userSkills }).scan(join(root, "project"));
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]).toMatchObject({ name: "review", description: "Project review", source: "project" });
    expect(snapshot.conflicts).toMatchObject([{ name: "review", winner: "project", loser: "user" }]);
    expect(snapshot.diagnostics).toMatchObject([{ code: "missing_frontmatter", source: "project" }]);
  });

  it("progressively discloses only catalog metadata, then loads bounded body and narrows tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-skill-runtime-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userRoot = join(root, "user");
    const dataDir = join(root, "data");
    await mkdir(join(projectRoot, ".tracegraph", "skills", "review"), { recursive: true });
    await mkdir(userRoot, { recursive: true });
    await writeFile(join(projectRoot, ".tracegraph", "skills", "review", "SKILL.md"), [
      "---",
      "name: review",
      "description: Review changed files",
      "version: 1.0.0",
      "allowed_tools: [read_file, commit_patch]",
      "---",
      "Use the review checklist before answering.",
      "",
    ].join("\n"));
    const workspace = fixtureWorkspace(projectRoot);
    const seen: ModelInput[] = [];
    let turn = 0;
    const model: ModelAdapter = {
      name: "skill-test-model",
      async decide(input) {
        seen.push(input);
        turn += 1;
        if (turn === 1) {
          return toolDecision("decision:load-skill", "action:load-skill", "load_skill", { name: "review" });
        }
        return {
          decision_id: "decision:finish",
          kind: "finish",
          public_reason: "Skill body was disclosed",
          evidence_refs: [],
          risk: "none",
          final_answer: "done",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir,
      model,
      skillRegistry: new SkillRegistry({ userSkillsRoot: userRoot }),
      permissionPolicy: createEffectivePermissionPolicy({ preset: CORE_BUILTIN_PERMISSION_PRESETS["read-only"] }),
    });
    const started = await runtime.startRun({
      command_id: "command:skill-runtime",
      project_id: workspace.project_id,
      task: "Review this project",
      mode: "execute",
      workspace,
    });
    const completed = await waitForStatus(runtime, started.run_id, "completed");
    expect(seen[0]?.context).toContain("review");
    expect(seen[0]?.context).toContain("Review changed files");
    expect(seen[0]?.context).not.toContain("Use the review checklist");
    expect(seen[1]?.context).toContain("Use the review checklist before answering.");
    expect(seen[1]?.toolSchemas.some((tool) => tool.name === "commit_patch")).toBe(false);
    expect(completed.timeline.some((event) => event.type === "skill.registry_loaded")).toBe(true);
    expect(completed.timeline.some((event) => event.type === "tool.completed" && event.data.receipt && (event.data.receipt as { tool_name?: string }).tool_name === "load_skill")).toBe(true);
    expect(completed.timeline.some((event) => event.type === "skill.load_failed")).toBe(false);
  });

  it("rejects a forged tool call outside the active Skill allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-skill-deny-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    await mkdir(join(projectRoot, ".tracegraph", "skills", "review"), { recursive: true });
    await writeFile(join(projectRoot, ".tracegraph", "skills", "review", "SKILL.md"), [
      "---", "name: review", "description: Read only", "version: 1.0.0", "allowed_tools: [read_file]", "---", "Read only body", "",
    ].join("\n"));
    const workspace = fixtureWorkspace(projectRoot);
    let turn = 0;
    const model: ModelAdapter = {
      name: "skill-deny-model",
      async decide() {
        turn += 1;
        return turn === 1
          ? toolDecision("decision:load", "action:load", "load_skill", { name: "review" })
          : toolDecision("decision:forged", "action:forged", "search", { pattern: "secret" });
      },
    };
    const runtime = await createAgentRuntime({ dataDir: join(root, "data"), model, skillRegistry: new SkillRegistry({ userSkillsRoot: join(root, "user") }) });
    const started = await runtime.startRun({ command_id: "command:skill-deny", project_id: workspace.project_id, task: "Read", mode: "execute", workspace });
    const failed = await waitForStatus(runtime, started.run_id, "failed");
    expect(failed.failure_code).toBe("skill_tool_denied");
    expect(failed.timeline.find((event) => event.type === "policy.denied")?.data).toMatchObject({ code: "skill_tool_denied", reason: "skill_tool_allowlist" });
    expect(failed.timeline.some((event) => event.type === "tool.started" && event.data.tool_name === "search")).toBe(false);
  });
});

function fixtureWorkspace(root: string): WorkspaceHandle {
  return WorkspaceHandleSchema.parse({
    handle_id: `workspace:${root}`,
    project_id: "project:skill-test",
    created_at: new Date(0).toISOString(),
    real_root: root,
    workspace_kind: "disposable_fixture",
    capabilities: {
      index: false,
      read: true,
      search: true,
      run_command: false,
      preview_patch: false,
      commit_patch: false,
      test: false,
    },
  });
}

function toolDecision(decisionId: string, actionId: string, toolName: string, arguments_: Record<string, unknown>) {
  return {
    decision_id: decisionId,
    kind: "tool_call" as const,
    public_reason: "Use the requested Skill boundary",
    evidence_refs: [],
    risk: "low" as const,
    tool_call: { action_id: actionId, tool_name: toolName, arguments: arguments_ },
  };
}

async function waitForStatus(
  runtime: { getProjection(runId: string): Promise<RunProjection> },
  runId: string,
  status: RunProjection["status"],
): Promise<RunProjection> {
  for (let index = 0; index < 200; index += 1) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === status) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run did not reach ${status}`);
}
