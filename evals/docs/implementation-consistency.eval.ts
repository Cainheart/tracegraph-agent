import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ROADMAP = "docs/12-能力差距对标与补强路线图.md";

const IDENTIFIER_FACTS = [
  {
    identifier: "SCHEMA_VERSION",
    documentation: ["docs/modules/01-契约层-contracts.md", ROADMAP],
    implementation: "packages/contracts/src/common.ts",
  },
  {
    identifier: "PROJECTOR_VERSION",
    documentation: ["docs/modules/01-契约层-contracts.md", ROADMAP],
    implementation: "packages/contracts/src/common.ts",
  },
  {
    identifier: "SESSION_FORMAT_VERSION",
    documentation: ["docs/modules/01-契约层-contracts.md", ROADMAP],
    implementation: "packages/contracts/src/session.ts",
  },
  {
    identifier: "TELEMETRY_STATUS_SCHEMA_VERSION",
    documentation: ["docs/modules/01-契约层-contracts.md"],
    implementation: "packages/contracts/src/telemetry.ts",
  },
  {
    identifier: "EXTENSION_API_VERSION",
    documentation: ["docs/modules/01-契约层-contracts.md", "docs/modules/15-插件与扩展系统.md", ROADMAP],
    implementation: "packages/contracts/src/extension.ts",
  },
  {
    identifier: "EventTypeSchema",
    documentation: ["docs/modules/01-契约层-contracts.md", ROADMAP],
    implementation: "packages/contracts/src/event.ts",
  },
  {
    identifier: "TeamProjectionSchema",
    documentation: ["docs/modules/01-契约层-contracts.md", "docs/modules/16-Agent-Team.md", ROADMAP],
    implementation: "packages/contracts/src/team.ts",
  },
  {
    identifier: "TeamDomainService",
    documentation: ["docs/modules/16-Agent-Team.md", ROADMAP],
    implementation: "packages/core/src/team.ts",
  },
  {
    identifier: "TeamPanel",
    documentation: ["docs/modules/10-Web-工作台.md", "docs/modules/16-Agent-Team.md"],
    implementation: "apps/web/src/components/TeamPanel.tsx",
  },
  {
    identifier: "SkillRegistry",
    documentation: ["docs/modules/17-Skill系统.md", ROADMAP],
    implementation: "packages/core/src/skill.ts",
  },
  {
    identifier: "load_skill",
    documentation: ["docs/modules/17-Skill系统.md", ROADMAP],
    implementation: "packages/core/src/tool-registry.ts",
  },
  {
    identifier: "SkillProjectInspectionSchema",
    documentation: ["docs/modules/17-Skill系统.md"],
    implementation: "packages/contracts/src/skill.ts",
  },
  {
    identifier: "runSkillsCommand",
    documentation: ["docs/modules/17-Skill系统.md", ROADMAP],
    implementation: "apps/cli/src/skill-command.ts",
  },
  {
    identifier: "MCP_CONFIG_VERSION",
    documentation: ["docs/modules/18-MCP客户端.md", ROADMAP],
    implementation: "packages/contracts/src/mcp.ts",
  },
  {
    identifier: "McpManager",
    documentation: ["docs/modules/18-MCP客户端.md", ROADMAP],
    implementation: "packages/core/src/mcp/manager.ts",
  },
  {
    identifier: "createMcpToolsExtension",
    documentation: ["docs/modules/18-MCP客户端.md", ROADMAP],
    implementation: "packages/core/src/mcp/manager.ts",
  },
  {
    identifier: "runMcpCommand",
    documentation: ["docs/modules/11-CLI-与装配.md", "docs/modules/18-MCP客户端.md", ROADMAP],
    implementation: "apps/cli/src/mcp-command.ts",
  },
  {
    identifier: "LSP_CONFIG_VERSION",
    documentation: ["docs/modules/19-LSP客户端.md", ROADMAP],
    implementation: "packages/contracts/src/lsp.ts",
  },
  {
    identifier: "LspManager",
    documentation: ["docs/modules/19-LSP客户端.md", ROADMAP],
    implementation: "packages/core/src/lsp/manager.ts",
  },
  {
    identifier: "createLspToolsExtension",
    documentation: ["docs/modules/19-LSP客户端.md", ROADMAP],
    implementation: "packages/core/src/lsp/manager.ts",
  },
  {
    identifier: "runTeamCommand",
    documentation: ["docs/modules/11-CLI-与装配.md", "docs/modules/16-Agent-Team.md"],
    implementation: "apps/cli/src/team-command.ts",
  },
  {
    identifier: "DeterministicContextBuilder",
    documentation: ["docs/modules/03-Context-与预算压缩.md"],
    implementation: "packages/core/src/context.ts",
  },
  {
    identifier: "AgentRuntime",
    documentation: ["docs/modules/05-证据链-账本投影工件.md"],
    implementation: "packages/core/src/runtime.ts",
  },
  {
    identifier: "analyzeCodeGraph",
    documentation: [
      "docs/modules/07-CodeGraph-代码图.md",
      "docs/modules/11-CLI-与装配.md",
    ],
    implementation: "packages/codegraph/src/analyze.ts",
  },
  {
    identifier: "CODE_INTEL_VERSION",
    documentation: ["docs/modules/01-契约层-contracts.md", "docs/modules/07-CodeGraph-代码图.md", ROADMAP],
    implementation: "packages/contracts/src/code-intel.ts",
  },
  {
    identifier: "CodeIntelProjectionSchema",
    documentation: ["docs/modules/01-契约层-contracts.md", "docs/modules/07-CodeGraph-代码图.md"],
    implementation: "packages/contracts/src/code-intel.ts",
  },
  {
    identifier: "captureGitContext",
    documentation: ["docs/modules/07-CodeGraph-代码图.md", "docs/modules/11-CLI-与装配.md"],
    implementation: "apps/cli/src/composition.ts",
  },
  {
    identifier: "ChangesView",
    documentation: ["docs/modules/10-Web-工作台.md"],
    implementation: "apps/web/src/components/ChangesView.tsx",
  },
] as const;

