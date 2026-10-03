import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { PAIR_MANIFEST, digest, documentFingerprint, structuralDigest, translationPairInventory } from "./verify-translation-pairs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Explicit registration is a mechanical baseline, never human translation certification. */
export async function recordTranslationBaseline(root = ROOT, refreshSource) {
  const manifestFile = path.join(root, PAIR_MANIFEST);
  const manifest = parse(await readFile(manifestFile, "utf8"), { uniqueKeys: true, maxAliasCount: 100 });
  const inventory = await translationPairInventory(root);
  const known = new Map(manifest.pairs.map((pair) => [pair.source, pair]));
  if (refreshSource && !known.has(refreshSource)) throw new Error(`Cannot refresh unregistered source: ${refreshSource}`);
  const changed = [];
  for (const item of inventory) {
    const existing = known.get(item.source);
    if (existing && item.source !== refreshSource) continue;
    if (refreshSource && item.source !== refreshSource) continue;
    const a = await readFile(path.join(root, item.source), "utf8"), b = await readFile(path.join(root, item.translation), "utf8");
    const source = documentFingerprint(a, item.source), translation = documentFingerprint(b, item.translation);
    const pair = existing ?? { id: `legacy:${item.source}`, ...item, source_locale: source.metadata.language ?? "en", translation_locale: translation.metadata.language ?? "zh-CN", review_state: "legacy-unreviewed" };
    if (pair.review_state === "reviewed") {
      // Changing either document invalidates human review, even when a maintainer refreshes fingerprints.
      pair.review_state = "draft";
      delete pair.reviewer;
      delete pair.reviewed_at;
    }
    pair.source_digest = digest(a);
    pair.translation_digest = digest(b);
    if (pair.review_state === "legacy-unreviewed") {
      pair.source_structure_digest = structuralDigest(source);
      pair.translation_structure_digest = structuralDigest(translation);
      pair.source_metadata_digest = digest(JSON.stringify(source.metadata));
      pair.translation_metadata_digest = digest(JSON.stringify(translation.metadata));
    }
    if (!existing) manifest.pairs.push(pair);
    changed.push(item.source);
  }
  manifest.pairs.sort((a, b) => a.source.localeCompare(b.source, "en"));
  if (changed.length) await writeFile(manifestFile, stringify(manifest, { lineWidth: 0 }));
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!((args.length === 1 && args[0] === "--register-unreviewed") || (args.length === 3 && args[0] === "--refresh" && args[2] === "--acknowledge-unreviewed"))) throw new Error("Usage: node scripts/record-translation-baseline.mjs --register-unreviewed | --refresh <source-path> --acknowledge-unreviewed");
    const changed = await recordTranslationBaseline(ROOT, args[0] === "--refresh" ? args[1] : undefined);
    console.log(`Explicitly recorded ${changed.length} source/translation fingerprints. This does not certify human review.\n${changed.join("\n")}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
