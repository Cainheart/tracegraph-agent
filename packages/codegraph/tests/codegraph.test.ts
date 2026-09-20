import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeCodeGraph,
  CodeGraphAnalysisError,
  diffGraphSnapshots,
  getImpactNeighborhood,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const FIXED_TIME = "2026-09-16T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(removeTemporaryDirectory),
  );
});

describe("analyzeCodeGraph", () => {
  it("indexes deterministic TS/JS file, directory, import, and export evidence", async () => {
    const root = await fixture({
      "src/index.ts": [
        'import { value } from "./value";',
        'export { value } from "./value";',
        "console.log(value);",
      ].join("\n"),
      "src/value.ts": "export const value = 1;\n",
    });

    const first = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:fixture",
      created_at: FIXED_TIME,
    });
    const second = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:fixture",
      created_at: "2026-09-16T08:01:00.000Z",
    });

    expect(first.snapshot.snapshot_id).toBe(second.snapshot.snapshot_id);
    expect(first.snapshot.workspace_hash).toBe(second.snapshot.workspace_hash);
    expect(first.coverage).toEqual({
      status: "complete",
      indexed_file_count: 2,
      skipped_dynamic_import_count: 0,
      skipped_commonjs_require_count: 0,
      unresolved_static_edge_count: 0,
      partial_static_edge_count: 0,
    });
    const indexNode = first.snapshot.nodes.find((node) => node.file_path === "src/index.ts");
    const valueNode = first.snapshot.nodes.find((node) => node.file_path === "src/value.ts");
    expect(indexNode).toBeDefined();
    expect(valueNode).toBeDefined();
    expect(first.snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_path: "src", kind: "directory" }),
        expect.objectContaining({ file_path: "src/index.ts", kind: "file" }),
        expect.objectContaining({ file_path: "src/value.ts", kind: "file" }),
      ]),
    );
    expect(first.snapshot.edges).toHaveLength(2);
    expect(first.snapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "static_import",
          source_node_id: indexNode?.id,
          target_node_id: valueNode?.id,
          file_path: "src/index.ts",
          line: 1,
          confidence: "high",
          resolution: "resolved",
        }),
        expect.objectContaining({
          kind: "static_export",
          source_node_id: indexNode?.id,
          target_node_id: valueNode?.id,
          file_path: "src/index.ts",
          line: 2,
          confidence: "high",
          resolution: "resolved",
        }),
      ]),
    );
    expect(JSON.stringify(first.snapshot)).not.toContain(root);
  });

  it("marks external and unresolved static evidence without inventing dynamic edges", async () => {
    const root = await fixture({
      "src/index.ts": [
        'import React from "react";',
        'export { missing } from "./missing";',
        'const lazy = () => import("./lazy");',
      ].join("\n"),
      "src/lazy.ts": "export const lazy = true;\n",
    });

    const analysis = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:uncertain",
      created_at: FIXED_TIME,
    });

    expect(analysis.coverage).toEqual({
      status: "partial",
      indexed_file_count: 2,
      skipped_dynamic_import_count: 1,
      skipped_commonjs_require_count: 0,
      unresolved_static_edge_count: 1,
      partial_static_edge_count: 1,
    });
    expect(analysis.snapshot.edges).toHaveLength(2);
    expect(analysis.snapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "static_import",
          resolution: "partial",
          confidence: "medium",
        }),
        expect.objectContaining({
          kind: "static_export",
          resolution: "unknown",
          confidence: "low",
        }),
      ]),
    );
    expect(analysis.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "dynamic_import_unsupported",
        "external_module_partial",
        "static_module_unresolved",
      ]),
    );
    const lazyNode = analysis.snapshot.nodes.find((node) => node.file_path === "src/lazy.ts");
    expect(lazyNode).toBeDefined();
    expect(
      analysis.snapshot.edges.some((edge) => edge.target_node_id === lazyNode?.id),
    ).toBe(false);
  });

  it("does not follow source-directory symlinks", async () => {
    const outside = await fixture({ "secret.ts": "export const secret = true;\n" });
    const root = await fixture({ "src/index.ts": "export const safe = true;\n" });
    await fs.symlink(outside, nodePath.join(root, "linked"));

    const analysis = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:symlink",
      created_at: FIXED_TIME,
    });

    expect(analysis.coverage.indexed_file_count).toBe(1);
    expect(analysis.snapshot.nodes.some((node) => node.file_path?.includes("secret"))).toBe(false);
  });

  it("enforces cancellation, deadline, depth, file-count, and byte budgets", async () => {
    const root = await fixture({
      "root.ts": "export const root = true;\n",
      "src/a.ts": "export const a = true;\n",
    });
    const base = {
      workspace_root: root,
      project_id: "project:limits",
      created_at: FIXED_TIME,
    } as const;

    const controller = new AbortController();
    controller.abort("test cancellation");
    await expect(analyzeCodeGraph({ ...base, signal: controller.signal })).rejects.toMatchObject({
      name: "CodeGraphAnalysisError",
      code: "analysis_aborted",
    });
    await expect(analyzeCodeGraph({ ...base, deadlineMs: 0 })).rejects.toMatchObject({
      code: "analysis_deadline_exceeded",
    });
    await expect(analyzeCodeGraph({ ...base, maxDepth: 0 })).rejects.toMatchObject({
      code: "analysis_depth_limit_exceeded",
    });
    await expect(analyzeCodeGraph({ ...base, maxFiles: 1 })).rejects.toMatchObject({
      code: "analysis_file_limit_exceeded",
    });
    await expect(analyzeCodeGraph({ ...base, maxFileBytes: 4 })).rejects.toMatchObject({
      code: "analysis_file_too_large",
    });
    await expect(analyzeCodeGraph({ ...base, maxBytes: 4 })).rejects.toMatchObject({
      code: "analysis_byte_limit_exceeded",
    });
    expect(CodeGraphAnalysisError).toBeInstanceOf(Function);
  });

  it("uses fixed-length path identities while preserving long workspace paths", async () => {
    const longPath = `${"a".repeat(90)}/${"b".repeat(90)}/index.ts`;
    const root = await fixture({ [longPath]: "export const value = true;\n" });

    const analysis = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:long-path",
      created_at: FIXED_TIME,
    });
    const fileNode = analysis.snapshot.nodes.find((node) => node.file_path === longPath);

    expect(fileNode).toBeDefined();
    expect(fileNode?.id.length).toBeLessThanOrEqual(160);
    expect(fileNode?.id).toMatch(/^file:sha256:[a-f0-9]{64}$/u);
    expect(
      analysis.snapshot.nodes
        .filter((node) => node.kind === "directory")
        .every((node) => node.id.length <= 160),
    ).toBe(true);
  });

  it("resolves explicit JavaScript specifiers conservatively when sources are ambiguous", async () => {
    const root = await fixture({
      "src/index.ts": 'import { value } from "./value.js";\nexport { value };\n',
      "src/value.js": "export const value = 'javascript';\n",
      "src/value.ts": "export const value = 'typescript';\n",
    });

    const analysis = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:ambiguous-resolution",
      created_at: FIXED_TIME,
    });
    const edge = analysis.snapshot.edges.find((candidate) => candidate.file_path === "src/index.ts");
    const target = analysis.snapshot.nodes.find((node) => node.id === edge?.target_node_id);

    expect(target?.file_path).toBe("src/value.ts");
    expect(edge).toMatchObject({ confidence: "medium", resolution: "partial" });
    expect(analysis.diagnostics.map(({ code }) => code)).toContain("ambiguous_static_module");
    expect(analysis.coverage.status).toBe("partial");
  });

  it("records literal CommonJS require conservatively and marks dynamic require partial", async () => {
    const root = await fixture({
      "src/index.cjs": [
        'const dependency = require("./dependency.cjs");',
        'const requested = "./runtime.cjs";',
        "require(requested);",
        "module.exports = dependency;",
      ].join("\n"),
      "src/dependency.cjs": "module.exports = { value: true };\n",
      "src/runtime.cjs": "module.exports = { runtime: true };\n",
    });

    const analysis = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:commonjs",
      created_at: FIXED_TIME,
    });
    const literalEdge = analysis.snapshot.edges.find(
      (edge) => edge.file_path === "src/index.cjs",
    );
    const target = analysis.snapshot.nodes.find((node) => node.id === literalEdge?.target_node_id);

    expect(target?.file_path).toBe("src/dependency.cjs");
    expect(literalEdge).toMatchObject({ confidence: "medium", resolution: "partial" });
    expect(analysis.coverage).toMatchObject({
      status: "partial",
      skipped_commonjs_require_count: 1,
      partial_static_edge_count: 1,
    });
    expect(analysis.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["commonjs_require_partial", "commonjs_require_unsupported"]),
    );
  });

  it("does not report complete coverage for an invalid tsconfig", async () => {
    const root = await fixture({
      "src/index.ts": "export const value = true;\n",
      "tsconfig.json": "{ invalid json",
    });

    const analysis = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:invalid-config",
      created_at: FIXED_TIME,
      tsconfig_path: "tsconfig.json",
    });

    expect(analysis.coverage.status).toBe("partial");
    expect(analysis.diagnostics.map(({ code }) => code)).toContain("invalid_tsconfig");
  });
});

