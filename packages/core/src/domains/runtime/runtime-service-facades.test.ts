import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const RUNTIME_FACADES = [
  "../context/runtime-service.js",
  "../evidence/runtime-service.js",
  "../tools/runtime-service.js",
];

describe("Runtime service façades", () => {
  it("routes Context, Tool, and Evidence imports through their curated façades", async () => {
    const runtimeUrl = new URL("./runtime.ts", import.meta.url);
    const sourceText = await readFile(runtimeUrl, "utf8");
    const affectedDomainImports = [...sourceText.matchAll(
      /\bfrom\s+["'](\.\.\/(?:context|evidence|tools)\/[^"']+)["']/gu,
    )].map((match) => match[1]!);

    expect(affectedDomainImports.sort()).toEqual([...RUNTIME_FACADES].sort());
  });
});
