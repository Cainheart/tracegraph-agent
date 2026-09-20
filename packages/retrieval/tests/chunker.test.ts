import { describe, expect, it } from "vitest";

import { chunkMarkdown, RetrievalError } from "../src/index.js";

describe("chunkMarkdown", () => {
  it("uses heading and paragraph boundaries while preserving exact source lines", () => {
    const source = [
      "# Guide",
      "",
      "An opening paragraph.",
      "",
      "```ts",
      "# this is code, not a heading",
      "",
      "const answer = 42;",
      "```",
      "",
      "## Next",
      "Second section.",
    ].join("\r\n");

    const chunks = chunkMarkdown({
      project_id: "project:docs",
      source_path: "docs/guide.md",
      content: source,
      max_chunk_chars: 64,
    });

    expect(chunks.map(({ start_line, end_line }) => [start_line, end_line])).toEqual([
      [1, 3],
      [5, 9],
      [11, 12],
    ]);
    expect(chunks[1]).toMatchObject({
      source_path: "docs/guide.md",
      start_line: 5,
      end_line: 9,
      heading_path: ["Guide"],
      content: "```ts\r\n# this is code, not a heading\r\n\r\nconst answer = 42;\r\n```",
    });
    expect(chunks[2]?.heading_path).toEqual(["Guide", "Next"]);
    for (const chunk of chunks) {
      expect(source.includes(chunk.content)).toBe(true);
      expect(chunk.chunk_id).toMatch(/^chunk:[a-f0-9]{64}$/u);
      expect(chunk.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
  });

  it("never splits closed or unclosed fences and treats the size as a soft target", () => {
    const oversizedFence = ["~~~python", "x = '" + "x".repeat(200) + "'", "~~~"].join("\n");
    const closed = chunkMarkdown({
      project_id: "project:fence",
      source_path: "fence.md",
      content: oversizedFence,
      max_chunk_chars: 64,
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.content).toBe(oversizedFence);
    expect(closed[0]?.start_line).toBe(1);
    expect(closed[0]?.end_line).toBe(3);

    const unclosed = "# A\n\n```js\n# still code\nvalue();";
    const unclosedChunks = chunkMarkdown({
      project_id: "project:fence",
      source_path: "unclosed.md",
      content: unclosed,
      max_chunk_chars: 64,
    });
    expect(unclosedChunks.at(-1)).toMatchObject({
      start_line: 3,
      end_line: 5,
      content: "```js\n# still code\nvalue();",
    });
  });

  it("keeps an oversized paragraph intact and indexes empty Markdown as no chunks", () => {
    const paragraph = "word ".repeat(50).trim();
    const chunks = chunkMarkdown({
      project_id: "project:paragraph",
      source_path: "paragraph.md",
      content: paragraph,
      max_chunk_chars: 64,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(paragraph);
    expect(chunkMarkdown({
      project_id: "project:empty",
      source_path: "empty.md",
      content: " \n\n\t",
    })).toEqual([]);
  });

  it("rejects an indivisible block beyond the public hit limit instead of slicing it", () => {
    expect(() => chunkMarkdown({
      project_id: "project:bounded-block",
      source_path: "large-fence.md",
      content: `\`\`\`text\n${"x".repeat(64_001)}\n\`\`\``,
      max_chunk_chars: 64_000,
    })).toThrowError(expect.objectContaining({ code: "invalid_content" }));
  });

  it.each([
    [{ project_id: "", source_path: "a.md", content: "text" }, "invalid_project_id"],
    [{ project_id: "project:a", source_path: "../a.md", content: "text" }, "invalid_source_path"],
    [{ project_id: "project:a", source_path: "/a.md", content: "text" }, "invalid_source_path"],
    [{ project_id: "project:a", source_path: "a\\b.md", content: "text" }, "invalid_source_path"],
    [{ project_id: "project:a", source_path: "a.md", content: "text", max_chunk_chars: 1 }, "invalid_content"],
  ])("rejects malformed chunk input %#", (input, code) => {
    expect(() => chunkMarkdown(input)).toThrowError(expect.objectContaining({ code }));
  });

  it("does not expose rejected source text in validation failures", () => {
    const secret = "secret-that-must-not-leak";
    let thrown: unknown;
    try {
      chunkMarkdown({ project_id: "project:a", source_path: `../${secret}`, content: "ok" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RetrievalError);
    expect(String(thrown)).not.toContain(secret);
  });
});