describe("diffGraphSnapshots", () => {
  it("reports added, removed, changed, unknown, and partial evidence", async () => {
    const root = await fixture({
      "src/index.ts": [
        'import { value } from "./value";',
        'import { removed } from "./removed";',
        'import external from "external-package";',
        'export { missing } from "./missing";',
      ].join("\n"),
      "src/removed.ts": "export const removed = true;\n",
      "src/value.ts": "export const value = 1;\n",
    });
    const before = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:delta",
      created_at: FIXED_TIME,
    });

    await fs.rename(
      nodePath.join(root, "src/removed.ts"),
      nodePath.join(root, "src/removed.ts.disabled"),
    );
    await fs.writeFile(nodePath.join(root, "src/value.ts"), "export const value = 2;\n");
    await fs.writeFile(nodePath.join(root, "src/added.ts"), "export const added = true;\n");
    await fs.writeFile(
      nodePath.join(root, "src/index.ts"),
      [
        "",
        'import { value } from "./value";',
        'import external from "external-package";',
        'export { missing } from "./missing";',
      ].join("\n"),
    );
    const after = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:delta",
      created_at: "2026-09-16T08:02:00.000Z",
    });

    const delta = diffGraphSnapshots(before.snapshot, after.snapshot, {
      patch_event_id: "event:patch",
      created_at: "2026-09-16T08:03:00.000Z",
    });

    expect(delta.patch_event_id).toBe("event:patch");
    expect(delta.node_changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: "added",
          after: expect.objectContaining({ file_path: "src/added.ts" }),
        }),
        expect.objectContaining({
          change: "removed",
          before: expect.objectContaining({ file_path: "src/removed.ts" }),
        }),
        expect.objectContaining({
          change: "changed",
          before: expect.objectContaining({ file_path: "src/value.ts" }),
          after: expect.objectContaining({ file_path: "src/value.ts" }),
        }),
      ]),
    );
    expect(delta.edge_changes.map(({ change }) => change)).toEqual(
      expect.arrayContaining(["removed", "changed"]),
    );

    const syntheticBefore = {
      ...before.snapshot,
      edges: [],
    };
    const uncertainDelta = diffGraphSnapshots(syntheticBefore, after.snapshot, {
      created_at: FIXED_TIME,
    });
    expect(uncertainDelta.edge_changes.map(({ change }) => change)).toEqual(
      expect.arrayContaining(["added", "partial", "unknown"]),
    );
  });

  it("rejects a cross-project delta", async () => {
    const root = await fixture({ "index.ts": "export const value = 1;\n" });
    const left = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:left",
      created_at: FIXED_TIME,
    });
    const right = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:right",
      created_at: FIXED_TIME,
    });

    expect(() => diffGraphSnapshots(left.snapshot, right.snapshot)).toThrow(
      "cannot diff snapshots from different projects",
    );
  });
});

