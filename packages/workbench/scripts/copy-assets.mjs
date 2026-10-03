import { copyFile } from "node:fs/promises";

// Public package exports must be present in a compiled-only release bundle.
for (const name of ["styles.css", "workbench.css"]) {
  await copyFile(new URL(`../src/${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
}
