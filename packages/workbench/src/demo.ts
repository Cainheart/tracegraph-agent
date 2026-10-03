import type { TodoItem } from "@tracegraph/contracts";
import type {
  ApprovalRequest,
  ChangedFile,
  ContextSource,
  DiffLine,
  GraphEdge,
  GraphNode,
  EventEvidenceSnapshot,
  ProjectSnapshot,
  RunSnapshot,
  RunStatus,
  TraceEvent,
  WorkbenchSnapshot,
  WorkspaceKind,
} from "./model";

export const contextSources: readonly ContextSource[] = [
  { itemId: "demo-system-rules", name: "System rules", tokens: 980, action: "pinned", reason: "security_anchor", color: "#7c8cff" },
  { itemId: "demo-user-goal", name: "User goal", tokens: 660, action: "kept", reason: "active_objective", color: "#b88cff" },
  { itemId: "demo-repository-map", name: "Repository map", tokens: 2900, action: "kept", reason: "graph_neighbour", color: "#48bfa5" },
  {
    itemId: "demo-old-observation",
    name: "Old observation",
    tokens: 420,
    originalTokens: 1600,
    action: "masked",
    reason: "stale_low_priority",
    color: "#e0a84b",
  },
  {
    itemId: "demo-raw-test-log",
    name: "Raw test log",
    tokens: 0,
    originalTokens: 5200,
    action: "externalized",
    reason: "item_budget_exceeded",
    color: "#697384",
  },
  { itemId: "demo-tool-evidence", name: "Tool evidence", tokens: 1120, action: "kept", reason: "decision_evidence", color: "#4e9bea" },
];

export const events: readonly TraceEvent[] = [
  {
    id: "evt_001",
    sequence: 1,
    kind: "query",
    title: "User query",
    summary: "Fix the failing test and explain the architecture impact.",
    timestamp: "10:02:14",
    state: "succeeded",
    input: "Fix the failing test and explain the architecture impact.",
  },
  {
    id: "evt_004",
    sequence: 4,
    kind: "context",
    title: "Context built",
    summary: "6.1k / 12k tokens · 4 sources kept",
    timestamp: "10:02:16",
    state: "succeeded",
    duration: "38 ms",
    contextManifestRef: "ctx_002",
    output: "Manifest ctx_002 passed all fixed-constraint checks.",
  },
  {
    id: "evt_006",
    sequence: 6,
    kind: "decision",
    title: "Inspect failing parser path",
    summary: "Read the test, then trace static imports to the normalizer.",
    timestamp: "10:02:17",
    state: "succeeded",
    duration: "112 ms",
    contextManifestRef: "ctx_002",
    rationale: "The failure points to an empty input branch. The smallest evidence-first action is to inspect the assertion and its direct import path.",
    evidenceRefs: ["src/parser.test.ts:18", "src/parser.ts:31"],
  },
  {
    id: "evt_008",
    sequence: 8,
    kind: "tool",
    title: "Search repository",
    summary: "rg normalizeInput · 3 matches",
    timestamp: "10:02:18",
    state: "succeeded",
    duration: "84 ms",
    depth: 0,
    input: "pattern: normalizeInput\nscope: src/**",
    output: "3 bounded matches. Full result stored as artifact art_search_008.",
    evidenceRefs: ["art_search_008"],
  },
  {
    id: "evt_009",
    sequence: 9,
    kind: "tool",
    title: "Read source window",
    summary: "src/parser.ts · lines 24–46",
    timestamp: "10:02:18",
    state: "succeeded",
    duration: "31 ms",
    depth: 1,
    input: "src/parser.ts:24-46",
    output: "Bounded source window returned; no workspace mutation.",
    evidenceRefs: ["src/parser.ts:24-46"],
  },
  {
    id: "evt_012",
    sequence: 12,
    kind: "patch",
    title: "Patch preview created",
    summary: "2 files · +12 −4 · not written",
    timestamp: "10:02:20",
    state: "succeeded",
    duration: "46 ms",
    risk: "high",
    contextManifestRef: "ctx_002",
    patchRef: "patch_012",
    graphDeltaRef: "graph_014",
    testReceiptRef: "test_018",
    evidenceRefs: ["src/parser.ts:31", "src/index.ts:4"],
    rationale: "Normalize empty input at the boundary and export the typed result through the existing public module. The preview remains uncommitted until approval.",
    input: "base: 74a93f8\nscope: src/parser.ts, src/index.ts",
    output: "preview hash sha256:ac91…2fc7",
  },
  {
    id: "evt_013",
    sequence: 13,
    kind: "approval",
    title: "Approval required",
    summary: "apply_patch · HIGH · expires in 08:42",
    timestamp: "10:02:20",
    state: "waiting",
    risk: "high",
    patchRef: "patch_012",
    graphDeltaRef: "graph_014",
    evidenceRefs: ["approval_013"],
  },
  {
    id: "evt_014",
    sequence: 14,
    kind: "graph",
    title: "Architecture delta projected",
    summary: "+1 module · +2 edges · 1 changed",
    timestamp: "10:02:20",
    state: "succeeded",
    duration: "67 ms",
    graphDeltaRef: "graph_014",
    patchRef: "patch_012",
    evidenceRefs: ["graph_before_001", "graph_after_014"],
  },
  {
    id: "evt_018",
    sequence: 18,
    kind: "test",
    title: "Fixture tests",
    summary: "8 / 8 passed · receipt sealed",
    timestamp: "10:02:24",
    state: "succeeded",
    duration: "1.42 s",
    testReceiptRef: "test_018",
    patchRef: "patch_012",
    evidenceRefs: ["art_testlog_018"],
    input: "registered test: pnpm test -- --run",
    output: "8 passed, 0 failed · exit 0 · output hash verified",
  },
  {
    id: "evt_020",
    sequence: 20,
    kind: "run",
    title: "Run ready for review",
    summary: "Patch, graph delta, and test receipt linked",
    timestamp: "10:02:25",
    state: "succeeded",
    evidenceRefs: ["report_020"],
  },
];

