/** Verifies that a full acceptance receipt still matches its 24 real PNGs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "evidence"));
const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
assert.equal(report.task_id, "UX-086");
assert.equal(report.status, "passed");
assert.equal(report.cleanup.status, "passed");
assert.deepEqual(report.cleanup.errors, []);
assert.deepEqual(report.errors, []);
assert.equal(report.screenshots.length, 24);
assert.deepEqual(report.journeys.map((journey) => journey.surface).sort(), ["desktop", "web"]);

for (const surface of ["web", "desktop"]) {
  const journey = report.journeys.find((entry) => entry.surface === surface);
  const projection = JSON.parse(await readFile(join(directory, `${surface}-completed-projection.json`), "utf8"));
  assert.equal(projection.run_id, journey.task_run_id);
  assert.equal(projection.status, "completed");
  const tool = projection.timeline.find((event) => event.type === "tool.completed" && event.data.receipt?.tool_name === "search");
  assert.ok(tool, "Real search receipt is required");
  assert.equal(tool.data.receipt.business_status, "success");
  assert.ok(projection.timeline.some((event) => event.type === "patch.applied" && event.data.verified === true));
  const test = projection.timeline.find((event) => event.type === "test.completed");
  assert.ok(test, "Actual fixture test receipt is required");
  assert.equal(test.data.receipt.business_status, "success");
  assert.equal(test.data.receipt.code, "tests_passed");
  assert.ok(test.artifact_refs.some((artifact) => artifact.kind === "test_log"));
  for (const state of ["empty", "active-run", "tool-result", "change-review"]) {
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768]]) {
      const entries = report.screenshots.filter((entry) => entry.surface === surface && entry.state === state && entry.layout.width === width && entry.layout.height === height);
      assert.equal(entries.length, 1, `${surface}/${state}/${width}x${height} needs one receipt`);
      const entry = entries[0];
      assert.match(entry.file, /^(web|desktop)-(empty|active-run|tool-result|change-review)-(1440x900|1280x800|1024x768)\.png$/);
      assert.ok(entry.interactions.length > 0);
      assert.ok(entry.layout.documentWidth <= width + 1 && entry.layout.bodyWidth <= width + 1);
      assert.equal(entry.layout.readOnlyGate, false);
      assert.ok(entry.layout.enabledInputs > 0);
      if (state !== "empty") assert.equal(entry.run_id, journey.task_run_id);
      if (state === "active-run" || state === "tool-result") assert.ok(["indexing", "running"].includes(entry.status));
      if (state === "tool-result") assert.ok(entry.last_sequence >= tool.sequence);
      if (state === "change-review") assert.equal(entry.status, "completed");
      const bytes = await readFile(join(directory, entry.file));
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    }
  }
}
assert.ok(report.preview_boundary);
const preview = await readFile(join(directory, "desktop-preview-boundary.png"));
assert.equal(preview.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(preview.readUInt32BE(16), 1440); assert.equal(preview.readUInt32BE(20), 900);
process.stdout.write("UX-086 evidence verified: 2 live journeys, 24 dimension/hash/interaction receipts, separate Preview, cleanup passed.\n");
