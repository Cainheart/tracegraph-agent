import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyInvariants } from "./verify-invariants.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_LEDGER = "export class JsonlEventLedger { append() {} }\n";
const VALID_PROJECTION = `
export function toWireEvent(event) {
  return WireSessionEventSchema.parse({
    data: redactStructuredValue(publicEventData(event.data)),
  });
}
function publicEventData(data) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith("_internal_")));
}
export function projectRun(events) { return events; }
`;

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "tracegraph-invariants-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages/evidence/src"), { recursive: true });
  await mkdir(path.join(root, "packages/core/src/domains/evidence"), { recursive: true });
  await mkdir(path.join(root, "packages/contracts/src"), { recursive: true });
  await writeFile(path.join(root, "packages/evidence/src/event-ledger.ts"), CANONICAL_LEDGER);
  await writeFile(path.join(root, "packages/evidence/src/projection.ts"), VALID_PROJECTION);
  await writeFile(path.join(root, "packages/core/src/domains/evidence/runtime-service.ts"),
    'import { JsonlEventLedger as EvidenceJsonlEventLedger } from "@tracegraph/evidence";\nexport class JsonlEventLedger extends EvidenceJsonlEventLedger {}\n');
  await writeFile(path.join(root, "packages/contracts/src/event.ts"), `export const WireSessionEventSchema = z.object({\n  type: z.string(),\n});\n`);
  return root;
}

test("current repository satisfies the Ledger, wire, and Projection invariants", async () => {
  const outcome = await verifyInvariants(REPOSITORY_ROOT);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.ok, true);
});

test("a second Event Ledger writer is rejected", async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, "apps/extra/src"), { recursive: true });
  await writeFile(path.join(root, "apps/extra/src/second-writer.ts"), "export class SecondEventLedger { append() {} }\n");
  const outcome = await verifyInvariants(root);
  assert.ok(outcome.errors.some(({ code }) => code === "INVARIANT_SECOND_LEDGER_WRITER"));
});

test("Core's compatibility adapter does not hide another writer in the same file", async (context) => {
  const root = await fixture(context);
  const adapterPath = path.join(root, "packages/core/src/domains/evidence/runtime-service.ts");
  const adapter = await readFile(adapterPath, "utf8");
  await writeFile(adapterPath, `${adapter}\nexport class DuplicateEventLedger { append() {} }\n`);
  const outcome = await verifyInvariants(root);
  assert.ok(outcome.errors.some(({ code }) => code === "INVARIANT_SECOND_LEDGER_WRITER"));
});

test("private fields copied to wire are rejected", async (context) => {
  const root = await fixture(context);
  const projectionPath = path.join(root, "packages/evidence/src/projection.ts");
  const projection = await readFile(projectionPath, "utf8");
  await writeFile(projectionPath, projection.replace("publicEventData(event.data)", "event.data"));
  const outcome = await verifyInvariants(root);
  assert.ok(outcome.errors.some(({ code }) => code === "INVARIANT_PRIVATE_EVENT_DATA_ON_WIRE"));
});

test("persistence-only envelope fields are rejected by the wire contract", async (context) => {
  const root = await fixture(context);
  const contractPath = path.join(root, "packages/contracts/src/event.ts");
  const contract = await readFile(contractPath, "utf8");
  await writeFile(contractPath, contract.replace("type: z.string(),", "event_hash: z.string(),\n  type: z.string(),"));
  const outcome = await verifyInvariants(root);
  assert.ok(outcome.errors.some(({ code }) => code === "INVARIANT_PRIVATE_ENVELOPE_FIELD_IN_WIRE_SCHEMA"));
});

test("I/O in Projection code is rejected", async (context) => {
  const root = await fixture(context);
  const projectionPath = path.join(root, "packages/evidence/src/projection.ts");
  const projection = await readFile(projectionPath, "utf8");
  await writeFile(projectionPath, `import { readFile } from "node:fs/promises";\n${projection}\nexport async function load() { return readFile("projection.json"); }\n`);
  const outcome = await verifyInvariants(root);
  assert.ok(outcome.errors.some(({ code }) => code === "INVARIANT_PROJECTION_IO_IMPORT"));
  assert.ok(outcome.errors.some(({ code }) => code === "INVARIANT_PROJECTION_IO_CALL"));
});

test("CI runs the invariant verifier", async () => {
  const workflow = await readFile(path.join(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.equal(hasInvariantCheck(workflow), true);
  assert.equal(hasInvariantCheck(workflow.replace(/^\s*- run: pnpm verify:invariants\s*$/mu, "")), false);
});

function hasInvariantCheck(workflow) {
  return /^\s*- run: pnpm verify:invariants\s*$/mu.test(workflow);
}
