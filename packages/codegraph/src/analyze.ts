import { constants as fsConstants, promises as fs } from "node:fs";
import nodePath from "node:path";
import { performance } from "node:perf_hooks";

import { GraphSnapshotSchema } from "@tracegraph/contracts";
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportExpression,
  isIdentifier,
  isStringLiteralLikeNode,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { API as TypeScriptApi } from "typescript/unstable/sync";

import { sha256, stableJson } from "./hash.js";
import {
  directoryNodeId,
  fileNodeId,
  isInsideWorkspace,
  moduleNodeId,
  normalizeWorkspacePath,
  toWorkspacePath,
} from "./path.js";
import type {
  AnalyzeCodeGraphOptions,
  CodeGraphAnalysis,
  CodeGraphAnalysisFailureCode,
  CodeGraphDiagnostic,
  GraphConfidence,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphResolution,
} from "./types.js";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".d.mts",
  ".cts",
  ".d.cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_DEADLINE_MS = 30_000;

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

interface SourceRecord {
  readonly absolutePath: string;
  readonly workspacePath: string;
  readonly content: string;
}

interface StaticReference {
  readonly kind: GraphEdgeKind;
  readonly specifier: string;
  readonly line: number;
  readonly conservative?: boolean;
}

interface ResolvedTarget {
  readonly node: GraphNode;
  readonly confidence: GraphConfidence;
  readonly resolution: GraphResolution;
}

interface RelativeModuleResolution {
  readonly record: SourceRecord;
  readonly ambiguous: boolean;
}

interface AnalysisGuard {
  readonly signal?: AbortSignal;
  readonly deadline: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
}

export class CodeGraphAnalysisError extends Error {
  constructor(
    readonly code: CodeGraphAnalysisFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeGraphAnalysisError";
  }
}

