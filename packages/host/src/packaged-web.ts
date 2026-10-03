import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";

const MEDIA: Readonly<Record<string,string>> = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".woff":"font/woff", ".woff2":"font/woff2", ".ico":"image/x-icon" };

/** Seals a build-time-selected asset inventory before listening; no request path is opened. */
export async function registerPackagedWeb(app: FastifyInstance, assetRoot: string): Promise<void> {
  const root = await realpath(resolve(assetRoot));
  const files = new Map<string,{bytes:Buffer;media:string}>();
  async function inventory(directory: string): Promise<void> {
    for (const item of await readdir(directory,{withFileTypes:true})) {
      if (item.isSymbolicLink()) throw new Error("Packaged Web assets cannot contain symlinks");
      const path = join(directory,item.name);
      if (item.isDirectory()) { await inventory(path); continue; }
      if (!item.isFile()) throw new Error("Packaged Web asset must be a regular file");
      const extension = /\.[^.]+$/u.exec(item.name)?.[0];
      if (!extension || !MEDIA[extension]) continue;
      if ((await lstat(path)).size > 16 * 1024 * 1024 || files.size >= 512) throw new Error("Packaged Web asset inventory exceeds limits");
      const route = "/" + relative(root,path).split("\\").join("/");
      files.set(route,{bytes:await readFile(path),media:MEDIA[extension]});
    }
  }
  await inventory(root);
  const index = files.get("/index.html");
  if (!index) throw new Error("Packaged Web index is missing");
  files.set("/",index);
  for (const [route,file] of files) app.get(route,async (_request,reply)=>{
    reply.type(file.media).header("x-content-type-options","nosniff");
    reply.header("cache-control",route==="/" || route==="/index.html"?"no-store":"public, max-age=31536000, immutable");
    if (file.media.startsWith("text/html")) reply.header("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return reply.send(file.bytes);
  });
}
