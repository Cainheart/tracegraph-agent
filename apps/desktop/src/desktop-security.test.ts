import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DesktopBridgeInputSchemas } from "./bridge-contract.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("Desktop renderer process boundary", () => {
  it("keeps Node and Electron imports out of the Renderer and shared Workbench source", async () => {
    const workbenchRoot = join(repositoryRoot, "packages/workbench/src");
    const rendererRoot = join(repositoryRoot, "apps/desktop/renderer");
    const files = [
      ...(await sourceFiles(workbenchRoot)),
      ...(await sourceFiles(rendererRoot)),
      join(sourceRoot, "desktop-sdk.ts"),
      join(sourceRoot, "renderer-bridge.ts"),
    ];

    for (const file of files.filter((candidate) => !candidate.endsWith(".test.ts") && !candidate.endsWith(".test.tsx"))) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/(?:from\s*|import\s*\()\s*["'](?:node:|electron(?:\/|["']))/u);
    }
  });

  it("keeps preload runtime imports self-contained and window security explicit", async () => {
    const preload = await readFile(join(sourceRoot, "preload.cts"), "utf8");
    const main = await readFile(join(sourceRoot, "main.ts"), "utf8");
    const runtimeImports = preload.split("\n").filter((line) => /^import\s+(?!type\b)/u.test(line));

    expect(runtimeImports).toEqual(['import { contextBridge, ipcRenderer } from "electron";']);
    expect(preload).not.toMatch(/ipcRenderer\.(?:send|on|once)\s*\(/u);
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("setWindowOpenHandler(() => ({ action: \"deny\" }))");
    expect(main).toContain("assertTrustedRenderer(event)");
  });

  it("rejects renderer-supplied native paths and keeps only named bridge methods", async () => {
    const preload = await readFile(join(sourceRoot, "preload.cts"), "utf8");
    const main = await readFile(join(sourceRoot, "main.ts"), "utf8");
    expect(() => DesktopBridgeInputSchemas.openLocalProject.parse({ access: "read_write", selected_path: "/tmp" })).toThrow();
    expect(() => DesktopBridgeInputSchemas.projectId.parse("")).toThrow();
    expect(preload).not.toContain("selected_path");
    expect(preload).toContain("openProjectFile:");
    expect(preload).toContain("configureModel:");
    expect(main).toContain('properties: ["openDirectory"]');
    expect(main).toContain('properties: ["openFile"]');
    expect(main).toContain("channel:(typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC]");
    expect(main).not.toMatch(/registerHandler\(\s*(?:input|request|event)\./u);
    expect(() => DesktopBridgeInputSchemas.writeTodo.parse({ run_id: "run:one", project_id: "project:other", input: { command_id: "command:one", input: { operation: "create", todo_id: "todo:one", title: "Check" } } })).toThrow();
    expect(() => DesktopBridgeInputSchemas.submitUserInput.parse({ run_id: "run:one", input: { command_id: "command:one", input_id: "input:one", kind: "message", body: "Check", actor: "parent_agent" } })).toThrow();
    expect(() => DesktopBridgeInputSchemas.getArtifact.parse({ run_id: "run:one", artifact_id: "artifact:one", path: "/tmp" })).toThrow();
    expect(() => DesktopBridgeInputSchemas.startChat.parse({ command_id: "command:chat", task: "Hello", project_id: "project:other" })).toThrow();
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}