describe("getImpactNeighborhood", () => {
  it("returns an upstream impact view limited to two hops", async () => {
    const root = await fixture({
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": 'import "./c";\n',
      "src/c.ts": "export const value = 1;\n",
      "src/d.ts": 'import "./a";\n',
    });
    const analysis = await analyzeCodeGraph({
      workspace_root: root,
      project_id: "project:impact",
      created_at: FIXED_TIME,
    });

    const originNode = analysis.snapshot.nodes.find((node) => node.file_path === "src/c.ts");
    expect(originNode).toBeDefined();
    if (originNode === undefined) throw new Error("Expected src/c.ts in the graph");
    const impact = getImpactNeighborhood(analysis.snapshot, originNode.id, {
      direction: "upstream",
      max_depth: 2,
    });

    expect(impact.nodes.map(({ node, depth }) => [node.file_path, depth])).toEqual([
      ["src/c.ts", 0],
      ["src/b.ts", 1],
      ["src/a.ts", 2],
    ]);
    expect(impact.edges).toHaveLength(2);
  });
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await fs.mkdtemp(nodePath.join(tmpdir(), "tracegraph-codegraph-"));
  temporaryDirectories.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = nodePath.join(root, relativePath);
    await fs.mkdir(nodePath.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  return root;
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("SAFE_DELETE_BULK_CONFIRM_REQUIRED")) {
      return;
    }
    throw error;
  }
}
