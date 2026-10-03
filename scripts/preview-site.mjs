import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon" };

/** Source-checkout preview only. Never binds a public interface. */
export async function startSitePreview({ output = path.join(ROOT, "docs/.vitepress/dist"), host = "127.0.0.1", port = 4173 } = {}) {
  if (host !== "127.0.0.1") throw new Error("Local preview host must be 127.0.0.1");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local preview port");
  const root = await realpath(output);
  const manifest = JSON.parse(await readFile(path.join(root, "projection-manifest.json"), "utf8"));
  if (!/^\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/$/u.test(manifest.base)) throw new Error("Invalid built site base");
  const server = createServer(async (request, response) => {
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const pathname = decodeURIComponent((request.url ?? "/").split("?")[0]);
      if (pathname === "/") { response.writeHead(302, { Location: manifest.base }); response.end(); return; }
      if (!pathname.startsWith(manifest.base) || pathname.includes("\\") || pathname.split("/").some((part) => part === ".." || part === ".")) throw new Error("Outside preview routes");
      let relative = pathname.slice(manifest.base.length);
      if (!relative || relative.endsWith("/")) relative += "index.html";
      const target = await realpath(path.join(root, relative));
      if (!target.startsWith(`${root}${path.sep}`) || !(await stat(target)).isFile()) throw new Error("Outside static output");
      const bytes = await readFile(target);
      response.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream", "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Page is not in this local documentation build.\n");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return { server, url: `http://${host}:${server.address().port}${manifest.base}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const name = args.shift(), value = args.shift();
      if (!["--host", "--port"].includes(name) || !value) throw new Error("Usage: node scripts/preview-site.mjs [--host 127.0.0.1] [--port 4173]");
      options[name.slice(2)] = name === "--port" ? Number(value) : value;
    }
    const { server, url } = await startSitePreview(options);
    console.log(`Local canonical preview: ${url}`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
