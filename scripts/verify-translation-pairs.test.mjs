import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { digest, verifyTranslationPairs } from "./verify-translation-pairs.mjs";
import { recordTranslationBaseline } from "./record-translation-baseline.mjs";

const en = "---\nid: guide\nlanguage: en\nstatus: current\n---\n\n# Guide\n\nUse `run.completed`. [Reference](reference.md#reference)\n\n## Usage\n\n```sh\nnode cli.mjs\n```\n";
const zh = "---\nid: guide\nlanguage: zh-CN\nstatus: current\n---\n\n# 指南\n\n使用 `run.completed`。[参考](reference.md#reference)\n\n## 用法\n\n```sh\nnode cli.mjs\n```\n";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "translation-pairs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs/i18n"), { recursive: true });
  await writeFile(path.join(root, "guide.md"), en);
  await writeFile(path.join(root, "guide.zh.md"), zh);
  await writeFile(path.join(root, "reference.md"), "# Reference\n\n## Another\n");
  const pair = { id: "guide", source: "guide.md", source_locale: "en", translation: "guide.zh.md", translation_locale: "zh-CN", source_digest: digest(en), translation_digest: digest(zh), review_state: "draft" };
  async function manifest() { await writeFile(path.join(root, "docs/i18n/pairs.yaml"), stringify({ version: 1, pairs: [pair] })); }
  await manifest();
  return { root, pair, manifest };
}

test("checks drafts without claiming human review and inventories unregistered pairs", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "legacy.zh.md"), "# 未审校\n");
  const before = await readFile(path.join(root, "guide.md"));
  const result = await verifyTranslationPairs(root);
  assert.match(result.issues.join("\n"), /Unregistered bilingual file: legacy.zh.md/u);
  assert.deepEqual(result.unregistered, ["legacy.zh.md"]);
  assert.deepEqual(await readFile(path.join(root, "guide.md")), before);
  assert.match((await verifyTranslationPairs(root, { requireReviewed: true })).issues.join("\n"), /human review pending/u);
});

test("rejects source and translation hash drift", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "guide.md"), en.replace("Guide", "Updated guide"));
  await writeFile(path.join(root, "guide.zh.md"), zh.replace("指南", "更新指南"));
  const issues = (await verifyTranslationPairs(root)).issues.join("\n");
  assert.match(issues, /source hash drift/u);
  assert.match(issues, /translation hash drift/u);
});

test("rejects structure, code and identifier drift even if hashes are refreshed", async (t) => {
  const { root, pair, manifest } = await fixture(t);
  const edited = zh.replace("## 用法", "### 用法").replace("node cli.mjs", "node old.mjs").replace("run.completed", "run.failed");
  await writeFile(path.join(root, "guide.zh.md"), edited);
  pair.translation_digest = digest(edited);
  await manifest();
  const issues = (await verifyTranslationPairs(root)).issues.join("\n");
  for (const code of ["structure drift", "code drift", "identifiers drift"]) assert.ok(issues.includes(code), issues);
});

test("rejects broken links, deleted anchors and changed valid targets", async (t) => {
  const { root, pair, manifest } = await fixture(t);
  await writeFile(path.join(root, "other.md"), "# Reference\n");
  const edited = zh.replace("reference.md#reference", "other.md#reference");
  await writeFile(path.join(root, "guide.zh.md"), edited);
  pair.translation_digest = digest(edited);
  await manifest();
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /link target drift/u);
  await writeFile(path.join(root, "reference.md"), "# Renamed\n");
  await rm(path.join(root, "other.md"));
  const issues = (await verifyTranslationPairs(root)).issues.join("\n");
  assert.match(issues, /missing anchor/u);
  assert.match(issues, /broken local link other.md/u);
});

test("rejects malformed YAML, duplicate IDs, invalid metadata and missing review evidence", async (t) => {
  const { root, pair, manifest } = await fixture(t);
  pair.review_state = "reviewed";
  await manifest();
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /requires reviewer/u);
  await writeFile(path.join(root, "docs/i18n/pairs.yaml"), "version: 1\nversion: 2\npairs: []\n");
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /Invalid pair YAML/u);
  await writeFile(path.join(root, "docs/i18n/pairs.yaml"), stringify({ version: 1, pairs: [pair, pair] }));
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /duplicate pair id/u);
  pair.review_state = "draft";
  await manifest();
  const edited = zh.replace("status: current", "status: invented");
  await writeFile(path.join(root, "guide.zh.md"), edited);
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /invalid status/u);
});


