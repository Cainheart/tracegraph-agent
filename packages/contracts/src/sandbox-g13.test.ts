import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  MAX_SANDBOX_REPORT_ITEM_LENGTH,
  MAX_SANDBOX_REPORT_ITEMS,
  SANDBOX_REPORT_FORMAT_VERSION,
  SandboxConfiguredDataSchema,
  SandboxDisabledDataSchema,
  SandboxEnforcedDataSchema,
  SandboxEnforcementSchema,
  SandboxModeSchema,
  SandboxPlatformSchema,
  SandboxReportSchema,
  PROJECTOR_VERSION,
  RunProjectionSchema,
} from "./index.js";

function report(overrides: Record<string, unknown> = {}) {
  return {
    report_version: SANDBOX_REPORT_FORMAT_VERSION,
    mode: "read-only",
    enforcement: "full",
    platform: "darwin",
    mechanisms: ["seatbelt:/usr/bin/sandbox-exec", "path-scope:workspace", "network:deny"],
    unmet_constraints: [],
    ...overrides,
  };
}

describe("G13 Sandbox contracts", () => {
  it("defines the three requested modes and bounded platform/enforcement vocabularies", () => {
    expect(SandboxModeSchema.options).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(SandboxEnforcementSchema.options).toEqual(["full", "partial", "none"]);
    expect(SandboxPlatformSchema.options).toEqual(["darwin", "linux", "win32"]);
    expect(() => SandboxModeSchema.parse("auto")).toThrow();
    expect(() => SandboxPlatformSchema.parse("freebsd")).toThrow();
  });

  it("accepts truthful full, partial, unavailable, and explicitly disabled reports", () => {
    expect(SandboxReportSchema.parse(report()).enforcement).toBe("full");
    expect(SandboxReportSchema.parse(report({
      mode: "workspace-write",
      enforcement: "partial",
      mechanisms: ["path-scope:workspace"],
      unmet_constraints: ["network isolation unavailable"],
    })).enforcement).toBe("partial");
    expect(SandboxReportSchema.parse(report({
      enforcement: "none",
      mechanisms: [],
      unmet_constraints: ["seatbelt backend unavailable", "network isolation unavailable"],
    })).mode).toBe("read-only");
    expect(SandboxReportSchema.parse(report({
      mode: "danger-full-access",
      enforcement: "none",
      mechanisms: [],
      unmet_constraints: [],
    })).mode).toBe("danger-full-access");
  });

  it("rejects contradictory enforcement reports", () => {
    expect(() => SandboxReportSchema.parse(report({ mechanisms: [] }))).toThrow(/full enforcement/u);
    expect(() => SandboxReportSchema.parse(report({
      unmet_constraints: ["network isolation unavailable"],
    }))).toThrow(/full enforcement/u);
    expect(() => SandboxReportSchema.parse(report({
      enforcement: "partial",
      unmet_constraints: [],
    }))).toThrow(/partial enforcement/u);
    expect(() => SandboxReportSchema.parse(report({
      enforcement: "none",
      mechanisms: ["path-scope:workspace"],
      unmet_constraints: ["network isolation unavailable"],
    }))).toThrow(/no enforcement/u);
    expect(() => SandboxReportSchema.parse(report({
      enforcement: "none",
      mechanisms: [],
      unmet_constraints: [],
    }))).toThrow(/must name its unmet constraints/u);
    expect(() => SandboxReportSchema.parse(report({
      mode: "danger-full-access",
      enforcement: "partial",
      mechanisms: ["path-scope:workspace"],
      unmet_constraints: ["network isolation unavailable"],
    }))).toThrow(/cannot claim sandbox enforcement/u);
  });

  it("is strict, versioned, unique, and size bounded for persistence", () => {
    expect(() => SandboxReportSchema.parse(report({ report_version: 2 }))).toThrow();
    expect(() => SandboxReportSchema.parse({ ...report(), backend: "seatbelt" })).toThrow();
    expect(() => SandboxReportSchema.parse(report({
      mechanisms: ["path-scope:workspace", "path-scope:workspace"],
    }))).toThrow(/must be unique/u);
    expect(() => SandboxReportSchema.parse(report({
      mechanisms: ["x".repeat(MAX_SANDBOX_REPORT_ITEM_LENGTH + 1)],
    }))).toThrow();
    expect(() => SandboxReportSchema.parse(report({
      mechanisms: Array.from(
        { length: MAX_SANDBOX_REPORT_ITEMS + 1 },
        (_, index) => `mechanism:${index}`,
      ),
    }))).toThrow();
    expect(() => SandboxReportSchema.parse(report({
      enforcement: "partial",
      mechanisms: ["path-scope:workspace"],
      unmet_constraints: ["network isolation unavailable", "network isolation unavailable"],
    }))).toThrow(/must be unique/u);
    expect(() => SandboxReportSchema.parse(report({
      enforcement: "partial",
      mechanisms: ["path-scope:workspace"],
      unmet_constraints: Array.from(
        { length: MAX_SANDBOX_REPORT_ITEMS + 1 },
        (_, index) => `constraint:${index}`,
      ),
    }))).toThrow();
  });

  it("contracts configured, enforced, and disabled audit events", () => {
    expect(SandboxConfiguredDataSchema.parse({
      mode: "workspace-write",
      platform: "darwin",
    }).mode).toBe("workspace-write");
    expect(SandboxEnforcedDataSchema.parse({ sandbox_report: report() })
      .sandbox_report.enforcement).toBe("full");
    expect(SandboxDisabledDataSchema.parse({
      reason: "explicit_danger_full_access",
      sandbox_report: report({
        mode: "danger-full-access",
        enforcement: "none",
        mechanisms: [],
        unmet_constraints: [],
      }),
    }).reason).toBe("explicit_danger_full_access");
    expect(SandboxDisabledDataSchema.parse({
      reason: "enforcement_unavailable",
      sandbox_report: report({
        enforcement: "none",
        mechanisms: [],
        unmet_constraints: ["seatbelt backend unavailable"],
      }),
    }).reason).toBe("enforcement_unavailable");

    expect(() => SandboxEnforcedDataSchema.parse({
      sandbox_report: report({
        enforcement: "none",
        mechanisms: [],
        unmet_constraints: ["seatbelt backend unavailable"],
      }),
    })).toThrow(/requires full or partial/u);
    expect(() => SandboxDisabledDataSchema.parse({
      reason: "explicit_danger_full_access",
      sandbox_report: report({
        enforcement: "none",
        mechanisms: [],
        unmet_constraints: ["seatbelt backend unavailable"],
      }),
    })).toThrow(/requires the danger-full-access mode/u);
    expect(() => SandboxConfiguredDataSchema.parse({
      mode: "read-only",
      platform: "darwin",
      injected: true,
    })).toThrow();

    for (const type of ["sandbox.configured", "sandbox.enforced", "sandbox.disabled"] as const) {
      expect(EventTypeSchema.parse(type)).toBe(type);
    }
  });

  it("keeps the persisted Run projection backward compatible", () => {
    const baseProjection = {
      schema_version: "tracegraph.session-event.v1",
      projector_version: PROJECTOR_VERSION,
      project_id: "project:sandbox",
      run_id: "run:sandbox",
      task: "Run isolated tests",
      mode: "plan",
      workspace_kind: "managed_local",
      status: "running",
      last_sequence: 0,
      timeline: [],
      artifact_refs: [],
    } as const;

    expect(RunProjectionSchema.parse(baseProjection).sandbox_report).toBeUndefined();
    expect(RunProjectionSchema.parse({
      ...baseProjection,
      sandbox_report: report({
        mode: "workspace-write",
        enforcement: "partial",
        mechanisms: ["path-scope:workspace"],
        unmet_constraints: ["network isolation unavailable"],
      }),
    }).sandbox_report?.mode).toBe("workspace-write");
  });
});