const VERSION_FACTS = [
  {
    identifier: "SCHEMA_VERSION",
    implementation: "packages/contracts/src/common.ts",
    documentation: "docs/modules/01-契约层-contracts.md",
  },
  {
    identifier: "PROJECTOR_VERSION",
    implementation: "packages/contracts/src/common.ts",
    documentation: "docs/modules/01-契约层-contracts.md",
  },
  {
    identifier: "SESSION_FORMAT_VERSION",
    implementation: "packages/contracts/src/session.ts",
    documentation: ROADMAP,
  },
  {
    identifier: "TELEMETRY_STATUS_SCHEMA_VERSION",
    implementation: "packages/contracts/src/telemetry.ts",
    documentation: "docs/modules/01-契约层-contracts.md",
  },
  {
    identifier: "EXTENSION_API_VERSION",
    implementation: "packages/contracts/src/extension.ts",
    documentation: "docs/modules/15-插件与扩展系统.md",
  },
] as const;

const EVENT_FACTS = [
  { event: "run.created", documentation: "docs/modules/02-Agent-Runtime.md" },
  { event: "run.completed", documentation: "docs/modules/02-Agent-Runtime.md" },
  { event: "context.built", documentation: "docs/modules/03-Context-与预算压缩.md" },
  { event: "tool.completed", documentation: "docs/modules/04-工具与策略审批.md" },
  { event: "permission.configured", documentation: "README.md" },
  { event: "sandbox.enforced", documentation: "README.md" },
  { event: "user.input_queued", documentation: ROADMAP },
  { event: "attachment.added", documentation: ROADMAP },
  { event: "attachment.rejected", documentation: ROADMAP },
  { event: "attachment.offloaded", documentation: ROADMAP },
  { event: "extension.error", documentation: "docs/modules/15-插件与扩展系统.md" },
  { event: "team.created", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.member_joined", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.heartbeat", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.member_lost", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.sweep_completed", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.mailbox_delivered", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.mailbox_claimed", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.task_created", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.task_claimed", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.task_completed", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.task_blocked", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.task_cancelled", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "team.task_reopened", documentation: "docs/modules/16-Agent-Team.md" },
  { event: "skill.registry_loaded", documentation: "docs/modules/17-Skill系统.md" },
  { event: "skill.conflict", documentation: "docs/modules/17-Skill系统.md" },
  { event: "skill.load_failed", documentation: "docs/modules/17-Skill系统.md" },
  { event: "mcp.server_started", documentation: "docs/modules/18-MCP客户端.md" },
  { event: "mcp.server_failed", documentation: "docs/modules/18-MCP客户端.md" },
  { event: "mcp.server_stopped", documentation: "docs/modules/18-MCP客户端.md" },
  { event: "mcp.tools_changed", documentation: "docs/modules/18-MCP客户端.md" },
  { event: "mcp.tool_called", documentation: "docs/modules/18-MCP客户端.md" },
  { event: "lsp.diagnostics_received", documentation: "docs/modules/19-LSP客户端.md" },
  { event: "lsp.server_unavailable", documentation: "docs/modules/19-LSP客户端.md" },
  { event: "code.intel_updated", documentation: "docs/modules/07-CodeGraph-代码图.md" },
  { event: "code.stale_base_detected", documentation: "docs/modules/07-CodeGraph-代码图.md" },
] as const;

const ROUTE_FACTS = [
  {
    method: "GET",
    documentedRoute: "/api/telemetry-status",
    implementationRoute: "/api/telemetry-status",
    documentation: "docs/modules/09-Host-与-SDK-接口层.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/input",
    implementationRoute: "/api/runs/:runId/input",
    documentation: "README.md",
  },
  {
    method: "GET",
    documentedRoute: "/api/sessions/:id",
    implementationRoute: "/api/sessions/:sessionId",
    documentation: ROADMAP,
  },
  {
    method: "POST",
    documentedRoute: "/api/sessions/:id/resume",
    implementationRoute: "/api/sessions/:sessionId/resume",
    documentation: ROADMAP,
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/actions/:actionId/rollback",
    implementationRoute: "/api/runs/:runId/actions/:actionId/rollback",
    documentation: ROADMAP,
  },
  {
    method: "POST",
    documentedRoute: "/api/attachments",
    implementationRoute: "/api/attachments",
    documentation: "docs/modules/09-Host-与-SDK-接口层.md",
  },
  {
    method: "GET",
    documentedRoute: "/api/runs/:runId/attachments/:attachmentId/content",
    implementationRoute: "/api/runs/:runId/attachments/:attachmentId/content",
    documentation: "docs/modules/09-Host-与-SDK-接口层.md",
  },
  {
    method: "GET",
    documentedRoute: "/api/extensions",
    implementationRoute: "/api/extensions",
    documentation: "docs/modules/09-Host-与-SDK-接口层.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/extensions/reload",
    implementationRoute: "/api/extensions/reload",
    documentation: "docs/modules/09-Host-与-SDK-接口层.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/extensions/commands/:name",
    implementationRoute: "/api/extensions/commands/:name",
    documentation: "docs/modules/09-Host-与-SDK-接口层.md",
  },
  {
    method: "GET",
    documentedRoute: "/api/runs/:runId/team",
    implementationRoute: "/api/runs/:runId/team",
    documentation: "docs/modules/16-Agent-Team.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/team",
    implementationRoute: "/api/runs/:runId/team",
    documentation: "docs/modules/16-Agent-Team.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/team/mailbox/send",
    implementationRoute: "/api/runs/:runId/team/mailbox/send",
    documentation: "docs/modules/16-Agent-Team.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/team/mailbox/claim",
    implementationRoute: "/api/runs/:runId/team/mailbox/claim",
    documentation: "docs/modules/16-Agent-Team.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/team/tasks/write",
    implementationRoute: "/api/runs/:runId/team/tasks/write",
    documentation: "docs/modules/16-Agent-Team.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/team/heartbeat",
    implementationRoute: "/api/runs/:runId/team/heartbeat",
    documentation: "docs/modules/16-Agent-Team.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/runs/:runId/team/sweep",
    implementationRoute: "/api/runs/:runId/team/sweep",
    documentation: "docs/modules/16-Agent-Team.md",
  },
  {
    method: "GET",
    documentedRoute: "/api/skills",
    implementationRoute: "/api/skills",
    documentation: "docs/modules/17-Skill系统.md",
  },
  {
    method: "GET",
    documentedRoute: "/api/mcp",
    implementationRoute: "/api/mcp",
    documentation: "docs/modules/18-MCP客户端.md",
  },
  {
    method: "POST",
    documentedRoute: "/api/mcp/restart/:name",
    implementationRoute: "/api/mcp/restart/:name",
    documentation: "docs/modules/18-MCP客户端.md",
  },
  {
    method: "GET",
    documentedRoute: "/api/lsp",
    implementationRoute: "/api/lsp",
    documentation: "docs/modules/19-LSP客户端.md",
  },
] as const;

const COMMAND_FACTS = [
  { script: "build", documentation: "README.md" },
  { script: "typecheck", documentation: "README.md" },
  { script: "test", documentation: "README.md" },
  { script: "test:e2e", documentation: "README.md" },
  { script: "evals", documentation: ROADMAP },
] as const;

const documentCache = new Map<string, Promise<string>>();

function readRepositoryFile(relativePath: string): Promise<string> {
  let pending = documentCache.get(relativePath);
  if (pending === undefined) {
    pending = fs.readFile(nodePath.join(REPOSITORY_ROOT, relativePath), "utf8");
    documentCache.set(relativePath, pending);
  }
  return pending;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegularExpression(identifier)}\\b`, "u").test(source);
}

function assignedConstantLiteral(source: string, identifier: string): string {
  const match = source.match(new RegExp(
    `export\\s+const\\s+${escapeRegularExpression(identifier)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|(\\d+))`,
    "u",
  ));
  const literal = match?.[1] ?? match?.[2] ?? match?.[3];
  if (literal === undefined) {
    throw new Error(`could not read literal value for ${identifier}`);
  }
  return literal;
}

function assignedStringArray(source: string, identifier: string): readonly string[] {
  const assignment = source.indexOf(`export const ${identifier}`);
  if (assignment < 0) throw new Error(`could not find ${identifier}`);
  const openingBracket = source.indexOf("[", assignment);
  const closingBracket = source.indexOf("]", openingBracket);
  if (openingBracket < 0 || closingBracket < 0) {
    throw new Error(`could not read array value for ${identifier}`);
  }
  return [...source.slice(openingBracket + 1, closingBracket).matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1]!);
}

function documentedConstantPattern(identifier: string, literal: string): RegExp {
  return new RegExp(
    `${escapeRegularExpression(identifier)}\\s*=\\s*["']?${escapeRegularExpression(literal)}["']?`,
    "u",
  );
}