test("rejects drift to another existing anchor and supports paired translated headings", async (t) => {
  const { root, pair, manifest } = await fixture(t);
  let edited = zh.replace("reference.md#reference", "reference.md#another");
  await writeFile(path.join(root, "guide.zh.md"), edited);
  pair.translation_digest = digest(edited);
  await manifest();
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /link target drift/u);
  const pairedSource = en.replace("reference.md#reference", "#usage");
  edited = zh.replace("reference.md#reference", "#用法");
  await writeFile(path.join(root, "guide.md"), pairedSource);
  await writeFile(path.join(root, "guide.zh.md"), edited);
  pair.source_digest = digest(pairedSource);
  pair.translation_digest = digest(edited);
  await manifest();
  assert.deepEqual((await verifyTranslationPairs(root)).issues, []);
});


test("records all legacy pairs without certifying equivalence and rejects later hash/structure/metadata drift", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "legacy.md"), "---\nstatus: implemented\n---\n\n# Legacy\n\n## Extra section\n\nText.\n");
  await writeFile(path.join(root, "legacy.zh.md"), "---\nstatus: implemented\n---\n\n# 旧译文\n\n文本。\n");
  assert.deepEqual(await recordTranslationBaseline(root), ["legacy.md"]);
  assert.deepEqual((await verifyTranslationPairs(root)).issues, []);
  assert.match((await verifyTranslationPairs(root, { requireReviewed: true })).issues.join("\n"), /legacy.md: human review pending/u);
  const changed = "---\nstatus: proposed\n---\n\n## 旧译文\n\n文本。\n";
  await writeFile(path.join(root, "legacy.zh.md"), changed);
  const errors = (await verifyTranslationPairs(root)).issues.join("\n");
  assert.match(errors, /translation hash drift/u);
  assert.match(errors, /translation legacy structure drift/u);
  assert.match(errors, /translation legacy metadata drift/u);
  await recordTranslationBaseline(root);
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /translation hash drift/u);
  await recordTranslationBaseline(root, "legacy.md");
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /status metadata mismatch/u);
  await writeFile(path.join(root, "legacy.md"), "---\nstatus: proposed\n---\n\n# Legacy\n");
  await recordTranslationBaseline(root, "legacy.md");
  assert.deepEqual((await verifyTranslationPairs(root)).issues, []);
});

test("explicit refresh revokes old human review instead of silently preserving it", async (t) => {
  const { root, pair, manifest } = await fixture(t);
  pair.review_state = "reviewed";
  pair.reviewer = "Fixture reviewer";
  pair.reviewed_at = "2026-10-03";
  await manifest();
  assert.deepEqual((await verifyTranslationPairs(root, { requireReviewed: true })).issues, []);
  await recordTranslationBaseline(root, "guide.md");
  assert.match((await verifyTranslationPairs(root, { requireReviewed: true })).issues.join("\n"), /human review pending/u);
});


test("also discovers the repository English-source README.en.md and Chinese README.md convention", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "README.en.md"), "# Readme\n");
  await writeFile(path.join(root, "README.md"), "# 说明\n");
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /Unregistered bilingual file: README.md/u);
  assert.deepEqual(await recordTranslationBaseline(root), ["README.en.md"]);
  assert.deepEqual((await verifyTranslationPairs(root)).issues, []);
});


test("ignores generated preview archives while checking any explicitly tracked bilingual source", async (t) => {
  const { root } = await fixture(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, ".gitignore"), "_tmp_*\n");
  await mkdir(path.join(root, "_tmp_preview"));
  await writeFile(path.join(root, "_tmp_preview/README.en.md"), "# Preview copy\n");
  await writeFile(path.join(root, "_tmp_preview/README.md"), "# 预览副本\n");
  assert.deepEqual((await verifyTranslationPairs(root)).issues, []);
  execFileSync("git", ["add", "--force", "_tmp_preview/README.en.md", "_tmp_preview/README.md"], { cwd: root });
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /Unregistered bilingual file: _tmp_preview\/README.md/u);
});


test("registers existing parallel English and Chinese Outlive skill directories", async (t) => {
  const { root } = await fixture(t);
  for (const locale of ["en", "zh"]) {
    await mkdir(path.join(root, `.agents/skills/outlive-doc-sync-${locale}`), { recursive: true });
    await writeFile(path.join(root, `.agents/skills/outlive-doc-sync-${locale}/SKILL.md`), `# ${locale} workflow\n`);
  }
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /Unregistered bilingual file: .agents\/skills\/outlive-doc-sync-zh\/SKILL.md/u);
  assert.deepEqual(await recordTranslationBaseline(root), [".agents/skills/outlive-doc-sync-en/SKILL.md"]);
  assert.deepEqual((await verifyTranslationPairs(root)).issues, []);
  await writeFile(path.join(root, ".agents/skills/outlive-doc-sync-zh/SKILL.md"), "# changed\n");
  assert.match((await verifyTranslationPairs(root)).issues.join("\n"), /translation hash drift/u);
});