export async function analyzeCodeGraph(
  options: AnalyzeCodeGraphOptions,
): Promise<CodeGraphAnalysis> {
  const guard = createAnalysisGuard(options);
  assertAnalysisActive(guard, "before workspace validation");
  const workspaceRoot = await canonicalWorkspaceRoot(options.workspace_root);
  assertAnalysisActive(guard, "after workspace validation");
  const createdAt = validateCreatedAt(options.created_at);
  const diagnostics: CodeGraphDiagnostic[] = [];
  const excludedDirectories = new Set([
    ...DEFAULT_EXCLUDED_DIRECTORIES,
    ...(options.exclude_directories ?? []),
  ]);
  const absoluteFiles = await discoverSourceFiles(workspaceRoot, excludedDirectories, guard);
  const records = await readSourceRecords(workspaceRoot, absoluteFiles, diagnostics, guard);
  if (absoluteFiles.length > 0 && records.length === 0) {
    throw new CodeGraphAnalysisError(
      "analysis_no_readable_files",
      "CodeGraph could not safely read any discovered source file",
    );
  }
  const recordsByAbsolutePath = new Map(
    records.map((record) => [canonicalPath(record.absolutePath), record]),
  );

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  addDirectoryNodes(nodes, records.map((record) => record.workspacePath));

  for (const record of records) {
    const sourceNode: GraphNode = {
      id: fileNodeId(record.workspacePath),
      kind: "file",
      label: nodePath.posix.basename(record.workspacePath),
      file_path: record.workspacePath,
      line: 1,
      content_hash: sha256(record.content),
    };
    nodes.set(sourceNode.id, sourceNode);
  }

  let skippedDynamicImportCount = 0;
  let skippedCommonJsRequireCount = 0;
  let unresolvedStaticEdgeCount = 0;
  let partialStaticEdgeCount = 0;
  let parsedFileCount = 0;

  if (records.length > 0) {
    const compiler = new TypeScriptApi({ cwd: workspaceRoot });
    let compilerSnapshot: ReturnType<TypeScriptApi["updateSnapshot"]> | undefined;
    try {
      assertAnalysisActive(guard, "before TypeScript analysis");
      const configuredProject = await resolveConfiguredProject(
        workspaceRoot,
        options.tsconfig_path,
      );
      compilerSnapshot = compiler.updateSnapshot({
        openFiles: records.map(({ absolutePath }) => absolutePath),
        ...(configuredProject === undefined
          ? {}
          : { openProjects: [configuredProject] }),
      });
      assertAnalysisActive(guard, "after TypeScript project loading");
      const projectsWithDiagnostics = new Set<string>();

      for (const record of records) {
        assertAnalysisActive(guard, `before parsing ${record.workspacePath}`);
        const project = compilerSnapshot.getDefaultProjectForFile(record.absolutePath);
        const sourceFile = project?.program.getSourceFile(record.absolutePath);
        if (project !== undefined && !projectsWithDiagnostics.has(project.configFileName)) {
          projectsWithDiagnostics.add(project.configFileName);
          for (const diagnostic of project.program.getConfigFileParsingDiagnostics()) {
            diagnostics.push({
              code: "invalid_tsconfig",
              severity: "warning",
              message: redactWorkspaceRoot(diagnostic.text, workspaceRoot),
              ...(diagnostic.fileName === undefined ||
              !isInsideWorkspace(workspaceRoot, diagnostic.fileName)
                ? {}
                : { file_path: toWorkspacePath(workspaceRoot, diagnostic.fileName) }),
            });
          }
        }
        if (sourceFile === undefined) {
          diagnostics.push({
            code: "typescript_parse_failed",
            severity: "error",
            message: "TypeScript compiler did not return an AST for the source file",
            file_path: record.workspacePath,
          });
          continue;
        }
        parsedFileCount += 1;

        const scan = scanStaticReferences(sourceFile);
        skippedDynamicImportCount += scan.dynamicImportLines.length;
        skippedCommonJsRequireCount += scan.unsupportedRequireLines.length;
        for (const line of scan.dynamicImportLines) {
          diagnostics.push({
            code: "dynamic_import_unsupported",
            severity: "info",
            message:
              "dynamic import() is runtime-dependent and was intentionally excluded from the static graph",
            file_path: record.workspacePath,
            line,
          });
        }
        for (const line of scan.unsupportedRequireLines) {
          diagnostics.push({
            code: "commonjs_require_unsupported",
            severity: "warning",
            message:
              "non-literal require() cannot be represented as a definite static dependency",
            file_path: record.workspacePath,
            line,
          });
        }

        for (const reference of scan.references) {
          const target = resolveTarget({
            diagnostics,
            record,
            recordsByAbsolutePath,
            reference,
            workspaceRoot,
          });
          nodes.set(target.node.id, target.node);
          if (target.resolution === "unknown") {
            unresolvedStaticEdgeCount += 1;
          } else if (target.resolution === "partial") {
            partialStaticEdgeCount += 1;
          }

          const sourceNodeId = fileNodeId(record.workspacePath);
          const edgeId = graphEdgeId(
            reference.kind,
            sourceNodeId,
            target.node.id,
          );
          const candidate: GraphEdge = {
            id: edgeId,
            kind: reference.kind,
            source_node_id: sourceNodeId,
            target_node_id: target.node.id,
            file_path: record.workspacePath,
            line: reference.line,
            confidence: target.confidence,
            resolution: target.resolution,
          };
          const existing = edges.get(edgeId);
          if (
            existing === undefined ||
            (candidate.line ?? Number.POSITIVE_INFINITY) <
              (existing.line ?? Number.POSITIVE_INFINITY)
          ) {
            edges.set(edgeId, candidate);
          }
        }
        assertAnalysisActive(guard, `after parsing ${record.workspacePath}`);
      }
    } catch (error) {
      if (error instanceof CodeGraphAnalysisError) {
        throw error;
      }
      throw new CodeGraphAnalysisError(
        "typescript_analysis_failed",
        `TypeScript analysis failed: ${redactWorkspaceRoot(
          error instanceof Error ? error.message : String(error),
          workspaceRoot,
        )}`,
        { cause: error },
      );
    } finally {
      compilerSnapshot?.dispose();
      compiler.close();
    }
    if (parsedFileCount === 0) {
      throw new CodeGraphAnalysisError(
        "typescript_analysis_failed",
        "TypeScript analysis did not produce an AST for any readable source file",
      );
    }
  }

  assertAnalysisActive(guard, "after TypeScript analysis");

  const sortedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const sortedEdges = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  const workspaceHash = sha256(
    stableJson(
      records.map(({ content, workspacePath }) => ({
        content_hash: sha256(content),
        file_path: workspacePath,
      })),
    ),
  );
  const snapshotId = `graph_snapshot:${sha256(
    stableJson({
      edges: sortedEdges,
      nodes: sortedNodes,
      project_id: options.project_id,
      workspace_hash: workspaceHash,
    }),
  )}`;

  const snapshot = GraphSnapshotSchema.parse({
    snapshot_id: snapshotId,
    project_id: options.project_id,
    workspace_hash: workspaceHash,
    created_at: createdAt,
    nodes: sortedNodes,
    edges: sortedEdges,
    diagnostics: diagnostics.map(({ file_path, message }) => ({
      ...(file_path === undefined ? {} : { file_path }),
      message,
    })),
  });

  return {
    snapshot,
    diagnostics: diagnostics.sort(compareDiagnostic),
    coverage: {
      status:
        skippedDynamicImportCount > 0 ||
        skippedCommonJsRequireCount > 0 ||
        unresolvedStaticEdgeCount > 0 ||
        partialStaticEdgeCount > 0 ||
        diagnostics.some(
          ({ code, severity }) => severity === "error" || code === "invalid_tsconfig",
        )
          ? "partial"
          : "complete",
      indexed_file_count: records.length,
      skipped_dynamic_import_count: skippedDynamicImportCount,
      skipped_commonjs_require_count: skippedCommonJsRequireCount,
      unresolved_static_edge_count: unresolvedStaticEdgeCount,
      partial_static_edge_count: partialStaticEdgeCount,
    },
  };
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const realRoot = await fs.realpath(nodePath.resolve(workspaceRoot));
  const stat = await fs.stat(realRoot);
  if (!stat.isDirectory()) {
    throw new Error(`workspace_root must be a directory: ${workspaceRoot}`);
  }
  return realRoot;
}

