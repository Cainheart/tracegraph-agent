import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CodeIntelSnapshot, EvidenceSnapshot, GraphNode } from "../model";
import { ChangesView } from "./ChangesView";

const availableEvidence: EvidenceSnapshot = {
  context: { status: "not_present", message: "No context" },
  diff: { status: "not_present", message: "No diff" },
  graph: { status: "available", artifactId: "artifact_graph", message: "Verified graph delta" },
  test: { status: "not_present", message: "No test" },
};

function render(nodes: readonly GraphNode[], codeIntel?: CodeIntelSnapshot): string {
  return renderToStaticMarkup(
    <ChangesView
      diffs={{}}
      edges={[]}
      evidence={availableEvidence}
      files={[]}
      nodes={nodes}
      onJumpToPatch={vi.fn()}
      onOpenDetails={vi.fn()}
      patchId={undefined}
      verified={false}
      {...(codeIntel === undefined ? {} : { codeIntel })}
    />,
  );
}

describe("ChangesView architecture versions", () => {
  it("renders the recorded after value for a changed node instead of reusing before", () => {
    const html = render([{
      id: "node_changed",
      state: "changed",
      before: { label: "legacy-parser.ts", path: "src/legacy-parser.ts" },
      after: { label: "parser.ts", path: "src/parser.ts" },
      x: 20,
      y: 40,
    }]);

    expect(html).toContain("parser.ts");
    expect(html).not.toContain("legacy-parser.ts");
    expect(html).toContain("RECORDED AFTER");
  });

  it("states that after is unavailable when the delta only contains a before value", () => {
    const html = render([{
      id: "node_removed",
      state: "removed",
      before: { label: "removed.ts", path: "src/removed.ts" },
      x: 20,
      y: 40,
    }]);

    expect(html).toContain("after architecture unavailable");
    expect(html).toContain("No full snapshot is being inferred");
    expect(html).not.toContain("removed.ts");
  });

  it("renders bounded semantic symbols and the recorded diagnostic badge", () => {
    const html = render([], {
      changedFiles: ["src/parser.ts", "src/lexer.ts"],
      changedFilesTruncated: true,
      changedSymbols: [{
        symbol_id: "symbol_parser",
        name: "parseInput",
        kind: "function",
        file_path: "src/parser.ts",
        line: 12,
        change: "changed",
      }],
      changedSymbolsTruncated: false,
      diagnosticsSummary: {
        server_name: "typescript",
        files_scanned: 1,
        diagnostic_count: 1,
        error_count: 1,
        warning_count: 0,
        information_count: 0,
        hint_count: 0,
        truncated: false,
        diagnostics_hash: `sha256:${"a".repeat(64)}`,
        sample: [{
          path: "src/parser.ts",
          range: { start: { line: 11, character: 2 }, end: { line: 11, character: 8 } },
          severity: "error",
          message: "Expected string",
        }],
      },
    });

    expect(html).toContain("Semantic impact");
    expect(html).toContain("Affected files");
    expect(html).toContain("src/lexer.ts");
    expect(html).toContain("Additional affected files are omitted from this bounded view.");
    expect(html).toContain("parseInput");
    expect(html).toContain("Expected string");
    expect(html).toContain("1 errors");
  });
});
