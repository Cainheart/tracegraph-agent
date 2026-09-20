import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionSchema,
  DISPOSABLE_FIXTURE_CAPABILITIES,
  MAX_ATTACHMENT_BYTES,
  WorkspaceHandleSchema,
  type ModelCapabilities,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlEventLedger } from "./event-ledger.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import type { ModelAdapter, ModelInput } from "./types.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("G18 Runtime attachment integration", () => {
  it("durably rejects an oversized upload before run.started", async () => {
    const harness = await createHarness("oversized", false);
    const receipt = await harness.runtime.stageAttachment({
      commandId: "command:upload:oversized",
      projectId: harness.workspace.project_id,
      declaredMediaType: "image/png",
      bytes: oversizedPng(),
    });
    expect(receipt).toMatchObject({ status: "rejected", code: "too_large" });

    const started = await harness.runtime.startRun(startInput(harness.workspace, receipt.upload_id));
    await waitForTerminal(harness.runtime, started.run_id);
    const events = await new JsonlEventLedger(join(harness.dataDir, "events")).list(started.run_id);
    const created = events.findIndex(({ type }) => type === "run.created");
    const rejected = events.findIndex(({ type }) => type === "attachment.rejected");
    const runStarted = events.findIndex(({ type }) => type === "run.started");
    const modelStarted = events.findIndex(({ type }) => type === "model.request_started");

    expect(created).toBeGreaterThanOrEqual(0);
    expect(rejected).toBeGreaterThan(created);
    expect(runStarted).toBeGreaterThan(rejected);
    expect(modelStarted).toBeGreaterThan(runStarted);
    expect(events[rejected]?.data).toMatchObject({ code: "too_large", upload_id: receipt.upload_id });
    expect(harness.model.inputs[0]?.images).toBeUndefined();
  });

  it("rejects explicit inline delivery when the model lacks image capability and sends zero image blocks", async () => {
    const harness = await createHarness("unsupported-inline", false);
    const receipt = await harness.runtime.stageAttachment({
      commandId: "command:upload:unsupported-inline",
      projectId: harness.workspace.project_id,
      declaredMediaType: "image/png",
      delivery: "inline",
      bytes: png(),
    });
    expect(receipt.status).toBe("accepted");

    const started = await harness.runtime.startRun(startInput(harness.workspace, receipt.upload_id));
    const completed = await waitForTerminal(harness.runtime, started.run_id);

    expect(completed.attachments.items).toEqual([
      expect.objectContaining({
        status: "rejected",
        code: "model_image_unsupported",
        upload_id: receipt.upload_id,
      }),
    ]);
    expect(harness.model.inputs).toHaveLength(1);
    expect(harness.model.inputs[0]?.images).toBeUndefined();
    expect(JSON.stringify(completed.timeline)).not.toContain(Buffer.from(png()).toString("base64"));
  });

  it("sends an explicitly inlined image only on the first model request when capability is declared", async () => {
    const harness = await createHarness("supported-inline", true);
    const receipt = await harness.runtime.stageAttachment({
      commandId: "command:upload:supported-inline",
      projectId: harness.workspace.project_id,
      declaredMediaType: "image/png",
      delivery: "inline",
      bytes: png(),
    });
    const started = await harness.runtime.startRun(startInput(harness.workspace, receipt.upload_id));
    const completed = await waitForTerminal(harness.runtime, started.run_id);

    expect(completed.attachments.items).toEqual([
      expect.objectContaining({ status: "added", delivery: "inline" }),
    ]);
    expect(completed.timeline.some(({ type }) => type === "attachment.offloaded")).toBe(false);
    expect(harness.model.inputs[0]?.images).toEqual([
      expect.objectContaining({
        attachment: expect.objectContaining({ media_type: "image/png" }),
        data_base64: Buffer.from(png()).toString("base64"),
      }),
    ]);
  });

  it("defaults images to offload even when the model supports images", async () => {
    const harness = await createHarness("default-offload", true);
    const receipt = await harness.runtime.stageAttachment({
      commandId: "command:upload:default-offload",
      projectId: harness.workspace.project_id,
      declaredMediaType: "image/png",
      bytes: png(),
    });
    const started = await harness.runtime.startRun(startInput(harness.workspace, receipt.upload_id));
    const completed = await waitForTerminal(harness.runtime, started.run_id);

    expect(completed.attachments.items).toEqual([
      expect.objectContaining({
        status: "offloaded",
        delivery: "offload",
        offload_reason: "default_policy",
      }),
    ]);
    expect(harness.model.inputs[0]?.images).toBeUndefined();
  });

  it("records an explicit reference-only fallback when PDF text extraction fails", async () => {
    const harness = await createHarness("pdf-fallback", true);
    const receipt = await harness.runtime.stageAttachment({
      commandId: "command:upload:pdf-fallback",
      projectId: harness.workspace.project_id,
      declaredMediaType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF"),
    });
    const started = await harness.runtime.startRun(startInput(harness.workspace, receipt.upload_id));
    const completed = await waitForTerminal(harness.runtime, started.run_id);
    const item = completed.attachments.items[0];

    expect(item).toMatchObject({
      status: "offloaded",
      offload_reason: "pdf_reference",
      pdf_extraction: {
        status: "failed",
        code: "pdf_text_extraction_failed",
        fallback: "reference_only",
      },
    });
    expect(harness.model.inputs[0]?.images).toBeUndefined();
    expect(harness.model.inputs[0]?.observations).toEqual([
      expect.objectContaining({
        facts: expect.objectContaining({
          kind: "attachment",
          media_type: "application/pdf",
          pdf_extraction: expect.objectContaining({ status: "failed", fallback: "reference_only" }),
        }),
      }),
    ]);
  });
});

