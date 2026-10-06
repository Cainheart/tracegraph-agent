import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { chromium } from "playwright-core";
import { z } from "zod";
import { discoverCurrentBundledRuntime } from "./composition/bundled-runtime.js";

const Manifest = z.object({ schema_version: z.literal("outlive.browser-runtime.v1"), platform: z.enum(["darwin", "win32"]), arch: z.enum(["arm64", "x64"]), playwright_version: z.literal("1.63.0"), executable: z.string().min(1).max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
/** Delivery paths only. Installed builds never use a user's browser or download on first run. */
export async function browserRuntimeForHost(): Promise<{ executablePath: string; runtimeKind: "bundled" | "development" }> {
  const runtime = await discoverCurrentBundledRuntime();
  if (!runtime) return { executablePath: chromium.executablePath(), runtimeKind: "development" };
  const root = join(runtime.runtimeDirectory, "browser"), path = join(root, "browser-manifest.json");
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) throw new Error("manifest");
    const manifest = Manifest.parse(JSON.parse(await readFile(path, "utf8")));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.executable.includes("\\") || manifest.executable.split("/").includes("..")) throw new Error("platform or path");
    const executablePath = join(root, manifest.executable), within = relative(root, executablePath);
    if (within.startsWith("..") || within === "") throw new Error("path");
    const executable = await lstat(executablePath); if (!executable.isFile() || executable.isSymbolicLink()) throw new Error("executable");
    if (createHash("sha256").update(await readFile(executablePath)).digest("hex") !== manifest.sha256) throw new Error("integrity");
    return { executablePath, runtimeKind: "bundled" };
  } catch { return { executablePath: join(root, "unavailable-browser-runtime"), runtimeKind: "bundled" }; }
}
