import { renderToStaticMarkup } from "react-dom/server";
import type { MemoryBackgroundJob } from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { MemoryBackgroundJobs } from "./MemoryBackgroundJobs";

const base: MemoryBackgroundJob = { runId: "run:one", projectId: "project:one", status: "retry", attempts: 2,
  candidateCount: 0, nextAttemptAt: "2026-10-03T01:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
  lastErrorCode: "memory_background_extraction_failed", resultDetailsAvailable: true, consolidationResults: [] };

describe("Memory background jobs surface", () => {
  it("marks cold-start history as incomplete instead of claiming no jobs", () => {
    const html = renderToStaticMarkup(<MemoryBackgroundJobs jobs={[]} items={[]} zh={false} loadingHistory />);
    expect(html).toContain("Restoring job history; the current list may be incomplete");
    expect(html).not.toContain("No background jobs in the visible projects.");
  });

  it("renders actual retry facts independently of an empty Memory record list", () => {
    const html = renderToStaticMarkup(<MemoryBackgroundJobs jobs={[base]} items={[]} zh={false} />);
    expect(html).toContain('aria-label="Memory background jobs"');
    for (const value of ["Retry pending", "2/5", base.nextAttemptAt!, base.lastErrorCode!, base.runId]) expect(html).toContain(value);
    expect(html).not.toContain("Processed (review still required)");
  });
  it("explains unchanged results and missing payloads without fabricating a diff", () => {
    const html = renderToStaticMarkup(<MemoryBackgroundJobs jobs={[{ ...base, status: "complete", consolidationResults: [{
      action: "unchanged", requestDigest: `sha256:${"a".repeat(64)}`, memoryId: "memory:retained", comparedMemoryIds: ["memory:retained"], sourceRunIds: ["run:one", "run:prior"],
    }] }]} items={[]} zh={false} />);
    expect(html).toContain("Exact match, unchanged");
    expect(html).toContain("run:prior");
    expect(html).toContain("Content is unavailable or deleted");
    expect(html).not.toContain("Compared record");
  });
  it("distinguishes unavailable Host support from a genuinely empty job list in both languages", () => {
    expect(renderToStaticMarkup(<MemoryBackgroundJobs jobs={undefined} items={[]} zh={false} />)).toContain("This Host does not provide job status.");
    expect(renderToStaticMarkup(<MemoryBackgroundJobs jobs={[]} items={[]} zh />)).toContain("当前可见项目暂无后台任务");
  });
});