async function createHarness(name: string, imageInput: boolean): Promise<{
  dataDir: string;
  workspace: WorkspaceHandle;
  runtime: AgentRuntime;
  model: CapturingModel;
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-g18-runtime-${name}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  let sequence = 0;
  const now = () => new Date("2026-09-19T00:00:00.000Z");
  const idFactory = (prefix: string) => `${prefix}:g18:${name}:${String(++sequence).padStart(6, "0")}`;
  const dataDir = join(root, "data");
  const workspace = WorkspaceHandleSchema.parse({
    handle_id: `workspace:g18:${name}`,
    project_id: `project:g18:${name}`,
    real_root: await realpath(workspaceRoot),
    workspace_kind: "disposable_fixture",
    capabilities: { ...DISPOSABLE_FIXTURE_CAPABILITIES, index: false },
    created_at: now().toISOString(),
  });
  const model = new CapturingModel({ image_input: imageInput }, idFactory);
  const runtime = await createAgentRuntime({ dataDir, now, idFactory, model });
  return { dataDir, workspace, runtime, model };
}

class CapturingModel implements ModelAdapter {
  readonly name = "g18-capturing-model";
  readonly inputs: ModelInput[] = [];

  constructor(
    readonly declaredCapabilities: ModelCapabilities,
    readonly idFactory: (prefix: string) => string,
  ) {}

  capabilities(): ModelCapabilities {
    return this.declaredCapabilities;
  }

  async decide(input: ModelInput): Promise<unknown> {
    this.inputs.push(input);
    return DecisionSchema.parse({
      decision_id: this.idFactory("decision"),
      kind: "finish",
      public_reason: "The attachment contract was observed.",
      evidence_refs: [],
      risk: "none",
      final_answer: "done",
    });
  }
}

function startInput(workspace: WorkspaceHandle, uploadId: string) {
  return {
    command_id: `command:start:${uploadId}`,
    project_id: workspace.project_id,
    task: "Inspect the staged attachment.",
    mode: "execute" as const,
    workspace,
    attachment_upload_ids: [uploadId],
  };
}

async function waitForTerminal(runtime: AgentRuntime, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === "completed" || projection.status === "failed") return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal Run state");
}

function png(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

function oversizedPng(): Uint8Array {
  const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  bytes.set(png());
  return bytes;
}
