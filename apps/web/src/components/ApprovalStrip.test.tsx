import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { approval } from "../demo";
import { ApprovalStrip } from "./ApprovalStrip";

describe("ApprovalStrip", () => {
  it("shows risk, scope, evidence readiness, expiry, and one-time action", () => {
    const html = renderToStaticMarkup(
      <ApprovalStrip
        approval={approval}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onViewDiff={vi.fn()}
      />,
    );

    expect(html).toContain("high risk");
    expect(html).toContain("2 files");
    expect(html).toContain("no rollback");
    expect(html).toContain("Demo diff is fully available for review.");
    expect(html).toContain("08:42");
    expect(html).toContain("Allow once");
    expect(html).toContain("View diff");
  });

  it("renders a visible error when a one-time approval cannot be submitted", () => {
    const html = renderToStaticMarkup(
      <ApprovalStrip
        approval={approval}
        busy={false}
        error="The local Host could not complete this request."
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onViewDiff={vi.fn()}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("The local Host could not complete this request.");
  });
});
