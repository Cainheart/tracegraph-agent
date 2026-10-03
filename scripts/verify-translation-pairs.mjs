import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAIR_MANIFEST = "docs/i18n/pairs.yaml";
export const digest = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);

function inRoot(root, file) {
  if (typeof file !== "string" || !file || path.isAbsolute(file)) throw new Error("Expected a repository-relative path");
  const absolute = path.resolve(root, file);
  if (path.relative(root, absolute).startsWith("..")) throw new Error(`Path escapes repository: ${file}`);
  return absolute;
}

export function documentFingerprint(source, label) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  const metadata = frontmatter ? parse(frontmatter[1], { uniqueKeys: true, maxAliasCount: 100 }) : {};
  if (!record(metadata)) throw new Error(`${label}: frontmatter must be a mapping`);
  if (metadata.language !== undefined && !["en", "zh-CN"].includes(metadata.language)) throw new Error(`${label}: invalid language`);
  if (metadata.status !== undefined && !["current", "proposed", "implemented", "draft", "archived", "rejected", "deprecated"].includes(metadata.status)) throw new Error(`${label}: invalid status`);
  const body = source.slice(frontmatter?.[0].length ?? 0);
  const code = [];
  const withoutCode = body.replace(/^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1\s*$/gmu, (_, fence, language, value) => {
    code.push([language.trim(), value]);
    return "\nCODE_BLOCK\n";
  });
  const headings = [...withoutCode.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gmu)];
  const structure = [];
  for (const block of withoutCode.split(/\n\s*\n/u).filter((value) => value.trim())) {
    const lines = block.trim().split("\n");
    if (lines[0] === "CODE_BLOCK") structure.push("code");
    else if (/^#{1,6} /u.test(lines[0])) structure.push(...lines.filter((line) => /^#{1,6} /u.test(line)).map((line) => `h${/^#+/u.exec(line)[0].length}`));
    else if (lines.every((line) => /^\s*\|/u.test(line))) structure.push(`table:${lines.length}:${lines[0].split("|").length}`);
    else if (/^\s*(?:[-*+] |\d+[.)] )/u.test(lines[0])) structure.push(`list:${lines.filter((line) => /^\s*(?:[-*+] |\d+[.)] )/u.test(line)).length}`);
    else structure.push("paragraph");
  }
  const identifiers = [...withoutCode.matchAll(/`([^`\n]+)`/gu)].map((item) => item[1]).sort();
  const links = [...withoutCode.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/gu)].map((match) => match[1] ?? match[2]);
  for (const match of withoutCode.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gmu)) links.push(match[1] ?? match[2]);
  for (const match of withoutCode.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gu)) links.push(match[1]);
  const anchors = new Set();
  const counts = new Map();
  for (const [, , title] of headings) {
    const base = title.toLowerCase().replace(/<[^>]+>/gu, "").replace(/[^\p{L}\p{N}_\-\s]/gu, "").trim().replace(/\s/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of body.matchAll(/<(?:a|span)\s+(?:id|name)=["']([^"']+)["']/gu)) anchors.add(match[1]);
  return { metadata, structure, code, identifiers, links, anchors };
}

async function checkLinks(root, file, links, issues) {
  for (const link of links) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(link)) continue;
    try {
      const [pathname, anchor] = decodeURIComponent(link).split("#");
      const target = pathname ? path.normalize(path.join(path.dirname(file), pathname.split("?")[0])) : file;
      const absolute = inRoot(root, target);
      await stat(absolute);
      if (anchor && /\.md$/iu.test(target)) {
        const targetDocument = documentFingerprint(await readFile(absolute, "utf8"), target);
        if (!targetDocument.anchors.has(anchor)) throw new Error(`missing anchor #${anchor}`);
      }
    } catch (error) { issues.push(`${file}: broken local link ${link}: ${error.message}`); }
  }
}