export const changedFiles: readonly ChangedFile[] = [
  { path: "src/parser.ts", status: "modified", additions: 8, deletions: 4 },
  { path: "src/normalizer.ts", status: "added", additions: 4, deletions: 0 },
  { path: "src/index.ts", status: "modified", additions: 2, deletions: 0 },
];

const parserDiff: readonly DiffLine[] = [
  { number: null, type: "meta", content: "@@ -27,10 +27,14 @@ export function parsePayload(input: string)" },
  { number: 27, type: "context", content: " export function parsePayload(input: string): Payload {" },
  { number: 28, type: "removed", content: "-  const normalized = input.trim();" },
  { number: 28, type: "added", content: "+  const normalized = normalizeInput(input);" },
  { number: 29, type: "context", content: " " },
  { number: 30, type: "removed", content: "-  if (!normalized) return {} as Payload;" },
  { number: 30, type: "added", content: "+  if (normalized.kind === \"empty\") {" },
  { number: 31, type: "added", content: "+    return { kind: \"empty\", values: [] };" },
  { number: 32, type: "added", content: "+  }" },
  { number: 33, type: "context", content: " " },
  { number: 34, type: "added", content: "+  return decodeValues(normalized.value);" },
  { number: 35, type: "context", content: " }" },
];

export const diffs: Readonly<Record<string, readonly DiffLine[]>> = {
  "src/parser.ts": parserDiff,
  "src/normalizer.ts": [
    { number: null, type: "meta", content: "@@ -0,0 +1,4 @@" },
    { number: 1, type: "added", content: "+export const normalizeInput = (input: string) =>" },
    { number: 2, type: "added", content: "+  input.trim().length === 0" },
    { number: 3, type: "added", content: "+    ? { kind: \"empty\" as const }" },
    { number: 4, type: "added", content: "+    : { kind: \"value\" as const, value: input.trim() };" },
  ],
  "src/index.ts": [
    { number: null, type: "meta", content: "@@ -3,3 +3,5 @@" },
    { number: 3, type: "context", content: " export { parsePayload } from \"./parser.js\";" },
    { number: 4, type: "added", content: "+export { normalizeInput } from \"./normalizer.js\";" },
    { number: 5, type: "added", content: "+export type { Payload } from \"./types.js\";" },
  ],
};

export const graphNodes: readonly GraphNode[] = [
  {
    id: "index",
    state: "changed",
    before: { label: "index.ts", path: "src/index.ts" },
    after: { label: "index.ts", path: "src/index.ts" },
    x: 48,
    y: 32,
  },
  {
    id: "parser",
    state: "changed",
    before: { label: "parser.ts · direct trim", path: "src/parser.ts" },
    after: { label: "parser.ts · normalizer", path: "src/parser.ts" },
    x: 43,
    y: 130,
  },
  {
    id: "normalizer",
    state: "added",
    after: { label: "normalizer.ts", path: "src/normalizer.ts" },
    x: 205,
    y: 130,
  },
  {
    id: "types",
    state: "partial",
    before: { label: "types.ts", path: "src/types.ts" },
    after: { label: "types.ts", path: "src/types.ts" },
    x: 126,
    y: 226,
  },
];

