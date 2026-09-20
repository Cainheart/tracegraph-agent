import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EvidenceSnapshot, GraphNode } from "../model";
import { ChangesView } from "./ChangesView";

const availableEvidence: EvidenceSnapshot = {
  context: { status: "not_present", message: "No context" },
  diff: { status: "not_present", message: "No diff" },
  graph: { status: "available", artifactId: "artifact_graph", message: "Verified graph delta" },
  test: { status: "not_present", message: "No test" },
};

function render(nodes: readonly GraphNode[]): string {
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
});
