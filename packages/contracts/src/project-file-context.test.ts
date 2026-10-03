import { describe, expect, it } from "vitest";
import { StartChatRequestSchema, StartRunRequestSchema } from "./commands.js";
import { ProjectFileContextRefsSchema, ProjectFileContextSnapshotsSchema } from "./project-file-context.js";

const hash = `sha256:${"a".repeat(64)}`;
const request = { command_id: "context:command", project_id: "project:context", task: "Explain this file", mode: "plan" };
describe("versioned project context authority", () => {
  it("accepts references on project runs, refusing client content, duplicates, traversal and unbounded selection", () => {
    expect(StartRunRequestSchema.parse({ ...request, file_contexts: [{ path: "src/main.ts", expected_sha256: hash }] }).file_contexts).toHaveLength(1);
    for (const file_contexts of [
      [{ path: "../outside.ts", expected_sha256: hash }],
      [{ path: "src/main.ts", expected_sha256: hash, content: "client supplied code" }],
      [{ path: "src/main.ts", expected_sha256: hash }, { path: "src/main.ts", expected_sha256: hash }],
      Array.from({ length: 6 }, (_, i) => ({ path: `file${i}.ts`, expected_sha256: hash })),
    ]) expect(() => StartRunRequestSchema.parse({ ...request, file_contexts })).toThrow();
    expect(() => ProjectFileContextRefsSchema.parse([{ path: "src/main.ts", expected_sha256: "not-a-hash" }])).toThrow();
  });
  it("plain chat cannot select project files even with an empty selection", () => {
    expect(() => StartChatRequestSchema.parse({ command_id: request.command_id, task: request.task, file_contexts: [] })).toThrow();
  });
  it("bounds actual UTF-8 bytes and total trusted snapshots separately from references", () => {
    const snapshot = { project_id: request.project_id, path: "src/main.ts", sha256: hash, content: "中文", byte_length: 6 };
    expect(ProjectFileContextSnapshotsSchema.parse([snapshot])[0]?.byte_length).toBe(6);
    expect(() => ProjectFileContextSnapshotsSchema.parse([{ ...snapshot, byte_length: 2 }])).toThrow();
    expect(() => ProjectFileContextSnapshotsSchema.parse([{ ...snapshot, content: "中".repeat(30_000), byte_length: 90_000 }])).toThrow();
    expect(() => ProjectFileContextSnapshotsSchema.parse(Array.from({ length: 3 }, (_, i) => ({ ...snapshot, path: `file${i}.ts`, content: "a".repeat(65536), byte_length: 65536 })))).toThrow();
  });
});