async function normalizedLinks(root, file, links, canonicalPaths) {
  const pairedPaths = new Set([...canonicalPaths.keys(), ...canonicalPaths.values()]);
  return (await Promise.all(links.map(async (link) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(link)) return link;
    const [pathname, anchor] = decodeURIComponent(link).split("#");
    const target = pathname ? path.normalize(path.join(path.dirname(file), pathname)) : file;
    let normalizedAnchor = anchor;
    if (anchor && pairedPaths.has(target)) {
      try {
        const parsed = documentFingerprint(await readFile(inRoot(root, target), "utf8"), target);
        const index = [...parsed.anchors].indexOf(anchor);
        normalizedAnchor = index < 0 ? anchor : `section-${index}`;
      } catch { /* checkLinks supplies the actionable missing-target diagnostic. */ }
    }
    return `${canonicalPaths.get(target) ?? target}${normalizedAnchor ? `#${normalizedAnchor}` : ""}`;
  }))).sort();
}

export async function verifyTranslationPairs(root = ROOT, { requireReviewed = false } = {}) {
  const issues = [];
  let manifest;
  try { manifest = parse(await readFile(path.join(root, PAIR_MANIFEST), "utf8"), { uniqueKeys: true, maxAliasCount: 100 }); }
  catch (error) { return { issues: [`Invalid pair YAML: ${error.message}`], pairs: [], unregistered: [] }; }
  if (!record(manifest) || manifest.version !== 1 || (!Array.isArray(manifest.pairs) || manifest.pairs.length === 0)) return { issues: ["Pair manifest requires version: 1 and a non-empty pairs list"], pairs: [], unregistered: [] };
  const canonicalPaths = new Map();
  const seenIds = new Set();
  const seenFiles = new Set();
  for (const pair of manifest.pairs) {
    if (!record(pair) || !pair.id || seenIds.has(pair.id)) { issues.push("Missing or duplicate pair id"); continue; }
    seenIds.add(pair.id);
    for (const file of [pair.source, pair.translation]) {
      try { inRoot(root, file); } catch (error) { issues.push(`${pair.id}: ${error.message}`); }
      if (seenFiles.has(file)) issues.push(`${pair.id}: duplicate file ${file}`);
      seenFiles.add(file);
    }
    canonicalPaths.set(pair.translation, pair.source);
  }
  for (const pair of manifest.pairs) {
    if (!record(pair)) continue;
    try {
      if (!["draft", "reviewed", "legacy-unreviewed"].includes(pair.review_state)) throw new Error("review_state must be draft, reviewed or legacy-unreviewed");
      if (!["en", "zh-CN"].includes(pair.source_locale) || !["en", "zh-CN"].includes(pair.translation_locale) || pair.source_locale === pair.translation_locale) throw new Error("source and translation locales must differ and be supported");
      if (pair.review_state === "reviewed" && (typeof pair.reviewer !== "string" || !pair.reviewer.trim() || typeof pair.reviewed_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(pair.reviewed_at))) throw new Error("reviewed pair requires reviewer and reviewed_at evidence");
      if (requireReviewed && pair.review_state !== "reviewed") issues.push(`${pair.id}: human review pending`);
      const source = await readFile(inRoot(root, pair.source), "utf8");
      const translation = await readFile(inRoot(root, pair.translation), "utf8");
      if (pair.source_digest !== digest(source)) issues.push(`${pair.id}: source hash drift (translation is stale)`);
      if (pair.translation_digest !== digest(translation)) issues.push(`${pair.id}: translation hash drift`);
      const a = documentFingerprint(source, pair.source), b = documentFingerprint(translation, pair.translation);
      if (a.metadata.id !== undefined && b.metadata.id !== undefined && a.metadata.id !== b.metadata.id) issues.push(`${pair.id}: id metadata mismatch`);
      if (a.metadata.status !== undefined && b.metadata.status !== undefined && a.metadata.status !== b.metadata.status) issues.push(`${pair.id}: status metadata mismatch`);
      if (pair.review_state === "legacy-unreviewed") {
        for (const [label, value] of [["source", a], ["translation", b]]) {
          if (pair[`${label}_structure_digest`] !== structuralDigest(value)) issues.push(`${pair.id}: ${label} legacy structure drift`);
          if (pair[`${label}_metadata_digest`] !== digest(JSON.stringify(value.metadata))) issues.push(`${pair.id}: ${label} legacy metadata drift`);
          if (value.metadata.language !== undefined && value.metadata.language !== pair[`${label}_locale`]) issues.push(`${pair.id}: ${label} locale metadata drift`);
        }
      } else {
        if (a.metadata.language !== pair.source_locale || b.metadata.language !== pair.translation_locale) issues.push(`${pair.id}: locale metadata drift`);
        if (a.metadata.id !== pair.id || b.metadata.id !== pair.id || a.metadata.status !== b.metadata.status) issues.push(`${pair.id}: id/status metadata drift`);
        for (const property of ["structure", "code", "identifiers"]) if (!same(a[property], b[property])) issues.push(`${pair.id}: ${property} drift`);
        if (!same(await normalizedLinks(root, pair.source, a.links, canonicalPaths), await normalizedLinks(root, pair.translation, b.links, canonicalPaths))) issues.push(`${pair.id}: link target drift`);
      }
      await checkLinks(root, pair.source, a.links, issues);
      await checkLinks(root, pair.translation, b.links, issues);
    } catch (error) { issues.push(`${pair.id ?? "pair"}: ${error.message}`); }
  }
  const inventory = await translationPairInventory(root);
  const unregistered = inventory.map((pair) => pair.translation).filter((file) => !seenFiles.has(file));
  for (const file of unregistered) issues.push(`Unregistered bilingual file: ${file}; explicitly register a draft or legacy baseline`);
  return { issues, pairs: manifest.pairs, unregistered: unregistered.sort() };
}

