import { describe, expect, it } from "vitest";
import { experienceActionsForStatus } from "./ExperienceControlSection";

describe("Experience control actions", () => {
  it("only renders the lifecycle actions permitted from each status", () => {
    expect(experienceActionsForStatus("candidate")).toEqual(["validate", "reject"]);
    expect(experienceActionsForStatus("validated")).toEqual(["dispute", "retire"]);
    expect(experienceActionsForStatus("disputed")).toEqual(["resolve", "retire"]);
    expect(experienceActionsForStatus("retired")).toEqual([]);
  });
});