export const graphEdges: readonly GraphEdge[] = [
  {
    id: "edge_index_parser",
    state: "changed",
    before: { from: "index", to: "parser", label: "exports parsePayload", confidence: 1 },
    after: { from: "index", to: "parser", label: "exports parser API", confidence: 1 },
  },
  {
    id: "edge_parser_normalizer",
    state: "added",
    after: { from: "parser", to: "normalizer", label: "imports", confidence: 1 },
  },
  {
    id: "edge_normalizer_types",
    state: "added",
    after: { from: "normalizer", to: "types", label: "returns", confidence: 0.82 },
  },
];

const fixtureProject: ProjectSnapshot = {
  id: "project_fixture",
  name: "parser-repair-fixture",
  branch: "isolation/run-2fafd8",
  pathLabel: "built-in / parser-repair",
  workspaceKind: "disposable_fixture",
};

const localProject: ProjectSnapshot = {
  id: "project_local",
  name: "sample-typescript-app",
  branch: "main",
  pathLabel: "local / sample-typescript-app",
  workspaceKind: "readonly_local",
};

const demoEvidence: WorkbenchSnapshot["evidence"] = {
  context: { status: "demo", artifactId: "art_context_002", message: "Deterministic demo context manifest" },
  diff: { status: "demo", artifactId: "art_diff_012", message: "Deterministic demo patch preview" },
  graph: { status: "demo", artifactId: "art_graph_014", message: "Deterministic demo architecture delta" },
  test: {
    status: "demo",
    artifactId: "art_testlog_018",
    message: "Deterministic demo test receipt",
    content: "✓ parser returns a typed empty payload  4ms\n✓ parser preserves non-empty values       2ms\n✓ public module exports normalizer         1ms\n\nTest Files  2 passed (2)\nTests       8 passed (8)\nDuration    1.42s",
  },
};

const demoConnection: WorkbenchSnapshot["connection"] = {
  state: "live",
  message: "Deterministic browser demo",
  lastSequence: 20,
};

export const approval: ApprovalRequest = {
  id: "approval_013",
  action: "apply_patch",
  risk: "high",
  target: "Disposable fixture",
  files: 2,
  additions: 12,
  deletions: 4,
  expiresAt: "08:42",
  rollbackAvailable: false,
  reviewReady: true,
  reviewMessage: "Demo diff is fully available for review.",
};

export const todos: readonly TodoItem[] = [
  {
    todo_id: "todo_inspect_parser",
    title: "Inspect the failing parser path",
    detail: "Read the failing assertion and trace its direct import path.",
    state: "done",
    depends_on: [],
    evidence_event_ids: ["evt_009"],
    created_by: "model",
  },
  {
    todo_id: "todo_prepare_patch",
    title: "Prepare and verify a scoped patch",
    state: "pending",
    depends_on: ["todo_inspect_parser"],
    evidence_event_ids: [],
    created_by: "model",
  },
];

const planReadyEvent: TraceEvent = {
  id: "evt_plan_ready",
  sequence: 11,
  kind: "approval",
  title: "Plan ready",
  summary: "2 Todo items are ready for review before execution",
  timestamp: "10:02:19",
  state: "waiting",
};

function eventsForStatus(status: RunStatus): readonly TraceEvent[] {
  if (status === "indexing") return events.slice(0, 1);
  if (status === "running" || status === "reconnecting") return events.slice(0, 5);
  if (status === "awaiting_plan_approval") return [...events.slice(0, 5), planReadyEvent];
  if (status === "needs_approval") {
    return events.slice(0, 7).map((event) => {
      if (event.kind !== "patch") return event;
      const { graphDeltaRef: _futureGraph, testReceiptRef: _futureReceipt, ...previewEvent } = event;
      return previewEvent;
    });
  }
  if (status === "failed") {
    return [
      ...events.slice(0, 5),
      {
        id: "evt_failure",
        sequence: 11,
        kind: "tool" as const,
        title: "Read source failed",
        summary: "Artifact hash mismatch · execution stopped",
        timestamp: "10:02:20",
        state: "failed" as const,
        duration: "49 ms",
        evidenceRefs: ["art_corrupt_011"],
      },
    ];
  }
  if (status === "cancelled") return events.slice(0, 4);
  return events;
}

