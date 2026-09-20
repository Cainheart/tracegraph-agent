import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_MODE, resolveSandboxMode } from "./sandbox-config.js";

describe("sandbox mode configuration", () => {
  it("uses workspace-write as the secure operational default", () => {
    expect(DEFAULT_SANDBOX_MODE).toBe("workspace-write");
    expect(resolveSandboxMode(undefined, {})).toBe("workspace-write");
  });

  it("lets the local CLI flag override the Host environment", () => {
    expect(resolveSandboxMode("read-only", {
      TRACEGRAPH_SANDBOX_MODE: "danger-full-access",
    })).toBe("read-only");
  });

  it("accepts an explicit danger-full-access setting from the local Host only", () => {
    expect(resolveSandboxMode(undefined, {
      TRACEGRAPH_SANDBOX_MODE: "danger-full-access",
    })).toBe("danger-full-access");
  });

  it("rejects misspelled or silently widened modes", () => {
    expect(() => resolveSandboxMode("off", {})).toThrow(/Invalid sandbox mode/u);
    expect(() => resolveSandboxMode(undefined, { TRACEGRAPH_SANDBOX_MODE: "full-access" })).toThrow(/Invalid sandbox mode/u);
  });
});
