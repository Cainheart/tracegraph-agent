import { sha256 } from "./hash.js";
import { RetrievalError } from "./errors.js";
import type { ChunkMarkdownInput, RetrievalChunk } from "./types.js";
import {
  chunkIdentity,
  DEFAULT_MAX_CHUNK_CHARS,
  MAX_CHUNK_CONTENT_CHARS,
  validateContent,
  validateMaxChunkChars,
  validateProjectId,
  validateSourcePath,
} from "./validation.js";

interface LogicalLine {
  readonly text: string;
  readonly start: number;
  readonly contentEnd: number;
}

interface MarkdownBlock {
  readonly start: number;
  readonly end: number;
  readonly startsSection: boolean;
  readonly headingPath: readonly string[];
}

/**
 * Split Markdown at heading and paragraph boundaries. A fenced code block is
 * always one indivisible block, even when it exceeds the soft size target.
 * Returned content is an exact substring of the input (including CRLF within
 * a chunk) and line coordinates are one-based and inclusive.
 */
export function chunkMarkdown(input: ChunkMarkdownInput): readonly RetrievalChunk[] {
  const projectId = validateProjectId(input.project_id);
  const sourcePath = validateSourcePath(input.source_path);
  const content = validateContent(input.content);
  const maxChunkChars = validateMaxChunkChars(input.max_chunk_chars ?? DEFAULT_MAX_CHUNK_CHARS);
  const documentHash = sha256(content);
  const lines = splitLogicalLines(content);
  const blocks = markdownBlocks(lines);
  if (blocks.length === 0) return Object.freeze([]);

  const grouped: Array<{ start: number; end: number; headingPath: readonly string[] }> = [];
  let current: { start: number; end: number; headingPath: readonly string[] } | undefined;
  for (const block of blocks) {
    if (current !== undefined) {
      const prospectiveChars = lines[block.end]!.contentEnd - lines[current.start]!.start;
      if (block.startsSection || prospectiveChars > maxChunkChars) {
        grouped.push(current);
        current = undefined;
      }
    }
    if (current === undefined) {
      current = { start: block.start, end: block.end, headingPath: block.headingPath };
    } else {
      current.end = block.end;
    }
  }
  if (current !== undefined) grouped.push(current);

  return Object.freeze(grouped.map((group) => {
    const startLine = group.start + 1;
    const endLine = group.end + 1;
    const chunkContent = content.slice(lines[group.start]!.start, lines[group.end]!.contentEnd);
    if (chunkContent.length > MAX_CHUNK_CONTENT_CHARS) {
      // Paragraphs and code fences are indivisible; reject a source block that
      // cannot fit the public retrieval contract instead of silently slicing it.
      throw new RetrievalError(
        "invalid_content",
        "an indivisible Markdown block exceeds the retrieval chunk limit",
      );
    }
    const contentHash = sha256(chunkContent);
    return Object.freeze({
      chunk_id: chunkIdentity({
        project_id: projectId,
        source_path: sourcePath,
        start_line: startLine,
        end_line: endLine,
        content_hash: contentHash,
      }),
      project_id: projectId,
      source_path: sourcePath,
      document_hash: documentHash,
      content_hash: contentHash,
      start_line: startLine,
      end_line: endLine,
      heading_path: Object.freeze([...group.headingPath]),
      content: chunkContent,
    } satisfies RetrievalChunk);
  }));
}

function markdownBlocks(lines: readonly LogicalLine[]): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const headings: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index]!.text)) {
      index += 1;
      continue;
    }

    const heading = parseHeading(lines[index]!.text);
    if (heading !== undefined) {
      headings.length = heading.depth - 1;
      headings[heading.depth - 1] = heading.text;
      blocks.push({
        start: index,
        end: index,
        startsSection: true,
        headingPath: Object.freeze([...headings].filter((item): item is string => item !== undefined)),
      });
      index += 1;
      continue;
    }

    const fence = openingFence(lines[index]!.text);
    if (fence !== undefined) {
      const start = index;
      index += 1;
      while (index < lines.length) {
        if (isClosingFence(lines[index]!.text, fence)) {
          index += 1;
          break;
        }
        index += 1;
      }
      blocks.push({
        start,
        end: index - 1,
        // Keep the opening fence as a hard chunk boundary. The closing side
        // remains soft so a short following explanation may share the chunk.
        startsSection: true,
        headingPath: Object.freeze([...headings]),
      });
      continue;
    }

    const start = index;
    index += 1;
    while (
      index < lines.length
      && !isBlank(lines[index]!.text)
      && parseHeading(lines[index]!.text) === undefined
      && openingFence(lines[index]!.text) === undefined
    ) {
      index += 1;
    }
    blocks.push({
      start,
      end: index - 1,
      startsSection: false,
      headingPath: Object.freeze([...headings]),
    });
  }
  return blocks;
}

function splitLogicalLines(content: string): readonly LogicalLine[] {
  const lines: LogicalLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const rawEnd = newline === -1 ? content.length : newline;
    const contentEnd = rawEnd > start && content[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({ text: content.slice(start, contentEnd), start, contentEnd });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

function isBlank(line: string): boolean {
  return /^\s*$/u.test(line);
}

function parseHeading(line: string): { readonly depth: number; readonly text: string } | undefined {
  const match = /^\s{0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
  if (match === null) return undefined;
  const text = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/u, "").trim();
  return { depth: match[1]!.length, text: text.length === 0 ? "#" : text };
}

interface Fence {
  readonly marker: "`" | "~";
  readonly width: number;
}

function openingFence(line: string): Fence | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
  if (match === null) return undefined;
  const sequence = match[1]!;
  return { marker: sequence[0] as "`" | "~", width: sequence.length };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const trimmed = line.replace(/^\s{0,3}/u, "");
  let width = 0;
  while (trimmed[width] === fence.marker) width += 1;
  return width >= fence.width && /^\s*$/u.test(trimmed.slice(width));
}