function demoEventEvidence(visibleEvents: readonly TraceEvent[]): Readonly<Record<string, EventEvidenceSnapshot>> {
  const graphAvailable = visibleEvents.some((event) => event.kind === "graph" && event.graphDeltaRef === "graph_014");
  const testAvailable = visibleEvents.some((event) => event.kind === "test" && event.testReceiptRef === "test_018");
  return Object.fromEntries(visibleEvents.map((event) => {
    const hasContext = event.contextManifestRef === "ctx_002";
    const hasPatch = event.patchRef === "patch_012"
      || event.evidenceRefs?.includes("art_diff_012")
      || event.evidenceRefs?.includes("approval_013");
    const hasGraph = graphAvailable && (event.graphDeltaRef === "graph_014" || event.patchRef === "patch_012");
    const hasTest = testAvailable && (event.testReceiptRef === "test_018" || event.patchRef === "patch_012");
    const slot = (label: string) => ({ status: "not_present" as const, message: `${label} is not linked to this selected event.` });
    return [event.id, {
      contextSources: hasContext ? contextSources : [],
      changedFiles: hasPatch ? changedFiles : [],
      diffs: hasPatch ? diffs : {},
      graphNodes: hasGraph ? graphNodes : [],
      graphEdges: hasGraph ? graphEdges : [],
      evidence: {
        context: hasContext ? demoEvidence.context : slot("Context"),
        diff: hasPatch ? demoEvidence.diff : slot("Diff"),
        graph: hasGraph ? demoEvidence.graph : slot("Graph delta"),
        test: hasTest ? demoEvidence.test : slot("Test evidence"),
      },
      ...(hasContext ? { contextManifestId: "ctx_002", inputTokens: 6080, tokenLimit: 12000, reservedOutput: 4000 } : {}),
      ...(hasPatch ? { patchEventId: "evt_012" } : {}),
      ...(hasGraph ? { graphDeltaId: "graph_014" } : {}),
      ...(hasTest ? { testReceiptId: "test_018" } : {}),
    } satisfies EventEvidenceSnapshot];
  }));
}

export function createDemoSnapshot(
  status: RunStatus = "needs_approval",
  workspaceKind: WorkspaceKind = "disposable_fixture",
  mode: RunSnapshot["mode"] = workspaceKind === "readonly_local" ? "plan" : "execute",
): WorkbenchSnapshot {
  if (status === "empty") {
    return {
      dataSource: "demo",
      connection: demoConnection,
      project: null,
      availableProjects: [fixtureProject, localProject],
      sessions: [],
      selectedSessionId: null,
      sessionViewState: null,
      recovery: null,
      run: null,
      conversation: [],
      contextSources,
      changedFiles,
      diffs,
      graphNodes,
      graphEdges,
      evidence: demoEvidence,
      eventEvidence: {},
    };
  }

  const project = workspaceKind === "readonly_local" ? localProject : fixtureProject;
  if (status === "ready") {
    return {
      dataSource: "demo",
      connection: demoConnection,
      project,
      availableProjects: [fixtureProject, localProject],
      sessions: [],
      selectedSessionId: null,
      sessionViewState: null,
      recovery: null,
      run: null,
      conversation: [],
      contextSources,
      changedFiles,
      diffs,
      graphNodes,
      graphEdges,
      evidence: demoEvidence,
      eventEvidence: {},
    };
  }

  const visibleEvents = eventsForStatus(status);
  const run: RunSnapshot = {
    id: "run_2fafd8",
    status,
    mode,
    task: "Fix the failing test and explain the architecture impact.",
    elapsed: status === "completed" || status === "historical" ? "00:11" : "00:08",
    currentStep:
      status === "indexing"
        ? "Building baseline module graph"
        : status === "needs_approval"
          ? "Waiting for patch approval"
          : status === "failed"
            ? "Stopped at artifact verification"
            : "Reviewing evidence",
    lastSequence: visibleEvents.at(-1)?.sequence ?? 0,
    inputTokens: 6080,
    tokenLimit: 12000,
    reservedOutput: 4000,
    indexedFiles: status === "indexing" ? 31 : 48,
    scanScope: "src/**/*.{ts,tsx,js,jsx}",
    events: visibleEvents,
    todos,
    inputQueue: { pending: [] },
    subagents: [],
    attachments: [],
    ...(status === "awaiting_plan_approval" ? {
      pendingPlan: { eventId: planReadyEvent.id, todoIds: todos.map(({ todo_id: todoId }) => todoId) },
    } : {}),
    ...(status === "needs_approval" ? { approval } : {}),
  };

  return {
    dataSource: "demo",
    connection: { ...demoConnection, lastSequence: run.lastSequence },
    project,
    availableProjects: [fixtureProject, localProject],
    sessions: [],
    selectedSessionId: null,
    sessionViewState: null,
    recovery: null,
    run,
    conversation: [],
    contextSources,
    changedFiles,
    diffs,
    graphNodes,
    graphEdges,
    evidence: demoEvidence,
    eventEvidence: demoEventEvidence(visibleEvents),
  };
}
