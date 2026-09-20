import nodePath from "node:path";

import { sha256 } from "./hash.js";

export function toWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  const relative = nodePath.relative(workspaceRoot, absolutePath);
  return normalizeWorkspacePath(relative || ".");
}

export function normalizeWorkspacePath(value: string): string {
  return value.split(nodePath.sep).join("/");
}

export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relative = nodePath.relative(workspaceRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${nodePath.sep}`) && relative !== ".." && !nodePath.isAbsolute(relative))
  );
}

export function fileNodeId(workspacePath: string): string {
  return pathNodeId("file", workspacePath);
}

export function directoryNodeId(workspacePath: string): string {
  return pathNodeId("directory", workspacePath);
}

export function moduleNodeId(moduleName: string, sourcePath?: string): string {
  const scope = sourcePath === undefined ? moduleName : `${sourcePath}:${moduleName}`;
  return `module:${sha256(scope)}`;
}

/**
 * Declaration identities intentionally use a lexical ordinal rather than a
 * source position: formatting-only line shifts must not look like a removed
 * and added symbol in a graph delta.
 */
export function symbolNodeId(
  workspacePath: string,
  declarationKind: string,
  symbolName: string,
  ordinal: number,
): string {
  const scope = `${normalizeWorkspacePath(workspacePath)}:${declarationKind}:${symbolName}:${ordinal}`;
  return `symbol:${sha256(scope)}`;
}

function pathNodeId(kind: "file" | "directory", workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  const readable = `${kind}:${normalized}`;
  return readable.length <= 160 ? readable : `${kind}:${sha256(normalized)}`;
}
