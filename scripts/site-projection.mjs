import { execFileSync } from "node:child_process";
import { readFile, readdir, realpath, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createMarkdownRenderer, disposeMdItInstance } from "vitepress";
import { digest, documentFingerprint } from "./verify-translation-pairs.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SITE_MANIFEST = "docs/site-pages.json";
const SLASH = (value) => value.split(path.sep).join("/");
const external = (value) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value);
let parser;

async function mermaidParser() {
  if (!parser) parser = (async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    return mermaid;
  })();
  return parser;
}

async function markdownFiles(root, directory = "docs") {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await markdownFiles(root, file));
    else if (entry.isFile() && file.endsWith(".md")) result.push(file.slice(5));
  }
  return result.sort();
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function pageRoute(file) {
  return file === "README.md" ? "index.html" : file.replace(/\.md$/u, ".html");
}

export function resolveDocLink(page, href) {
  if (external(href)) return null;
  const decoded = decodeURIComponent(href);
  const hash = decoded.indexOf("#");
  const anchor = hash < 0 ? "" : decoded.slice(hash + 1);
  const pathname = (hash < 0 ? decoded : decoded.slice(0, hash)).split("?")[0];
  const file = pathname ? SLASH(path.normalize(path.join("docs", path.dirname(page), pathname))) : `docs/${page}`;
  return { file, anchor, fragment: anchor ? `#${encodeURIComponent(anchor)}` : "" };
}

// Use the same installed VitePress parser as the site; regexes do not describe
// Markdown fence or heading semantics. Disable imports so parsing stays within
// the selected source bytes. Dispose its process-wide singleton before build.
async function markdownFacts(source, root) {
  const md = await createMarkdownRenderer(path.join(root, "docs"), { html: false, include: false, snippet: false, highlight: (text) => text });
  try {
    const tokens = md.parse(source, {});
    return {
      anchors: new Set(tokens.filter((token) => token.type === "heading_open").map((token) => token.attrGet("id"))),
      mermaid: tokens.filter((token) => token.type === "fence" && token.info.trim() === "mermaid").map((token) => token.content),
    };
  } finally { disposeMdItInstance(); }
}