function createAnalysisGuard(options: AnalyzeCodeGraphOptions): AnalysisGuard {
  const deadlineMs = checkedLimit("deadlineMs", options.deadlineMs, DEFAULT_DEADLINE_MS, true);
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    deadline: performance.now() + deadlineMs,
    maxFiles: checkedLimit("maxFiles", options.maxFiles, DEFAULT_MAX_FILES),
    maxBytes: checkedLimit("maxBytes", options.maxBytes, DEFAULT_MAX_BYTES),
    maxFileBytes: checkedLimit(
      "maxFileBytes",
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
    ),
    maxDepth: checkedLimit("maxDepth", options.maxDepth, DEFAULT_MAX_DEPTH, true),
  };
}

function checkedLimit(
  name: string,
  value: number | undefined,
  defaultValue: number,
  allowZero = false,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || (allowZero ? resolved < 0 : resolved < 1)) {
    throw new CodeGraphAnalysisError(
      "analysis_invalid_limit",
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
    );
  }
  return resolved;
}

function assertAnalysisActive(guard: AnalysisGuard, phase: string): void {
  if (guard.signal?.aborted) {
    throw new CodeGraphAnalysisError(
      "analysis_aborted",
      `CodeGraph analysis was aborted ${phase}`,
      { cause: guard.signal.reason },
    );
  }
  if (performance.now() >= guard.deadline) {
    throw new CodeGraphAnalysisError(
      "analysis_deadline_exceeded",
      `CodeGraph analysis exceeded its deadline ${phase}`,
    );
  }
}

