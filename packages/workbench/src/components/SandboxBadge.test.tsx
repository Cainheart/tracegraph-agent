import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import type { TraceEvent } from "../model";
import { SandboxBadge } from "./SandboxBadge";
import { Trajectory } from "./Trajectory";

const baseReport = {
  report_version: 1 as const,
  mode: "workspace-write" as const,
  platform: "darwin" as const,
  mechanisms: ["seatbelt"],
  unmet_constraints: [],
};

describe("SandboxBadge", () => {
  it.each([
    ["full", "sandbox-full"],
    ["partial", "sandbox-partial"],
    ["none", "sandbox-none"],
  ] as const)("renders %s enforcement with an explicit tone", (enforcement, className) => {
    const report = enforcement === "full"
      ? { ...baseReport, enforcement }
      : enforcement === "partial"
        ? { ...baseReport, enforcement, unmet_constraints: ["network isolation unavailable"] }
        : {
            ...baseReport,
            mode: "danger-full-access" as const,
            enforcement,
            mechanisms: [],
            unmet_constraints: [],
          };
    const html = renderToStaticMarkup(<LanguageProvider><SandboxBadge report={report} /></LanguageProvider>);

    expect(html).toContain(className);
    expect(html).toContain(report.mode);
    expect(html).toContain(enforcement);
  });

  it("shows the sandbox report on the relevant timeline row", () => {
    const event: TraceEvent = {
      id: "sandbox-event",
      sequence: 2,
      kind: "sandbox",
      title: "Sandbox enforced",
      summary: "Workspace-write sandbox enforced",
      timestamp: "12:00:00",
      state: "succeeded",
      sandboxReport: { ...baseReport, enforcement: "full" },
    };
    const html = renderToStaticMarkup(<LanguageProvider><Trajectory
      events={[event]}
      onResumeLive={vi.fn()}
      onSelect={vi.fn()}
      selectedId={null}
      tailFollowing
    /></LanguageProvider>);

    expect(html).toContain("event-sandbox");
    expect(html).toContain("workspace-write");
    expect(html).toContain("sandbox-full");
  });
});
