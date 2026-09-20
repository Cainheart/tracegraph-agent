import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EVAL_METRICS_DIR, EVAL_REPORT_PATH } from "./paths.js";

export default async function setupEvalWorkspace(): Promise<void> {
  await Promise.all([
    mkdir(EVAL_METRICS_DIR, { recursive: true }),
    mkdir(dirname(EVAL_REPORT_PATH), { recursive: true }),
  ]);
  // Truncate bounded regular metric files instead of recursively deleting the
  // directory. This prevents stale metrics in filtered runs while remaining
  // compatible with the repository's cumulative safe-delete guard.
  const entries = (await readdir(EVAL_METRICS_DIR)).filter((name) => name.endsWith(".json"));
  if (entries.length > 64) throw new Error("Eval metric directory exceeded its bounded file count");
  await Promise.all(entries.map(async (name) => {
    const path = `${EVAL_METRICS_DIR}/${name}`;
    const info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink()) await writeFile(path, "", "utf8");
  }));
}