function validateCreatedAt(createdAt: string | undefined): string {
  if (createdAt === undefined) {
    return new Date().toISOString();
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`created_at must be an ISO timestamp: ${createdAt}`);
  }
  return createdAt;
}

async function discoverSourceFiles(
  root: string,
  excludedDirectories: ReadonlySet<string>,
  guard: AnalysisGuard,
): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    assertAnalysisActive(guard, "before directory scan");
    if (depth > guard.maxDepth) {
      throw new CodeGraphAnalysisError(
        "analysis_depth_limit_exceeded",
        `CodeGraph source discovery exceeded maxDepth=${guard.maxDepth}`,
      );
    }
    await assertSafeWorkspaceDirectory(root, directory);
    assertAnalysisActive(guard, "before reading a directory");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    assertAnalysisActive(guard, "after reading a directory");
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertAnalysisActive(guard, "during source discovery");
      const absolutePath = nodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          await visit(absolutePath, depth + 1);
        }
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(nodePath.extname(entry.name).toLowerCase())) {
        files.push(absolutePath);
        if (files.length > guard.maxFiles) {
          throw new CodeGraphAnalysisError(
            "analysis_file_limit_exceeded",
            `CodeGraph source discovery exceeded maxFiles=${guard.maxFiles}`,
          );
        }
      }
    }
  }

  await visit(root, 0);
  return files;
}

async function assertSafeWorkspaceDirectory(workspaceRoot: string, directory: string): Promise<void> {
  const linkStat = await fs.lstat(directory);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new CodeGraphAnalysisError(
      "analysis_unsafe_source_file",
      "CodeGraph source discovery encountered a non-directory or symbolic-link directory",
    );
  }
  const realDirectory = await fs.realpath(directory);
  if (
    !isInsideWorkspace(workspaceRoot, realDirectory)
    || canonicalPath(realDirectory) !== canonicalPath(directory)
  ) {
    throw new CodeGraphAnalysisError(
      "analysis_unsafe_source_file",
      "CodeGraph source discovery attempted to leave the canonical workspace",
    );
  }
}

async function resolveConfiguredProject(
  workspaceRoot: string,
  configuredPath: string | undefined,
): Promise<string | undefined> {
  if (configuredPath === undefined) {
    return undefined;
  }
  const configPath = nodePath.resolve(workspaceRoot, configuredPath);
  if (!isInsideWorkspace(workspaceRoot, configPath)) {
    throw new Error("tsconfig_path must stay inside workspace_root");
  }
  const stat = await fs.stat(configPath);
  if (!stat.isFile()) {
    throw new Error("tsconfig_path must point to a file");
  }
  return configPath;
}

