import {randomUUID} from "node:crypto";
import {mkdir,readdir,readFile,realpath,rm,writeFile} from "node:fs/promises";
import {basename,isAbsolute,join,relative,resolve} from "node:path";
import {createManagedWorkspaceHandle} from "@tracegraph/core";
import {ModelUsageReportSchema,UsageSnapshotSchema,type UsageSnapshot} from "@tracegraph/contracts";
import type {RegisteredProject} from "../webserver/index.js";
/** Build the settings usage view from the same durable event ledger consumed by
 * replay and recovery. Malformed/unknown lines are ignored so one damaged
 * historical file cannot make the settings page unavailable. */
export async function readUsageSnapshot(dataDir: string): Promise<UsageSnapshot> {
  const eventsRoot = join(dataDir, "events");
  let entries: readonly import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(eventsRoot, { withFileTypes: true });
  } catch {
    return UsageSnapshotSchema.parse({
      schema_version: "tracegraph.usage.v1",
      generated_at: new Date().toISOString(),
      source: "ledger",
      run_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      costs: [],
    });
  }

  const runIds = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  const costs = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = await readFile(join(eventsRoot, entry.name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object") continue;
      const record = event as Record<string, unknown>;
      if (record.type === "run.created" && typeof record.run_id === "string") {
        runIds.add(record.run_id);
      }
      if (record.type !== "model.usage_reported" || !record.data || typeof record.data !== "object") continue;
      const data = record.data as Record<string, unknown>;
      const parsed = ModelUsageReportSchema.safeParse({
        provider: data.provider,
        model: data.model,
        input_tokens: data.input_tokens,
        output_tokens: data.output_tokens,
        ...(data.cached_input_tokens === undefined ? {} : { cached_input_tokens: data.cached_input_tokens }),
        ...(data.reasoning_output_tokens === undefined ? {} : { reasoning_output_tokens: data.reasoning_output_tokens }),
        total_tokens: data.total_tokens,
        request_kind: data.request_kind,
        request_sequence: data.request_sequence,
        ...(data.provider_reported_cost === undefined ? {} : { provider_reported_cost: data.provider_reported_cost }),
      });
      if (!parsed.success) continue;
      const usage = parsed.data;
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
      cachedInputTokens += usage.cached_input_tokens ?? 0;
      reasoningOutputTokens += usage.reasoning_output_tokens ?? 0;
      totalTokens += usage.total_tokens;
      if (usage.provider_reported_cost) {
        const currency = usage.provider_reported_cost.currency;
        costs.set(currency, (costs.get(currency) ?? 0) + usage.provider_reported_cost.amount);
      }
    }
  }

  return UsageSnapshotSchema.parse({
    schema_version: "tracegraph.usage.v1",
    generated_at: new Date().toISOString(),
    source: "ledger",
    run_count: runIds.size,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: totalTokens,
    costs: [...costs.entries()].map(([currency, amount]) => ({ currency, amount })),
  });
}

/** Remove only a project created inside the Host's managed workspace root. */
export async function removeManagedProject(managedRoot: string, project: RegisteredProject): Promise<void> {
  const managedRootCanonical = await realpath(managedRoot);
  const projectRoot = await realpath(project.workspace.real_root);
  const relativeRoot = relative(managedRootCanonical, projectRoot);
  if (!relativeRoot || relativeRoot.startsWith("..") || isAbsolute(relativeRoot)) {
    throw Object.assign(new Error("Refusing to remove a project outside the Host managed workspace"), { statusCode: 403 });
  }
  await rm(projectRoot, { recursive: true, force: true });
}

export async function createManagedProject(managedRoot: string, name: string): Promise<RegisteredProject> {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40) || "project";
  const projectId = `project:${slug}:${randomUUID().slice(0, 8)}`;
  const root = resolve(managedRoot, `${slug}-${projectId.slice(-8)}`);
  await mkdir(resolve(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(resolve(root, ".tracegraph-project.json"), JSON.stringify({ project_id: projectId, label: name }, null, 2), { flag: "wx" }),
    writeFile(resolve(root, "README.md"), `# ${name}\n\nCreated and managed by TraceGraph.\n`, { flag: "wx" }),
    writeFile(resolve(root, "package.json"), `${JSON.stringify({ name: slug, version: "0.1.0", private: true, type: "module" }, null, 2)}\n`, { flag: "wx" }),
    writeFile(resolve(root, "src/index.ts"), `export function hello(): string {\n  return "Hello from ${name.replace(/["\\]/gu, "")}";\n}\n`, { flag: "wx" }),
  ]);
  return {
    label: name,
    workspace: await createManagedWorkspaceHandle({ projectId, root }),
    location: {
      kind: "managed_storage",
      display_path: root,
      can_reveal: true,
      access: "read_write",
    },
  };
}

export async function loadManagedProjects(managedRoot: string): Promise<RegisteredProject[]> {
  const entries = await readdir(managedRoot, { withFileTypes: true });
  const loaded: RegisteredProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = resolve(managedRoot, entry.name);
    try {
      const metadata = JSON.parse(await readFile(resolve(root, ".tracegraph-project.json"), "utf8")) as { project_id?: unknown; label?: unknown };
      if (typeof metadata.project_id !== "string" || typeof metadata.label !== "string") continue;
      loaded.push({
        label: metadata.label,
        workspace: await createManagedWorkspaceHandle({ projectId: metadata.project_id, root }),
        location: {
          kind: "managed_storage",
          display_path: root,
          can_reveal: true,
          access: "read_write",
        },
      });
    } catch {
      process.stderr.write(`Skipped invalid managed project metadata in ${basename(root)}\n`);
    }
  }
  return loaded;
}

