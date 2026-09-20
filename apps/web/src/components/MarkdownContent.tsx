import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";

type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] }
  | { kind: "code"; language: string; value: string };

type TableAlignment = "left" | "center" | "right";

export function MarkdownContent({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return (
    <div className="markdown-content">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const Tag = `h${Math.min(4, Math.max(2, block.level))}` as "h2" | "h3" | "h4";
          return <Tag key={index}>{inlineMarkdown(block.text)}</Tag>;
        }
        if (block.kind === "paragraph") return <p key={index}>{inlineMarkdown(block.text)}</p>;
        if (block.kind === "blockquote") return <blockquote key={index}>{inlineMarkdown(block.text)}</blockquote>;
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</List>;
        }
        if (block.kind === "table") {
          return (
            <div className="markdown-table-wrap" key={index}>
              <table>
                <thead>
                  <tr>{block.headers.map((header, cellIndex) => <th className={`align-${block.alignments[cellIndex] ?? "left"}`} key={cellIndex}>{inlineMarkdown(header)}</th>)}</tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>{row.map((cell, cellIndex) => <td className={`align-${block.alignments[cellIndex] ?? "left"}`} key={cellIndex}>{inlineMarkdown(cell)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.language.toLowerCase() === "mermaid") return <MermaidFlow key={index} source={block.value} />;
        return <pre className="markdown-code" key={index}><code>{block.value}</code></pre>;
      })}
    </div>
  );
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: { language: string; lines: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const fenceMatch = line.match(/^```\s*([\w-]*)\s*$/u);
    if (fence) {
      if (fenceMatch) {
        blocks.push({ kind: "code", language: fence.language, value: fence.lines.join("\n") });
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    if (fenceMatch) {
      flushParagraph(); flushList();
      fence = { language: fenceMatch[1] ?? "", lines: [] };
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      flushParagraph(); flushList();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 2, text: heading[2] ?? "" });
      continue;
    }
    const tableHeaders = splitTableRow(line);
    const tableAlignments = parseTableDelimiter(lines[lineIndex + 1] ?? "");
    if (tableHeaders && tableAlignments && tableHeaders.length === tableAlignments.length) {
      flushParagraph(); flushList();
      const rows: string[][] = [];
      lineIndex += 2;
      while (lineIndex < lines.length) {
        const cells = splitTableRow(lines[lineIndex] ?? "");
        if (!cells) break;
        rows.push(normalizeTableRow(cells, tableHeaders.length));
        lineIndex += 1;
      }
      lineIndex -= 1;
      blocks.push({ kind: "table", headers: tableHeaders, alignments: tableAlignments, rows });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/u);
    if (quote) {
      flushParagraph(); flushList();
      const quoteLines = [quote[1] ?? ""];
      while (lineIndex + 1 < lines.length) {
        const nextQuote = (lines[lineIndex + 1] ?? "").match(/^\s*>\s?(.*)$/u);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1] ?? "");
        lineIndex += 1;
      }
      blocks.push({ kind: "blockquote", text: quoteLines.join(" ").trim() });
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/u);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/u);
    if (unordered || ordered) {
      flushParagraph();
      const nextOrdered = Boolean(ordered);
      if (list && list.ordered !== nextOrdered) flushList();
      list ??= { ordered: nextOrdered, items: [] };
      list.items.push((ordered?.[1] ?? unordered?.[1] ?? "").trim());
      continue;
    }
    if (line.trim() === "") {
      flushParagraph(); flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (fence) blocks.push({ kind: "code", language: fence.language, value: fence.lines.join("\n") });
  flushParagraph(); flushList();
  return blocks;
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  let start = trimmed.startsWith("|") ? 1 : 0;
  const end = trimmed.endsWith("|") && !trimmed.endsWith("\\|") ? trimmed.length - 1 : trimmed.length;
  while (start < end) {
    const character = trimmed[start] ?? "";
    const next = trimmed[start + 1] ?? "";
    if (character === "\\" && next === "|") {
      cell += "|";
      start += 2;
      continue;
    }
    if (character === "`") inCode = !inCode;
    if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    start += 1;
  }
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

function parseTableDelimiter(line: string): TableAlignment[] | null {
  const cells = splitTableRow(line);
  if (!cells || !cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function normalizeTableRow(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function inlineMarkdown(value: string): ReactNode[] {
  return value.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/gu).filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/u);
    if (link) {
      const label = link[1] ?? "";
      const href = safeLinkTarget(link[2] ?? "");
      if (href) return <a href={href} key={index} rel="noreferrer noopener" target="_blank">{label}</a>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function safeLinkTarget(value: string): string | null {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function MermaidFlow({ source }: { source: string }) {
  const reactId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<{ svg?: string; error?: string }>({});

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const render = async () => {
      const node = containerRef.current;
      if (!node) return;
      const thisGeneration = ++generation;
      setRendered({});
      try {
        const { default: mermaid } = await import("mermaid");
        const theme = mermaidTheme(node);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          look: "classic",
          suppressErrorRendering: true,
          fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          themeVariables: theme,
          flowchart: {
            curve: "basis",
            htmlLabels: false,
            nodeSpacing: 52,
            rankSpacing: 58,
            padding: 16,
            useMaxWidth: true,
          },
        });
        const diagramId = `tracegraph-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, "")}-${thisGeneration}`;
        const { svg } = await mermaid.render(diagramId, source);
        if (!cancelled && thisGeneration === generation) setRendered({ svg });
      } catch (error) {
        if (!cancelled && thisGeneration === generation) {
          setRendered({ error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    const rerender = () => void render();
    void render();
    window.addEventListener("tracegraph:themechange", rerender);
    return () => {
      cancelled = true;
      window.removeEventListener("tracegraph:themechange", rerender);
    };
  }, [reactId, source]);

  return (
    <figure className="mermaid-diagram" aria-label="Mermaid diagram">
      <div className="mermaid-canvas" ref={containerRef}>
        {rendered.svg
          ? <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: rendered.svg }} />
          : rendered.error
            ? <div className="mermaid-error"><strong>Diagram could not be rendered</strong><span>{rendered.error}</span></div>
            : <div className="mermaid-loading"><span /><span /><span /></div>}
      </div>
      {rendered.error && <details className="mermaid-source"><summary>Show Mermaid source</summary><pre className="markdown-code"><code>{source}</code></pre></details>}
    </figure>
  );
}

function mermaidTheme(node: HTMLElement) {
  const scope = node.closest(".app") ?? node;
  const styles = window.getComputedStyle(scope);
  const value = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const dark = scope.classList.contains("theme-dark");
  return {
    darkMode: dark,
    background: "transparent",
    primaryColor: value("--panel-raised", dark ? "#12161b" : "#f8f9fb"),
    primaryTextColor: value("--text", dark ? "#e9ebee" : "#171a20"),
    primaryBorderColor: value("--accent", "#5266e9"),
    lineColor: value("--accent", "#5266e9"),
    secondaryColor: value("--accent-bg", dark ? "#1a2030" : "#eef0ff"),
    secondaryTextColor: value("--text-soft", dark ? "#a8b0bb" : "#4f5865"),
    secondaryBorderColor: value("--line-strong", dark ? "#303844" : "#cbd1da"),
    tertiaryColor: value("--panel", dark ? "#0d1014" : "#ffffff"),
    tertiaryTextColor: value("--text-soft", dark ? "#a8b0bb" : "#4f5865"),
    tertiaryBorderColor: value("--line", dark ? "#222831" : "#dfe3e9"),
    clusterBkg: value("--panel", dark ? "#0d1014" : "#ffffff"),
    clusterBorder: value("--line-strong", dark ? "#303844" : "#cbd1da"),
    edgeLabelBackground: value("--panel", dark ? "#0d1014" : "#ffffff"),
    fontSize: "14px",
  };
}