async function readSourceRecords(
  workspaceRoot: string,
  absoluteFiles: readonly string[],
  diagnostics: CodeGraphDiagnostic[],
  guard: AnalysisGuard,
): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  let totalBytes = 0;
  for (const absolutePath of absoluteFiles) {
    assertAnalysisActive(guard, "before reading a source file");
    const workspacePath = toWorkspacePath(workspaceRoot, absolutePath);
    try {
      const inspected = await inspectSourceFile(workspaceRoot, absolutePath);
      if (inspected.size > guard.maxFileBytes) {
        throw new CodeGraphAnalysisError(
          "analysis_file_too_large",
          `CodeGraph source file exceeds maxFileBytes=${guard.maxFileBytes}: ${workspacePath}`,
        );
      }
      if (totalBytes + inspected.size > guard.maxBytes) {
        throw new CodeGraphAnalysisError(
          "analysis_byte_limit_exceeded",
          `CodeGraph source bytes exceed maxBytes=${guard.maxBytes}`,
        );
      }

      assertAnalysisActive(guard, "immediately before opening a source file");
      const handle = await fs.open(
        inspected.realPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const openedStat = await handle.stat();
        if (
          !openedStat.isFile()
          || openedStat.dev !== inspected.dev
          || openedStat.ino !== inspected.ino
        ) {
          throw new CodeGraphAnalysisError(
            "analysis_unsafe_source_file",
            `CodeGraph source file changed before it was opened: ${workspacePath}`,
          );
        }
        const bounded = Buffer.allocUnsafe(openedStat.size);
        let offset = 0;
        while (offset < bounded.byteLength) {
          assertAnalysisActive(guard, `while reading ${workspacePath}`);
          const { bytesRead } = await handle.read(
            bounded,
            offset,
            bounded.byteLength - offset,
            offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        bytes = offset === bounded.byteLength ? bounded : bounded.subarray(0, offset);
        const completedStat = await handle.stat();
        if (
          completedStat.size !== openedStat.size
          || completedStat.mtimeMs !== openedStat.mtimeMs
        ) {
          throw new CodeGraphAnalysisError(
            "analysis_unsafe_source_file",
            `CodeGraph source file changed while it was being read: ${workspacePath}`,
          );
        }
      } finally {
        await handle.close();
      }

      assertAnalysisActive(guard, "after reading a source file");
      const finalRealPath = await fs.realpath(absolutePath);
      if (canonicalPath(finalRealPath) !== canonicalPath(inspected.realPath)) {
        throw new CodeGraphAnalysisError(
          "analysis_unsafe_source_file",
          `CodeGraph source path changed while it was being read: ${workspacePath}`,
        );
      }
      if (bytes.byteLength > guard.maxFileBytes) {
        throw new CodeGraphAnalysisError(
          "analysis_file_too_large",
          `CodeGraph source file exceeds maxFileBytes=${guard.maxFileBytes}: ${workspacePath}`,
        );
      }
      if (totalBytes + bytes.byteLength > guard.maxBytes) {
        throw new CodeGraphAnalysisError(
          "analysis_byte_limit_exceeded",
          `CodeGraph source bytes exceed maxBytes=${guard.maxBytes}`,
        );
      }
      totalBytes += bytes.byteLength;
      records.push({
        absolutePath: inspected.realPath,
        workspacePath,
        content: bytes.toString("utf8"),
      });
    } catch (error) {
      if (error instanceof CodeGraphAnalysisError) {
        throw error;
      }
      diagnostics.push({
        code: "file_read_failed",
        severity: "error",
        message: redactWorkspaceRoot(
          error instanceof Error ? error.message : String(error),
          workspaceRoot,
        ),
        file_path: workspacePath,
      });
    }
  }
  return records;
}

async function inspectSourceFile(
  workspaceRoot: string,
  absolutePath: string,
): Promise<{ readonly realPath: string; readonly size: number; readonly dev: number; readonly ino: number }> {
  const linkStat = await fs.lstat(absolutePath);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new CodeGraphAnalysisError(
      "analysis_unsafe_source_file",
      "CodeGraph refused a non-regular or symbolic-link source file",
    );
  }
  const realPath = await fs.realpath(absolutePath);
  if (
    !isInsideWorkspace(workspaceRoot, realPath)
    || canonicalPath(realPath) !== canonicalPath(absolutePath)
  ) {
    throw new CodeGraphAnalysisError(
      "analysis_unsafe_source_file",
      "CodeGraph refused a source file outside the canonical workspace",
    );
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new CodeGraphAnalysisError(
      "analysis_unsafe_source_file",
      "CodeGraph refused a source path that is not a regular file",
    );
  }
  return { realPath, size: stat.size, dev: stat.dev, ino: stat.ino };
}

