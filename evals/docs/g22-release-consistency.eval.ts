import { promises as fs } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "../support/paths.js";

interface LimitationEntry {
  readonly id: string;
  readonly status: "mapped" | "unmapped";
  readonly summary: string;
  readonly code: readonly string[];
  readonly tests: readonly string[];
  readonly commands: readonly string[];
  readonly roadmap: string;
}

interface LimitationMap {
  readonly schema_version: string;
  readonly entries: readonly LimitationEntry[];
}

const REQUIRED_CI_JOBS = ["typecheck", "test", "evals"] as const;
const REQUIRED_SCRIPTS = [
  "coverage",
  "evals",
  "release:check",
  "release:bundle",
  "supply-chain:check",
  "verify:lockfile",
] as const;

describe("G22 engineering and release consistency", () => {
  it("keeps the three CI jobs least-privilege and immutable-action pinned", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    const releaseWorkflow = await read(".github/workflows/release.yml");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(releaseWorkflow).toContain("permissions:\n  contents: read");
    for (const job of REQUIRED_CI_JOBS) {
      expect(workflow, `missing CI job ${job}`).toMatch(new RegExp(`^  ${job}:$`, "mu"));
    }
    const uses = [workflow, releaseWorkflow].flatMap((source) => (
      [...source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu)].map((match) => match[1])
    ));
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const action of uses) {
      expect(action, `Action is not pinned to an immutable commit: ${action}`).toMatch(
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u,
      );
    }
    expect(workflow.match(/install: false/gu)?.length).toBe(3);
    expect(releaseWorkflow.match(/install: false/gu)?.length).toBe(1);
    const preinstallGuard = "node scripts/verify-lockfile.mjs --skip-frozen";
    expect(workflow.match(new RegExp(preinstallGuard.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))?.length).toBe(3);
    expect(releaseWorkflow.match(new RegExp(preinstallGuard.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))?.length).toBe(1);
    expect(workflow.indexOf(preinstallGuard)).toBeLessThan(workflow.indexOf("pnpm install --frozen-lockfile"));
    expect(releaseWorkflow.indexOf(preinstallGuard)).toBeLessThan(releaseWorkflow.indexOf("pnpm install --frozen-lockfile"));
    expect(workflow).toContain("runtime: node@22.19.0");
    expect(workflow).toContain("version: 11.19.0");
    expect(releaseWorkflow).toContain("node scripts/verify-release.mjs --write-manifest --tag");
    expect(releaseWorkflow).toContain("tags:\n      - \"v*\"");
    expect(releaseWorkflow).not.toContain("workflow_dispatch");
    expect(releaseWorkflow).toContain("_tmp_release/bundle/");
    expect(releaseWorkflow).not.toContain("packages/*/dist/");
    expect(releaseWorkflow).toContain("if-no-files-found: error");
  });

  it("keeps documented G22 commands backed by root scripts", async () => {
    const manifest = JSON.parse(await read("package.json")) as {
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    const moduleDocumentation = await read("docs/modules/13-工程化与发布.md");
    expect(manifest.scripts?.typecheck).toMatch(/^pnpm run build && /u);
    for (const script of REQUIRED_SCRIPTS) {
      expect(typeof manifest.scripts?.[script], `missing package script ${script}`).toBe("string");
      expect(moduleDocumentation, `module documentation omits pnpm ${script}`).toContain(`pnpm ${script}`);
    }
  });

  it("keeps every explicit limitation either executable-mapped or honestly unmapped", async () => {
    const map = JSON.parse(await read("docs/known-limitations-map.json")) as LimitationMap;
    const documentation = await read("KNOWN_LIMITATIONS.md");
    const packageScripts = await readWorkspacePackageScripts();
    expect(map.schema_version).toBe("tracegraph.known-limitations-map.v1");
    expect(map.entries.length).toBeGreaterThan(0);
    expect(map.entries.length).toBeLessThanOrEqual(64);
    const ids = new Set<string>();
    for (const entry of map.entries) {
      expect(["mapped", "unmapped"]).toContain(entry.status);
      expect(entry.id).toMatch(/^LIM-[A-Z0-9-]+$/u);
      expect(ids.has(entry.id), `duplicate limitation id ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(documentation, `${entry.id} is absent from KNOWN_LIMITATIONS.md`).toContain(`\`${entry.id}\``);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.roadmap.length).toBeGreaterThan(0);
      if (entry.status === "mapped") {
        expect(entry.code.length, `${entry.id} has no implementation boundary`).toBeGreaterThan(0);
        expect(entry.tests.length, `${entry.id} has no test boundary`).toBeGreaterThan(0);
        expect(entry.commands.length, `${entry.id} has no executable command`).toBeGreaterThan(0);
        for (const path of [...entry.code, ...entry.tests]) {
          expect(await isRegularFile(path), `${entry.id} points to missing ${path}`).toBe(true);
        }
        for (const command of entry.commands) {
          expect(command).toMatch(/^pnpm\s/u);
          expect(commandExists(command, packageScripts), `${entry.id} command is not backed by package scripts: ${command}`).toBe(true);
        }
      } else {
        expect(entry.code, `${entry.id} must not pretend an implementation mapping`).toEqual([]);
        expect(entry.tests, `${entry.id} must not pretend a test mapping`).toEqual([]);
        expect(entry.commands, `${entry.id} must not pretend an executable mapping`).toEqual([]);
      }
    }
    const documentedIds = [...documentation.matchAll(/`(LIM-[A-Z0-9-]+)`/gu)]
      .map((match) => match[1])
      .sort();
    expect(documentedIds).toEqual([...ids].sort());
  });

  it("keeps the private artifact release boundary explicit and versioned", async () => {
    const rootManifest = JSON.parse(await read("package.json")) as {
      readonly version?: string;
      readonly private?: boolean;
    };
    const changelog = await read("CHANGELOG.md");
    const releaseScript = await read("scripts/verify-release.mjs");
    const englishReadme = await read("README.en.md");
    expect(rootManifest.private).toBe(true);
    expect(changelog).toContain(`## [${rootManifest.version}] - `);
    expect(releaseScript).toContain("tracegraph.release-manifest.v1");
    expect(releaseScript).toContain("private-workspace-build-artifact");
    expect(englishReadme).toContain("does not claim or perform an npm registry publication");
  });
});

