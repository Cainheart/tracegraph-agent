import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digest } from "./verify-translation-pairs.mjs";
import { loadSiteProjection, rewriteSiteLink, siteSnapshot, writeSiteSourceArtifacts } from "./site-projection.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canonical-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs/i18n"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"version":"0.1.0-alpha.0"}');
  const manifest = { schema_version: 1, mode: "local-canonical-preview", version: "0.1.0-alpha.0", pages: [
    { path: "README.md", title: "Guide", locale: "en", status: "current", kind: "index" },
    { path: "other.md", title: "Design", locale: "en", status: "proposed", kind: "design" },
  ] };
  const source = "---\nstatus: current\nlanguage: en\n---\n\n# Guide\n\n[Design](other.md#details)\n\n```mermaid\nflowchart LR\n A[Start] --> B[End]\n```\n";
  await writeFile(path.join(root, "docs/README.md"), source);
  await writeFile(path.join(root, "docs/other.md"), "---\nstatus: proposed\nlanguage: en\n---\n\n# Design\n\n## Details\n");
  await writeFile(path.join(root, "docs/unreviewed.md"), "# 旧译文\n");
  await writeFile(path.join(root, "docs/i18n/pairs.yaml"), "version: 1\npairs:\n  - {source: docs/README.md, translation: docs/unreviewed.md, review_state: legacy-unreviewed}\n");
  async function save() { await writeFile(path.join(root, "docs/site-pages.json"), JSON.stringify(manifest)); }
  await save();
  return { root, manifest, save, source };
}

test("validates real Mermaid and emits exact, deterministic source artifacts without changing canonical files", async (t) => {
  const { root, source } = await fixture(t);
  const projection = await loadSiteProjection(root);
  assert.equal(projection.checks.mermaidBlocks, 1);
  assert.equal(projection.checks.localLinks, 1);
  assert.deepEqual(projection.excludedPages, ["unreviewed.md"]);
  assert.deepEqual(siteSnapshot(await loadSiteProjection(root)), siteSnapshot(projection));
  const out = path.join(root, "output");
  await writeSiteSourceArtifacts(projection, out);
  const bytes = await readFile(path.join(out, "sources/README.md.txt"), "utf8");
  assert.equal(bytes, source);
  const viewer = await readFile(path.join(out, "sources/README.md.html"), "utf8");
  assert.match(viewer, /<meta charset="utf-8">/u);
  assert.match(viewer, /Download exact UTF-8 bytes/u);
  assert.ok(viewer.includes(projection.pages[0].source_digest));
  assert.equal(digest(bytes), projection.pages[0].source_digest);
  assert.equal(await readFile(path.join(root, "docs/README.md"), "utf8"), source);
  assert.equal(JSON.parse(await readFile(path.join(out, "projection-manifest.json"), "utf8")).version, "0.1.0-alpha.0");
});

test("fails missing local targets and existing files with missing anchors", async (t) => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(root, "docs/README.md"), source.replace("#details", "#missing"));
  await assert.rejects(loadSiteProjection(root), /missing anchor #missing/u);
  await rm(path.join(root, "docs/other.md"));
  await assert.rejects(loadSiteProjection(root), /missing or invalid source/u);
});

test("fails unknown versions and status/locale contradictions", async (t) => {
  const { root, manifest, save } = await fixture(t);
  manifest.version = "latest";
  await save();
  await assert.rejects(loadSiteProjection(root), /actual package version/u);
  manifest.version = "0.1.0-alpha.0";
  manifest.pages[1].status = "current";
  manifest.pages[1].locale = "zh-CN";
  await save();
  await assert.rejects(loadSiteProjection(root), (error) => /status contradicts/u.test(error.message) && /locale contradicts/u.test(error.message));
});

test("fails malformed Mermaid via its real parser", async (t) => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(root, "docs/README.md"), source.replace("A[Start] --> B[End]", "A --> ["));
  await assert.rejects(loadSiteProjection(root), /invalid Mermaid/u);
});