function addDirectoryNodes(nodes: Map<string, GraphNode>, workspacePaths: readonly string[]): void {
  const rootDirectoryId = directoryNodeId(".");
  nodes.set(rootDirectoryId, {
    id: rootDirectoryId,
    kind: "directory",
    label: ".",
    file_path: ".",
  });
  for (const workspacePath of workspacePaths) {
    let directory = nodePath.posix.dirname(workspacePath);
    while (directory !== ".") {
      const id = directoryNodeId(directory);
      nodes.set(id, {
        id,
        kind: "directory",
        label: nodePath.posix.basename(directory),
        file_path: directory,
      });
      directory = nodePath.posix.dirname(directory);
    }
  }
}

function scanStaticReferences(sourceFile: SourceFile): {
  readonly references: StaticReference[];
  readonly dynamicImportLines: number[];
  readonly unsupportedRequireLines: number[];
} {
  const references: StaticReference[] = [];
  const dynamicImportLines: number[] = [];
  const unsupportedRequireLines: number[] = [];

  function lineOf(node: Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node: Node): void {
    if (isImportDeclaration(node) && isStringLiteralLikeNode(node.moduleSpecifier)) {
      references.push({
        kind: "static_import",
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
      });
    } else if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      isStringLiteralLikeNode(node.moduleReference.expression)
    ) {
      references.push({
        kind: "static_import",
        specifier: node.moduleReference.expression.text,
        line: lineOf(node),
      });
    } else if (
      isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteralLikeNode(node.moduleSpecifier)
    ) {
      references.push({
        kind: "static_export",
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
      });
    } else if (
      isCallExpression(node) &&
      isImportExpression(node.expression)
    ) {
      dynamicImportLines.push(lineOf(node));
    } else if (
      isCallExpression(node)
      && isIdentifier(node.expression)
      && node.expression.text === "require"
    ) {
      const argument = node.arguments[0];
      if (node.arguments.length === 1 && argument !== undefined && isStringLiteralLikeNode(argument)) {
        references.push({
          kind: "static_import",
          specifier: argument.text,
          line: lineOf(node),
          conservative: true,
        });
      } else {
        unsupportedRequireLines.push(lineOf(node));
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return { references, dynamicImportLines, unsupportedRequireLines };
}

function resolveTarget(input: {
  readonly workspaceRoot: string;
  readonly record: SourceRecord;
  readonly reference: StaticReference;
  readonly recordsByAbsolutePath: ReadonlyMap<string, SourceRecord>;
  readonly diagnostics: CodeGraphDiagnostic[];
}): ResolvedTarget {
  const { workspaceRoot, record, reference, recordsByAbsolutePath, diagnostics } = input;
  const resolvedModule = resolveRelativeWorkspaceModule(
    record,
    reference.specifier,
    workspaceRoot,
    recordsByAbsolutePath,
  );
  if (resolvedModule !== undefined) {
    if (resolvedModule.ambiguous) {
      diagnostics.push({
        code: "ambiguous_static_module",
        severity: "warning",
        message: `static module '${reference.specifier}' matched multiple workspace files; the first TypeScript-compatible candidate was selected conservatively`,
        file_path: record.workspacePath,
        line: reference.line,
      });
    }
    if (reference.conservative === true) {
      diagnostics.push({
        code: "commonjs_require_partial",
        severity: "info",
        message:
          "literal require() was recorded conservatively because lexical analysis cannot prove that require is the CommonJS loader",
        file_path: record.workspacePath,
        line: reference.line,
      });
    }
    const isConservative = resolvedModule.ambiguous || reference.conservative === true;
    return {
      node: {
        id: fileNodeId(resolvedModule.record.workspacePath),
        kind: "file",
        label: nodePath.posix.basename(resolvedModule.record.workspacePath),
        file_path: resolvedModule.record.workspacePath,
        line: 1,
        content_hash: sha256(resolvedModule.record.content),
      },
      confidence: isConservative ? "medium" : "high",
      resolution: isConservative ? "partial" : "resolved",
    };
  }

  if (!isRelativeSpecifier(reference.specifier)) {
    diagnostics.push({
      code: "external_module_partial",
      severity: "info",
      message: `external module '${reference.specifier}' is outside the indexed workspace`,
      file_path: record.workspacePath,
      line: reference.line,
    });
    return {
      node: {
        id: moduleNodeId(reference.specifier),
        kind: "module",
        label: reference.specifier,
      },
      confidence: "medium",
      resolution: "partial",
    };
  }

  diagnostics.push({
    code: "static_module_unresolved",
    severity: "warning",
    message: `static module '${reference.specifier}' could not be resolved inside the workspace`,
    file_path: record.workspacePath,
    line: reference.line,
  });
  return {
    node: {
      id: moduleNodeId(reference.specifier, record.workspacePath),
      kind: "module",
      label: reference.specifier,
      file_path: record.workspacePath,
      line: reference.line,
    },
    confidence: "low",
    resolution: "unknown",
  };
}

function resolveRelativeWorkspaceModule(
  record: SourceRecord,
  specifier: string,
  workspaceRoot: string,
  recordsByAbsolutePath: ReadonlyMap<string, SourceRecord>,
): RelativeModuleResolution | undefined {
  if (!isRelativeSpecifier(specifier)) {
    return undefined;
  }
  const basePath = nodePath.resolve(nodePath.dirname(record.absolutePath), specifier);
  if (!isInsideWorkspace(workspaceRoot, basePath)) {
    return undefined;
  }

  const matches: SourceRecord[] = [];
  const matchedPaths = new Set<string>();
  for (const candidate of moduleCandidates(basePath)) {
    const target = recordsByAbsolutePath.get(canonicalPath(candidate));
    if (target !== undefined && !matchedPaths.has(canonicalPath(target.absolutePath))) {
      matches.push(target);
      matchedPaths.add(canonicalPath(target.absolutePath));
    }
  }
  const recordMatch = matches[0];
  return recordMatch === undefined
    ? undefined
    : { record: recordMatch, ambiguous: matches.length > 1 };
}

function moduleCandidates(basePath: string): string[] {
  const extension = nodePath.extname(basePath).toLowerCase();
  const candidates = new Set<string>();
  if (extension === "") {
    for (const sourceExtension of RESOLUTION_EXTENSIONS) {
      candidates.add(`${basePath}${sourceExtension}`);
      candidates.add(nodePath.join(basePath, `index${sourceExtension}`));
    }
  } else {
    const extensionSubstitutions: Readonly<Record<string, readonly string[]>> = {
      ".cjs": [".cts", ".d.cts", ".cjs"],
      ".js": [".ts", ".tsx", ".d.ts", ".js", ".jsx"],
      ".jsx": [".tsx", ".d.ts", ".jsx"],
      ".mjs": [".mts", ".d.mts", ".mjs"],
    };
    const stem = basePath.slice(0, -extension.length);
    const substitutions = extensionSubstitutions[extension];
    for (const sourceExtension of substitutions ?? []) {
      candidates.add(`${stem}${sourceExtension}`);
    }
    if (substitutions === undefined) {
      candidates.add(basePath);
    }
  }
  return [...candidates];
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function graphEdgeId(kind: GraphEdgeKind, sourceNodeId: string, targetNodeId: string): string {
  return `edge:${sha256(`${kind}\0${sourceNodeId}\0${targetNodeId}`)}`;
}

function canonicalPath(filePath: string): string {
  const normalized = nodePath.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function redactWorkspaceRoot(message: string, workspaceRoot: string): string {
  return message.split(workspaceRoot).join("<workspace>");
}

function compareDiagnostic(left: CodeGraphDiagnostic, right: CodeGraphDiagnostic): number {
  return (
    (left.file_path ?? "").localeCompare(right.file_path ?? "") ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.code.localeCompare(right.code)
  );
}
