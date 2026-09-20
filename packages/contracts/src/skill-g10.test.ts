import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  SkillCatalogEntrySchema,
  SkillConflictDataSchema,
  SkillLoadFailedDataSchema,
  SkillLoadInputSchema,
  SkillProjectInspectionSchema,
  SkillRegistryLoadedDataSchema,
  SkillRegistrySnapshotSchema,
} from "./index.js";

const HASH = `sha256:${"a".repeat(64)}`;

describe("G10 Skill contracts", () => {
  it("keeps names and load input path-safe and strictly bounded", () => {
    expect(SkillLoadInputSchema.parse({ name: "review.v1" })).toEqual({ name: "review.v1" });
    expect(() => SkillLoadInputSchema.parse({ name: "../review" })).toThrow();
    expect(() => SkillLoadInputSchema.parse({ name: "Review" })).toThrow();
    expect(() => SkillLoadInputSchema.parse({ name: "review", extra: true })).toThrow();
    expect(SkillCatalogEntrySchema.parse({
      name: "review",
      description: "Review changed files",
      version: "1.0.0",
      source: "project",
    }).allowed_tools).toEqual([]);
  });

  it("records registry diagnostics, conflicts, and a metadata-only snapshot", () => {
    const conflict = SkillConflictDataSchema.parse({
      name: "review",
      winner: "project",
      loser: "user",
      winner_path: "/project/.tracegraph/skills/review/SKILL.md",
      loser_path: "/user/.tracegraph/skills/review/SKILL.md",
      reason: "project scope takes precedence",
    });
    const snapshot = SkillRegistrySnapshotSchema.parse({
      registry_digest: HASH,
      skills: [{
        name: "review",
        description: "Review changed files",
        version: "1.0.0",
        allowed_tools: ["read_file"],
        source: "project",
      }],
      conflicts: [conflict],
      diagnostics: [{
        source: "user",
        path: "/user/.tracegraph/skills/broken/SKILL.md",
        code: "invalid_frontmatter",
        message: "missing name",
      }],
    });
    expect(snapshot.skills[0]?.description).toBe("Review changed files");
    expect(SkillRegistryLoadedDataSchema.parse({
      registry_digest: HASH,
      skill_names: ["review"],
      loaded_count: 1,
      conflict_count: 1,
      diagnostic_count: 1,
    }).loaded_count).toBe(1);
    expect(SkillLoadFailedDataSchema.parse({
      ...snapshot.diagnostics[0],
      skill_name: "review",
    }).skill_name).toBe("review");
  });

  it("appends the three lifecycle event types without changing the projector version", () => {
    expect(EventTypeSchema.options).toEqual(expect.arrayContaining([
      "skill.registry_loaded",
      "skill.conflict",
      "skill.load_failed",
    ]));
  });

  it("exposes project inspection as a strict public response", () => {
    const inspection = SkillProjectInspectionSchema.parse({
      project_id: "project:one",
      label: "Project One",
      registry: {
        registry_digest: HASH,
        skills: [],
        conflicts: [],
        diagnostics: [],
      },
    });
    expect(inspection.registry.skills).toEqual([]);
    expect(() => SkillProjectInspectionSchema.parse({ ...inspection, body: "secret" })).toThrow();
  });
});
