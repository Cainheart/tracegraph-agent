import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DesktopHostNodeUnavailableError, verifyStandaloneNodeExecutable } from "./node-executable.js";

const ManifestSchema = z.object({
  schema_version: z.literal("outlive.bundled-runtime.v1"),
  node_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  platform: z.enum(["darwin", "win32", "linux"]),
  arch: z.enum(["arm64", "x64"]),
  executable: z.enum(["bin/node", "node.exe"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  product_build_id: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export interface BundledRuntime { readonly executable: string; readonly runtimeDirectory: string; readonly productBuildId: string; }

/** Trusted delivery paths only: never accepts renderer, project, or model input. */
export async function resolveBundledRuntime(runtimeDirectory: string): Promise<BundledRuntime> {
  try {
    const directory = await realpath(resolve(runtimeDirectory));
    const manifestPath = join(directory, "runtime-manifest.json");
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error("manifest");
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.executable !== (process.platform === "win32" ? "node.exe" : "bin/node")) throw new Error("platform");
    const executable = join(directory, manifest.executable);
    const executableMetadata = await lstat(executable);
    if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink()) throw new Error("executable");
    const bytes = await readFile(executable);
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("integrity");
    const canonical = await verifyStandaloneNodeExecutable(executable, process.env, manifest.node_version);
    if (canonical !== executable) throw new Error("identity");
    // The executable's version is independently checked by the probe; pinned
    // manifest versions additionally describe the staged artifact inventory.
    return { executable: canonical, runtimeDirectory: directory, productBuildId: manifest.product_build_id };
  } catch {
    throw new DesktopHostNodeUnavailableError("Outlive setup unavailable: the bundled runtime is missing, damaged, or incompatible. Reinstall the application; external PATH runtimes are not used.");
  }
}

/** A bundled CLI is started by a fixed launcher; source Node has no manifest. */
export async function discoverCurrentBundledRuntime(): Promise<BundledRuntime | undefined> {
  if (process.versions.electron !== undefined) return undefined;
  const executable = await realpath(process.execPath);
  const directory = process.platform === "win32" ? dirname(executable) : dirname(dirname(executable));
  try { await lstat(join(directory, "runtime-manifest.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const runtime = await resolveBundledRuntime(directory);
  if (runtime.executable !== executable) throw new DesktopHostNodeUnavailableError("Outlive setup unavailable: the CLI runtime identity does not match its package.");
  return runtime;
}
