import { promises as fs } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "../support/paths.js";

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

  it("keeps every current module indexed and migration boundaries explicit", async () => {
    const documentationIndex = await read("docs/README.md");
    const v2DesignIndex = await read("docs/outlive-agent-v2/README.md");
    const v2Manifest = await read("docs/outlive-agent-v2/manifest.yaml");
    const migrationBaseline = await read("docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md");
    const moduleEntries = await fs.readdir(nodePath.join(REPOSITORY_ROOT, "docs/modules"), { withFileTypes: true });
    const moduleFiles = moduleEntries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();

    expect(moduleFiles.length).toBeGreaterThanOrEqual(19);
    for (const moduleFile of moduleFiles) {
      expect(documentationIndex, `${moduleFile} is absent from docs/README.md`)
        .toContain(`(modules/${moduleFile})`);
    }

    const v2Entries = await fs.readdir(nodePath.join(REPOSITORY_ROOT, "docs/outlive-agent-v2"), { withFileTypes: true });
    const v2ModuleDirectories = v2Entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^\d{2}-/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(v2ModuleDirectories).toHaveLength(11);
    for (const moduleDirectory of v2ModuleDirectories) {
      const modulePath = nodePath.join("docs/outlive-agent-v2", moduleDirectory);
      const moduleIndex = await read(nodePath.join(modulePath, "README.md"));
      const moduleEntries = await fs.readdir(nodePath.join(REPOSITORY_ROOT, modulePath), { withFileTypes: true });
      const subdocuments = moduleEntries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^\d{2}-.*\.md$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      expect(subdocuments.length, `${moduleDirectory} needs decision-level subdocuments`).toBeGreaterThanOrEqual(2);
      expect(v2DesignIndex, `${moduleDirectory} is absent from the V2 design index`)
        .toContain(`(${moduleDirectory}/README.md)`);
      expect(v2Manifest, `${moduleDirectory} README is absent from manifest.yaml`)
        .toContain(`path: ${moduleDirectory}/README.md`);
      for (const subdocument of subdocuments) {
        expect(moduleIndex, `${subdocument} is absent from ${moduleDirectory}/README.md`)
          .toContain(`(${subdocument})`);
        expect(v2Manifest, `${moduleDirectory}/${subdocument} is absent from manifest.yaml`)
          .toContain(`- ${moduleDirectory}/${subdocument}`);
        const subdocumentContent = await read(nodePath.join(modulePath, subdocument));
        expect(subdocumentContent, `${moduleDirectory}/${subdocument} needs an architecture diagram`)
          .toContain("```mermaid");
        expect(subdocumentContent, `${moduleDirectory}/${subdocument} needs decision parameters`)
          .toContain("参数");
        expect(subdocumentContent, `${moduleDirectory}/${subdocument} needs acceptance criteria`)
          .toContain("验收");
      }
    }

    const boundaryIds = [...migrationBaseline.matchAll(/^\| `(LIM-[A-Z0-9-]+)` \|/gmu)]
      .map((match) => match[1]);
    expect(boundaryIds.length).toBeGreaterThanOrEqual(20);
    expect(new Set(boundaryIds).size).toBe(boundaryIds.length);
    expect(migrationBaseline).toContain("## 3. G-01～G-23 的 V2 去向");
    expect(migrationBaseline).toContain("## 7. 每个迁移任务的完成定义");
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