export async function loadSiteProjection(root = ROOT, { validateMermaid = true } = {}) {
  const issues = [];
  const manifest = JSON.parse(await readFile(path.join(root, SITE_MANIFEST), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.schema_version !== 1 || manifest.mode !== "local-canonical-preview" || !Array.isArray(manifest.pages) || !manifest.pages.length) throw new Error("Invalid site page manifest");
  if (manifest.version !== packageJson.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) issues.push("Site version must equal the actual package version; aliases and invented versions are forbidden");
  const pairing = parse(await readFile(path.join(root, "docs/i18n/pairs.yaml"), "utf8"), { uniqueKeys: true, maxAliasCount: 100 });
  const translationFiles = new Set((pairing.pairs ?? []).map((pair) => pair.translation));
  const selected = new Set();
  const pages = [];
  let mermaidBlocks = 0;
  let localLinks = 0;
  let repositoryReferences = 0;
  for (const entry of manifest.pages) {
    if (!entry || typeof entry.path !== "string" || !entry.path.endsWith(".md") || path.isAbsolute(entry.path) || entry.path !== path.posix.normalize(entry.path) || entry.path.split("/").includes("..") || entry.path.includes("\\") || !within(path.join(root, "docs"), path.resolve(root, "docs", entry.path))) { issues.push("Selected page must be a relative Markdown path inside docs"); continue; }
    if (selected.has(entry.path)) issues.push(`Duplicate selected page: ${entry.path}`);
    selected.add(entry.path);
    if (!['en', 'zh-CN', 'mul'].includes(entry.locale) || !['current', 'proposed'].includes(entry.status) || typeof entry.title !== "string" || !entry.title.trim()) issues.push(`${entry.path}: missing or invalid locale/status/title`);
    if (/^outlive-agent-v2\/08-reference-lineage\//u.test(entry.path) || /(?:^|\/)\.agents\//u.test(entry.path) || /\.zh(?:-CN)?\.md$/u.test(entry.path) || translationFiles.has(`docs/${entry.path}`)) issues.push(`${entry.path}: internal material or translation is outside canonical-only publication scope`);
    const absolute = path.join(root, "docs", entry.path);
    let source;
    try {
      if (await realpath(absolute) !== path.join(await realpath(path.join(root, "docs")), entry.path)) throw new Error("symlink sources or directories are forbidden");
      source = await readFile(absolute, "utf8");
    } catch (error) { issues.push(`${entry.path}: missing or invalid source: ${error.message}`); continue; }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source);
    let metadata = {};
    try { metadata = front ? parse(front[1], { uniqueKeys: true, maxAliasCount: 100 }) : {}; }
    catch (error) { issues.push(`${entry.path}: invalid YAML: ${error.message}`); }
    if (metadata.status !== undefined && metadata.status !== entry.status) issues.push(`${entry.path}: status contradicts canonical frontmatter`);
    if (metadata.language !== undefined && metadata.language !== entry.locale) issues.push(`${entry.path}: locale contradicts canonical frontmatter`);
    if (/<!--\s*@include\s*:/iu.test(source) || /^\s*<<</mu.test(source)) issues.push(`${entry.path}: include/snippet directives are forbidden in a canonical source projection`);
    const facts = await markdownFacts(source, root);
    for (const diagram of facts.mermaid) {
      mermaidBlocks += 1;
      if (validateMermaid) {
        try { await (await mermaidParser()).parse(diagram); }
        catch (error) { issues.push(`${entry.path}: invalid Mermaid block ${mermaidBlocks}: ${error.message}`); }
      }
    }
    pages.push({ ...entry, source, route: pageRoute(entry.path), source_path: `docs/${entry.path}`, source_digest: digest(source), source_download: `sources/${entry.path}.txt`, source_view: `sources/${entry.path}.html` });
  }
  if (!selected.has("README.md")) issues.push("The canonical docs/README.md index must be selected");
  for (const page of pages) {
    // Links are validated against the working-tree source, including repository-only references.
    const body = documentFingerprint(page.source, page.path);
    for (const href of body.links) {
      if (external(href)) continue;
      localLinks += 1;
      try {
        const target = resolveDocLink(page.path, href);
        const absolute = path.resolve(root, target.file);
        if (!within(root, absolute)) throw new Error("link escapes repository");
        const targetStat = await stat(absolute);
        if (target.anchor && target.file.endsWith(".md")) {
          const targetSource = await readFile(absolute, "utf8");
          const targetBody = target.file.startsWith("docs/") && selected.has(target.file.slice(5)) ? await markdownFacts(targetSource, root) : documentFingerprint(targetSource, target.file);
          if (!targetBody.anchors.has(target.anchor)) throw new Error(`missing anchor #${target.anchor}`);
        }
        if (!target.file.startsWith("docs/") || !selected.has(target.file.slice(5)) || !targetStat.isFile()) repositoryReferences += 1;
      } catch (error) { issues.push(`${page.path}: broken local link ${href}: ${error.message}`); }
    }
  }
  if (issues.length) throw new Error(`Site projection checks failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  let commit = null, dirty = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  } catch { /* Extracted source is allowed, but must not invent Git identity. */ }
  const allFiles = await markdownFiles(root);
  return { version: manifest.version, base: `/${manifest.version}/`, mode: manifest.mode, pages, translationFiles, excludedPages: allFiles.filter((file) => !selected.has(file)), sourceCommit: commit, dirty, checks: { selectedPages: pages.length, localLinks, repositoryReferences, mermaidBlocks, externalLinks: "not-checked" } };
}

export function siteSnapshot(projection) {
  return { schema_version: 1, version: projection.version, mode: projection.mode, base: projection.base, source_commit: projection.sourceCommit, working_tree_dirty: projection.dirty, checks: projection.checks, excluded_pages: projection.excludedPages, pages: projection.pages.map(({ source, ...page }) => page) };
}

/** Generated artifacts only. Canonical Markdown is never rewritten or copied to another source tree. */
export async function writeSiteSourceArtifacts(projection, output) {
  for (const page of projection.pages) {
    const target = path.join(output, page.source_download);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, page.source);
    const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    // A generated UTF-8 viewer avoids browsers guessing a legacy encoding for
    // raw text/plain. The download retains the exact canonical bytes.
    await writeFile(path.join(output, page.source_view), `<!doctype html><html lang="${page.locale === "mul" ? "en" : page.locale}"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width"><title>Source: ${escape(page.source_path)}</title><style>body{margin:2rem;font:16px system-ui;line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{overflow-wrap:anywhere}</style></head><body><h1>Exact canonical Markdown source</h1><p>${escape(page.source_path)}</p><p><code>${page.source_digest}</code></p><p><a href="${encodeURIComponent(path.basename(page.source_download))}" download>Download exact UTF-8 bytes</a></p><pre>${escape(page.source)}</pre></body></html>\n`);
  }
  await writeFile(path.join(output, "projection-manifest.json"), `${JSON.stringify(siteSnapshot(projection), null, 2)}\n`);
}

export function rewriteSiteLink(projection, pagePath, href) {
  const target = resolveDocLink(pagePath, href);
  if (!target) return { href };
  if (projection.translationFiles.has(target.file) || /\.zh(?:-CN)?\.md$/u.test(target.file)) return { excluded: true, reason: "Translation is not published in this canonical-only preview" };
  if (target.file.startsWith(".agents/") || target.file.startsWith("docs/outlive-agent-v2/08-reference-lineage/")) return { excluded: true, reason: "Internal reference is outside this local site projection" };
  const selected = projection.pages.find((page) => `docs/${page.path}` === target.file);
  if (selected) return { href: `/${selected.route}${target.fragment}` };
  const encoded = target.file.split("/").map(encodeURIComponent).join("/");
  const ref = projection.sourceCommit ?? "main";
  return { href: `https://github.com/Cainheart/tracegraph-agent/blob/${ref}/${encoded}${target.fragment}`, repositoryOnly: true, reason: "Repository reference; uncommitted working-tree changes may differ from this remote revision; remote availability is not verified" };
}
