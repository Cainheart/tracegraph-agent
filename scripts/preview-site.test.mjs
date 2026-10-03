import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startSitePreview } from "./preview-site.mjs";

test("serves only built versioned files on loopback with exact UTF-8 bytes", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "site-preview-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(path.join(output, "projection-manifest.json"), '{"base":"/0.1.0-alpha.0/"}');
  await writeFile(path.join(output, "index.html"), "<h1>规范文档</h1>");
  await writeFile(path.join(output, "source.txt"), "# 规范源文件\n");
  const { server, url } = await startSitePreview({ output, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(server.address().address, "127.0.0.1");
  assert.equal(await (await fetch(url)).text(), "<h1>规范文档</h1>");
  const source = await fetch(`${url}source.txt`);
  assert.equal(source.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await source.text(), "# 规范源文件\n");
  assert.equal((await fetch(`${url}missing.md`)).status, 404);
  assert.equal((await fetch(`${url}source.txt`, { method: "POST" })).status, 405);
});

test("refuses non-loopback hosts and traversal or symlink escapes", async (t) => {
  await assert.rejects(startSitePreview({ host: "0.0.0.0" }), /must be 127.0.0.1/u);
  const output = await mkdtemp(path.join(os.tmpdir(), "site-preview-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(path.join(output, "projection-manifest.json"), '{"base":"/0.1.0-alpha.0/"}');
  await symlink(process.cwd(), path.join(output, "outside"));
  const { server, url } = await startSitePreview({ output, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await fetch(`${url}outside/package.json`)).status, 404);
  assert.equal((await fetch(`${url}%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(new URL("/latest/", url))).status, 404);
});