async function read(relativePath: string): Promise<string> {
  return fs.readFile(nodePath.join(REPOSITORY_ROOT, relativePath), "utf8");
}

async function isRegularFile(relativePath: string): Promise<boolean> {
  try {
    const info = await fs.lstat(nodePath.join(REPOSITORY_ROOT, relativePath));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readWorkspacePackageScripts(): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  const rootManifest = JSON.parse(await read("package.json")) as {
    readonly name?: string;
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  result.set(rootManifest.name ?? "tracegraph-agent", stringScriptKeys(rootManifest.scripts));
  for (const scope of ["apps", "packages"] as const) {
    const entries = await fs.readdir(nodePath.join(REPOSITORY_ROOT, scope), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const source = await read(`${scope}/${entry.name}/package.json`);
      const manifest = JSON.parse(source) as {
        readonly name?: string;
        readonly scripts?: Readonly<Record<string, unknown>>;
      };
      if (manifest.name !== undefined) result.set(manifest.name, stringScriptKeys(manifest.scripts));
    }
  }
  return result;
}

function stringScriptKeys(scripts: Readonly<Record<string, unknown>> | undefined): Set<string> {
  return new Set(Object.entries(scripts ?? {})
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key]) => key));
}

function commandExists(command: string, packageScripts: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const filtered = command.match(/^pnpm\s+--filter\s+(\S+)\s+(?:run\s+)?(\S+)$/u);
  if (filtered !== null) {
    const packageName = filtered[1];
    const scriptName = filtered[2];
    return packageName !== undefined
      && scriptName !== undefined
      && packageScripts.get(packageName)?.has(scriptName) === true;
  }
  const root = command.match(/^pnpm\s+(?:run\s+)?(\S+)$/u);
  const scriptName = root?.[1];
  return scriptName !== undefined
    && packageScripts.get("tracegraph-agent")?.has(scriptName) === true;
}