test("rejects translated/internal/escaping pages instead of publishing them with a draft badge", async (t) => {
  const { root, manifest, save } = await fixture(t);
  manifest.pages.push({ path: "unreviewed.md", title: "Draft translation", locale: "zh-CN", status: "current" });
  await save();
  await assert.rejects(loadSiteProjection(root), /outside canonical-only publication scope/u);
  manifest.pages.pop();
  manifest.pages.push({ path: "../outside.md", title: "Escape", locale: "en", status: "current" });
  await save();
  await assert.rejects(loadSiteProjection(root), /relative Markdown path inside docs/u);
  manifest.pages.pop();
  await mkdir(path.join(root, "docs/outlive-agent-v2/08-reference-lineage"), { recursive: true });
  await writeFile(path.join(root, "docs/outlive-agent-v2/08-reference-lineage/private.md"), "# Internal\n");
  manifest.pages.push({ path: "outlive-agent-v2/08-reference-lineage/private.md", title: "Internal", locale: "en", status: "current" });
  await save();
  await assert.rejects(loadSiteProjection(root), /outside canonical-only publication scope/u);
});

test("rewrites selected routes without double base prefixes and withholds excluded translations/internal notes", async (t) => {
  const { root } = await fixture(t);
  const projection = await loadSiteProjection(root);
  assert.equal(rewriteSiteLink(projection, "README.md", "other.md#details").href, "/other.html#details");
  assert.equal(rewriteSiteLink(projection, "README.md", "unreviewed.md").excluded, true);
  assert.equal(rewriteSiteLink(projection, "README.md", "../.agents/notes/internal.md").excluded, true);
  const repository = rewriteSiteLink(projection, "README.md", "../packages/sdk/src/index.ts");
  assert.equal(repository.repositoryOnly, true);
  assert.match(repository.reason, /uncommitted/u);
});


test("validates every supported Mermaid fence, including tildes, long fences and indentation", async (t) => {
  const { root, source } = await fixture(t);
  for (const fence of ["~~~", "````", "  ```"]) {
    const candidate = source.replaceAll("```", fence);
    await writeFile(path.join(root, "docs/README.md"), candidate);
    assert.equal((await loadSiteProjection(root)).checks.mermaidBlocks, 1);
    await writeFile(path.join(root, "docs/README.md"), candidate.replace("A[Start] --> B[End]", "A --> ["));
    await assert.rejects(loadSiteProjection(root), /invalid Mermaid/u);
  }
});

test("checks heading anchors against actual VitePress punctuation and duplicate semantics", async (t) => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(root, "docs/other.md"), "# Design\n\n## Foo/Bar\n\n## Foo/Bar\n");
  await writeFile(path.join(root, "docs/README.md"), source.replace("#details", "#foobar"));
  await assert.rejects(loadSiteProjection(root), /missing anchor #foobar/u);
  await writeFile(path.join(root, "docs/README.md"), source.replace("#details", "#foo-bar"));
  await loadSiteProjection(root);
  await writeFile(path.join(root, "docs/README.md"), source.replace("#details", "#foo-bar-1"));
  await loadSiteProjection(root);
});

test("rejects includes and snippets so excluded content cannot bypass the source allowlist", async (t) => {
  const { root, source } = await fixture(t);
  for (const directive of ["<!--@include: ./unreviewed.md-->", "<<< ./unreviewed.md"]) {
    await writeFile(path.join(root, "docs/README.md"), `${source}\n${directive}\n`);
    await assert.rejects(loadSiteProjection(root), /include\/snippet directives are forbidden/u);
  }
});

test("rejects noncanonical paths and symlink aliases of translations or internal directories", async (t) => {
  const { root, manifest, save } = await fixture(t);
  for (const alias of ["./unreviewed.md", "../docs/unreviewed.md"]) {
    manifest.pages.push({ path: alias, title: "Alias", locale: "en", status: "current" });
    await save();
    await assert.rejects(loadSiteProjection(root), /relative Markdown path inside docs/u);
    manifest.pages.pop();
  }
  await symlink(path.join(root, "docs/unreviewed.md"), path.join(root, "docs/alias.md"));
  manifest.pages.push({ path: "alias.md", title: "Alias", locale: "en", status: "current" });
  await save();
  await assert.rejects(loadSiteProjection(root), /symlink sources or directories are forbidden/u);
  manifest.pages.pop();
  await mkdir(path.join(root, "docs/internal"));
  await writeFile(path.join(root, "docs/internal/secret.md"), "# Private\n");
  await symlink(path.join(root, "docs/internal"), path.join(root, "docs/alias-directory"));
  manifest.pages.push({ path: "alias-directory/secret.md", title: "Alias", locale: "en", status: "current" });
  await save();
  await assert.rejects(loadSiteProjection(root), /symlink sources or directories are forbidden/u);
});
