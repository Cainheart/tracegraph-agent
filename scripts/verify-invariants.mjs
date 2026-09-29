import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_WRITER_PATH = "packages/core/src/domains/evidence/event-ledger.ts";
const PROJECTION_PATH = "packages/core/src/domains/evidence/projection.ts";
const WIRE_PRIVATE_FIELDS = ["attempt", "idempotency_key", "previous_event_hash", "event_hash"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".turbo", ".vite"]);

const asPosix = (value) => value.split(path.sep).join("/");

async function sourceFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) files.push(...await sourceFiles(file));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !/\.(?:test|spec)\.[^.]+$/u.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}

function add(errors, code, file, message) {
  errors.push({ code, file, message });
}

export async function verifyInvariants(root = DEFAULT_ROOT) {
  const repositoryRoot = path.resolve(root);
  const errors = [];
  const productionFiles = (await Promise.all(["apps", "packages"].map((area) => sourceFiles(path.join(repositoryRoot, area)))))
    .flat()
    .sort((a, b) => a.localeCompare(b));
  const normalizedSources = [];
  for (const file of productionFiles) {
    normalizedSources.push({
      path: asPosix(path.relative(repositoryRoot, file)),
      source: await readFile(file, "utf8"),
    });
  }

  verifySingleEventLedgerWriter(normalizedSources, errors);
  const projection = normalizedSources.find((item) => item.path === PROJECTION_PATH);
  if (!projection) {
    add(errors, "INVARIANT_PROJECTION_MISSING", PROJECTION_PATH, "Canonical Run Projection source was not found.");
  } else {
    verifyWireIsolation(projection, errors);
    verifyProjectionPurity(projection, errors);
  }
  const wireContract = normalizedSources.find((item) => item.path === "packages/contracts/src/event.ts");
  if (!wireContract) add(errors, "INVARIANT_WIRE_CONTRACT_MISSING", "packages/contracts/src/event.ts", "Wire event contract source was not found.");
  else verifyWireContract(wireContract, errors);

  return { ok: errors.length === 0, errors, sourceFileCount: normalizedSources.length };
}

function verifySingleEventLedgerWriter(sources, errors) {
  const canonical = sources.find((item) => item.path === LEDGER_WRITER_PATH);
  if (!canonical || !/\bclass\s+JsonlEventLedger\b/u.test(canonical.source)) {
    add(errors, "INVARIANT_LEDGER_WRITER_MISSING", LEDGER_WRITER_PATH, "Canonical JsonlEventLedger writer declaration was not found.");
  }
  for (const item of sources) {
    if (item.path === LEDGER_WRITER_PATH) continue;
    const declaration = /\bclass\s+([A-Za-z_$][\w$]*EventLedger)\b/u.exec(item.source);
    if (declaration) {
      add(errors, "INVARIANT_SECOND_LEDGER_WRITER", item.path, `Additional Event Ledger implementation ${declaration[1]} is declared outside ${LEDGER_WRITER_PATH}.`);
    }
  }
}

function verifyWireIsolation({ path: file, source }, errors) {
  const wireMapper = /^export function toWireEvent\b[\s\S]*?^[}]$/mu.exec(source)?.[0];
  if (!wireMapper || !/WireSessionEventSchema\.parse\s*\(/u.test(wireMapper)) {
    add(errors, "INVARIANT_WIRE_SCHEMA_MISSING", file, "toWireEvent must validate its output with WireSessionEventSchema.");
    return;
  }
  if (!/data\s*:\s*redactStructuredValue\s*\(\s*publicEventData\s*\(\s*event\.data\s*\)\s*\)/u.test(wireMapper)) {
    add(errors, "INVARIANT_PRIVATE_EVENT_DATA_ON_WIRE", file, "toWireEvent must filter private event data before it reaches the wire schema.");
  }
  if (/\.\.\.\s*event\b/u.test(wireMapper)) {
    add(errors, "INVARIANT_WIRE_EVENT_SPREAD", file, "toWireEvent must map public envelope fields explicitly instead of spreading the persisted event.");
  }
  for (const field of WIRE_PRIVATE_FIELDS) {
    if (new RegExp(`\\b${field}\\s*:\\s*event\\.${field}\\b`, "u").test(wireMapper)) {
      add(errors, "INVARIANT_PRIVATE_ENVELOPE_FIELD_ON_WIRE", file, `Persistence-only field ${field} must not be copied to WireSessionEvent.`);
    }
  }
  const privateFilter = /^function publicEventData\b[\s\S]*?^[}]$/mu.exec(source)?.[0];
  if (!privateFilter || !/filter\s*\(\s*\(\s*\[\s*key\s*\]\s*\)\s*=>\s*!key\.startsWith\s*\(\s*["']_internal_["']\s*\)\s*\)/u.test(privateFilter)) {
    add(errors, "INVARIANT_PRIVATE_DATA_FILTER_MISSING", file, "publicEventData must remove keys prefixed with _internal_.");
  }
}

function verifyWireContract({ path: file, source }, errors) {
  const schema = /export const WireSessionEventSchema\s*=\s*z\.object\(\{[\s\S]*?^\}\);/mu.exec(source)?.[0];
  if (!schema) {
    add(errors, "INVARIANT_WIRE_SCHEMA_MISSING", file, "WireSessionEventSchema declaration was not found.");
    return;
  }
  for (const field of WIRE_PRIVATE_FIELDS) {
    if (new RegExp(`^\\s*${field}\\s*:`, "mu").test(schema)) {
      add(errors, "INVARIANT_PRIVATE_ENVELOPE_FIELD_IN_WIRE_SCHEMA", file, `Persistence-only field ${field} must not be part of WireSessionEventSchema.`);
    }
  }
}

function verifyProjectionPurity({ path: file, source }, errors) {
  const forbiddenImports = /\bfrom\s*["'](?:node:)?(?:fs(?:\/promises)?|http|https|net|tls|dgram|dns|child_process|worker_threads)(?:\/[^"']*)?["']/u;
  if (forbiddenImports.test(source)) {
    add(errors, "INVARIANT_PROJECTION_IO_IMPORT", file, "Projection code must not import filesystem, network, process, or worker I/O modules.");
  }
  const forbiddenCalls = /\b(?:fetch|readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|open|openSync|rename|unlink|createReadStream|createWriteStream|setTimeout|setInterval)\s*\(/u;
  if (forbiddenCalls.test(source)) {
    add(errors, "INVARIANT_PROJECTION_IO_CALL", file, "Projection code must remain a pure in-memory transformation and cannot perform I/O or schedule work.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 0) throw new Error(`Unknown argument: ${args[0]}`);
    const outcome = await verifyInvariants();
    if (outcome.ok) {
      console.log(`Architecture invariants verified across ${outcome.sourceFileCount} source files.`);
    } else {
      for (const error of outcome.errors) console.error(`${error.code} ${error.file}: ${error.message}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
