import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { stringify } from "yaml";

import { verifyV2Docs } from "./verify-v2-docs.mjs";

let root;

async function writeFixture(manifest, roadmap) {
  const docs = join(root, "docs/outlive-agent-v2");
  await mkdir(docs, { recursive: true });
  await mkdir(join(root, "docs/modules"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Current truth\n");
  await writeFile(join(root, "docs/modules/README.md"), "# Current modules\n");
  await writeFile(join(docs, "design.md"), "# Design\n");
  await writeFile(join(docs, "index.md"), "# Index\n");
  await writeFile(join(docs, "section.md"), "# Section\n");
  await writeFile(join(docs, "subsection.md"), "# Subsection\n");
  await writeFile(join(docs, "manifest.yaml"), stringify(manifest));
  await writeFile(join(docs, "roadmap.yaml"), stringify(roadmap));
}

function validManifest() {
  return {
    canonical_entry: "design.md",
    design_index: "index.md",
    truth_sources: { current_product: ["../../README.md", "../modules/"] },
    state_vocabulary: { document: ["proposed", "implemented", "internal-design-input"] },
    documents: [{ id: "section", path: "section.md", status: "proposed", subdocuments: ["subsection.md"] }],
  };
}

function validRoadmap() {
  return {
    phases: [{ id: "P0" }],
    tasks: [
      { id: "GOV-001", phase: "P0", depends_on: [] },
      { id: "DOC-002", phase: "P0", depends_on: ["GOV-001"] },
    ],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tracegraph-v2-docs-"));
  await writeFixture(validManifest(), validRoadmap());
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("V2 documentation manifest and roadmap verifier", () => {
  it("accepts a valid manifest and acyclic task graph", async () => {
    const result = await verifyV2Docs(root);
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    assert.equal(result.documentCount, 1);
    assert.equal(result.taskCount, 2);
  });

  it("fails for missing manifest paths and invalid document status", async () => {
    const manifest = validManifest();
    manifest.documents[0].path = "missing.md";
    manifest.documents[0].status = "shipped-ish";
    await writeFixture(manifest, validRoadmap());
    const result = await verifyV2Docs(root);
    assert.ok(result.issues.some(({ code }) => code === "V2DOC_PATH_MISSING"));
    assert.ok(result.issues.some(({ code }) => code === "V2DOC_STATUS_INVALID"));
  });

  it("fails for duplicate task IDs", async () => {
    const roadmap = validRoadmap();
    roadmap.tasks.push({ id: "GOV-001", phase: "P0", depends_on: [] });
    await writeFixture(validManifest(), roadmap);
    const result = await verifyV2Docs(root);
    assert.ok(result.issues.some(({ code }) => code === "V2DOC_TASK_ID_DUPLICATE"));
  });

  it("fails for dependency cycles", async () => {
    const roadmap = validRoadmap();
    roadmap.tasks[0].depends_on = ["DOC-002"];
    await writeFixture(validManifest(), roadmap);
    const result = await verifyV2Docs(root);
    assert.ok(result.issues.some(({ code }) => code === "V2DOC_DEPENDENCY_CYCLE"));
  });

  it("returns exit code 1 for invalid repository input", async () => {
    const roadmap = validRoadmap();
    roadmap.tasks[0].depends_on = ["DOC-002"];
    await writeFixture(validManifest(), roadmap);
    const script = new URL("./verify-v2-docs.mjs", import.meta.url);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [script.pathname, "--root", root], { encoding: "utf8", env });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /V2DOC_DEPENDENCY_CYCLE/);
  });
});