function routeRegistrationPattern(method: string, route: string): RegExp {
  const escapedRoute = escapeRegularExpression(route);
  return new RegExp(
    `app\\.${method.toLowerCase()}(?:<[\\s\\S]*?>)?\\s*\\(\\s*["']${escapedRoute}["']`,
    "u",
  );
}

function documentedRoutePattern(method: string, route: string): RegExp {
  return new RegExp(
    `\\b${escapeRegularExpression(method)}\\b[^\\r\\n]{0,80}${escapeRegularExpression(route)}`,
    "u",
  );
}

function documentedCommandPattern(script: string): RegExp {
  return new RegExp(
    `\\bpnpm\\s+(?:run\\s+)?${escapeRegularExpression(script)}(?![:\\w-])`,
    "u",
  );
}

describe("G16 documentation consistency", () => {
  it("keeps documented public identifiers backed by their implementation", async () => {
    for (const fact of IDENTIFIER_FACTS) {
      const implementation = await readRepositoryFile(fact.implementation);
      expect(
        hasIdentifier(implementation, fact.identifier),
        `${fact.identifier} is missing from ${fact.implementation}`,
      ).toBe(true);
      for (const documentationPath of fact.documentation) {
        const documentation = await readRepositoryFile(documentationPath);
        expect(
          hasIdentifier(documentation, fact.identifier),
          `${fact.identifier} is missing from ${documentationPath}`,
        ).toBe(true);
      }
    }
  });

  it("keeps independent schema and storage version literals synchronized", async () => {
    for (const fact of VERSION_FACTS) {
      const implementation = await readRepositoryFile(fact.implementation);
      const documentation = await readRepositoryFile(fact.documentation);
      const literal = assignedConstantLiteral(implementation, fact.identifier);
      expect(
        documentedConstantPattern(fact.identifier, literal).test(documentation),
        `${fact.documentation} does not bind ${fact.identifier} to the current value ${literal}`,
      ).toBe(true);
    }
  });

  it("pins the current G20 rollout to 102 events, projector v9, 20 built-in tools, and recovery v5", async () => {
    const commonContract = await readRepositoryFile("packages/contracts/src/common.ts");
    const eventContract = await readRepositoryFile("packages/contracts/src/event.ts");
    const actionContract = await readRepositoryFile("packages/contracts/src/action.ts");
    const teamContract = await readRepositoryFile("packages/contracts/src/team.ts");
    const recoveryContract = await readRepositoryFile("packages/contracts/src/session.ts");
    const eventLedger = await readRepositoryFile("packages/core/src/event-ledger.ts");
    const toolRegistry = await readRepositoryFile("packages/core/src/tool-registry.ts");
    const runtime = await readRepositoryFile("packages/core/src/runtime.ts");
    const ledgerModule = await readRepositoryFile("docs/modules/05-证据链-账本投影工件.md");
    const teamModule = await readRepositoryFile("docs/modules/16-Agent-Team.md");
    const g20ProjectorVersion = "tracegraph.projector.v9";
    const eventTypes = assignedStringArray(eventContract, "EventTypeSchema");

    expect(assignedConstantLiteral(commonContract, "PROJECTOR_VERSION")).toBe(g20ProjectorVersion);
    expect(eventTypes).toHaveLength(102);
    expect(eventTypes.filter((event) => event.startsWith("team."))).toHaveLength(13);
    expect(eventTypes.filter((event) => event.startsWith("skill."))).toHaveLength(3);
    expect(eventTypes.filter((event) => event.startsWith("lsp."))).toHaveLength(2);
    expect(eventTypes.filter((event) => event.startsWith("code."))).toHaveLength(2);
    expect(assignedStringArray(actionContract, "BUILTIN_TOOL_NAMES")).toHaveLength(20);
    expect(assignedConstantLiteral(teamContract, "DEFAULT_TEAM_READ_PAGE_ITEMS")).toBe("25");
    expect(assignedConstantLiteral(teamContract, "MAX_TEAM_READ_PAGE_ITEMS")).toBe("100");
    expect(teamContract).toContain("expected_last_sequence");
    expect(eventLedger).toContain("appendAtomic(");
    expect(toolRegistry).toContain('code: "team_snapshot_changed"');
    expect(toolRegistry).toContain("compactTeamMutationFacts");
    expect(runtime).toMatch(/team_read[\s\S]{0,240}spilled_tool_output/u);

    const recoveryV5Start = recoveryContract.indexOf("export const CurrentRunRecoveryStateV5Schema");
    expect(recoveryV5Start).toBeGreaterThanOrEqual(0);
    expect(recoveryContract.slice(recoveryV5Start, recoveryV5Start + 500))
      .toMatch(/version:\s*z\.literal\(5\)/u);

    expect(teamModule).toMatch(/canonical Event 当前共 102 种/u);
    expect(teamModule).toMatch(/Run recovery 仍为 v5/u);
    expect(teamModule).toMatch(/内置 Tool 总数从 14 增到 19/u);
    expect(teamModule).toContain("team_snapshot_changed");
    expect(teamModule).toContain("spilled_tool_output");
    expect(teamModule).toContain("read_artifact");
    expect(ledgerModule).toContain("appendAtomic(scope, proposals, finalize?)");
    const skillModule = await readRepositoryFile("docs/modules/17-Skill系统.md");
    expect(skillModule).toContain("load_skill");
    expect(skillModule).toContain("skill.registry_loaded");
    const mcpModule = await readRepositoryFile("docs/modules/18-MCP客户端.md");
    expect(mcpModule).toContain("MCP_CONFIG_VERSION");
    expect(mcpModule).toContain("mcp.tools_changed");
    const lspModule = await readRepositoryFile("docs/modules/19-LSP客户端.md");
    expect(lspModule).toContain("LSP_CONFIG_VERSION");
    expect(lspModule).toContain("lsp.diagnostics_received");
    for (const documentationPath of ["docs/modules/01-契约层-contracts.md", "docs/modules/16-Agent-Team.md", "docs/modules/17-Skill系统.md", "docs/modules/18-MCP客户端.md", "docs/modules/19-LSP客户端.md", ROADMAP]) {
      const documentation = await readRepositoryFile(documentationPath);
      expect(
        hasIdentifier(documentation, "PROJECTOR_VERSION")
          && documentation.includes(g20ProjectorVersion),
        `${documentationPath} does not bind PROJECTOR_VERSION to the G20 value ${g20ProjectorVersion}`,
      ).toBe(true);
    }
  });

  it("keeps documented durable event names in the canonical EventTypeSchema", async () => {
    const eventContract = await readRepositoryFile("packages/contracts/src/event.ts");
    for (const fact of EVENT_FACTS) {
      const documentation = await readRepositoryFile(fact.documentation);
      expect(
        documentation.includes(fact.event),
        `${fact.event} is missing from ${fact.documentation}`,
      ).toBe(true);
      expect(
        eventContract.includes(`"${fact.event}"`),
        `${fact.event} is missing from packages/contracts/src/event.ts`,
      ).toBe(true);
    }
  });

  it("keeps implemented README, module, and roadmap routes registered by Host", async () => {
    const host = await readRepositoryFile("packages/host/src/index.ts");
    for (const fact of ROUTE_FACTS) {
      const documentation = await readRepositoryFile(fact.documentation);
      expect(
        documentedRoutePattern(fact.method, fact.documentedRoute).test(documentation),
        `${fact.method} ${fact.documentedRoute} is missing from ${fact.documentation}`,
      ).toBe(true);
      expect(
        routeRegistrationPattern(fact.method, fact.implementationRoute).test(host),
        `${fact.method} ${fact.implementationRoute} is not registered by Host`,
      ).toBe(true);
    }
  });

  it("keeps documented verification commands backed by root package scripts", async () => {
    const packageJson = JSON.parse(
      await readRepositoryFile("package.json"),
    ) as { readonly scripts?: Readonly<Record<string, unknown>> };
    for (const fact of COMMAND_FACTS) {
      const documentation = await readRepositoryFile(fact.documentation);
      expect(
        documentedCommandPattern(fact.script).test(documentation),
        `pnpm ${fact.script} is missing from ${fact.documentation}`,
      ).toBe(true);
      expect(
        typeof packageJson.scripts?.[fact.script] === "string"
          && packageJson.scripts[fact.script] !== "",
        `${fact.script} is missing from package.json scripts`,
      ).toBe(true);
    }
  });
});