export function structuralDigest(value) {
  return digest(JSON.stringify({ structure: value.structure, code: value.code, identifiers: value.identifiers }));
}

export async function translationPairInventory(root = ROOT) {
  const pairs = [];
  function add(file) {
    if (file.endsWith(".zh.md")) pairs.push({ source: file.replace(/\.zh\.md$/u, ".md"), translation: file });
    else if (file.endsWith(".en.md")) pairs.push({ source: file, translation: file.replace(/\.en\.md$/u, ".md") });
    else if (/^\.agents\/skills\/outlive-[^/]+-en\/SKILL\.md$/u.test(file)) pairs.push({ source: file, translation: file.replace(/-en\/SKILL\.md$/u, "-zh/SKILL.md") });
  }
  let gitRepository = false;
  try { await stat(path.join(root, ".git")); gitRepository = true; } catch { /* Standalone source/fixtures need no Git. */ }
  if (gitRepository) {
    // Honor source-control ignores: preview archives and runtime data are not documentation sources.
    const { stdout } = await promisify(execFile)("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    for (const file of new Set(stdout.split("\0").filter(Boolean))) {
      try { if ((await stat(path.join(root, file))).isFile()) add(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } else {
    async function walk(directory, relative = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (["node_modules", ".git", "dist", "coverage", ".pnpm", ".vite", ".tracegraph", ".agent-traces", "test-results", "playwright-report"].includes(entry.name) || entry.name.startsWith("_tmp_") || entry.isSymbolicLink()) continue;
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), file);
        else if (entry.isFile()) add(file);
      }
    }
    await walk(root);
  }
  return pairs.sort((a, b) => a.source.localeCompare(b.source, "en"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => !["--check", "--require-reviewed"].includes(arg))) throw new Error("Usage: node scripts/verify-translation-pairs.mjs [--check] [--require-reviewed]");
    const result = await verifyTranslationPairs(ROOT, { requireReviewed: process.argv.includes("--require-reviewed") });
    for (const issue of result.issues) console.error(issue);
    console.log(`${result.pairs.length} registered pairs (${result.pairs.filter((pair) => pair.review_state === "legacy-unreviewed").length} legacy-unreviewed); ${result.unregistered.length} unregistered; external links not checked.`);
    if (result.issues.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
