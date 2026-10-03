import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import mermaid from "mermaid";

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
        return <pre className="markdown-code" key={index}><code>{highlightCode(block.value, block.language)}</code></pre>;
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

const CODE_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "delete", "do",
  "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "interface",
  "let", "new", "of", "return", "switch", "throw", "try", "type", "var", "while", "with", "yield",
  "and", "elif", "except", "False", "finally", "global", "lambda", "None", "nonlocal", "not", "or", "pass",
  "raise", "True", "with", "def", "self",
]);
const CODE_TYPES = new Set([
  "Array", "Boolean", "Date", "Error", "Map", "Object", "Promise", "Record", "Set", "String", "Type", "Unknown",
  "any", "bool", "boolean", "dict", "float", "int", "list", "number", "str", "string", "tuple", "void",
]);
const CODE_CONSTANTS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "NaN", "Infinity"]);

/**
 * A deliberately small, dependency-free code highlighter. The model output is
 * untrusted text, so this returns React nodes instead of injecting HTML. It is
 * not intended to replace a compiler; it gives the common language constructs
 * enough visual hierarchy to make generated examples readable offline.
 */
export function highlightCode(value: string, language = ""): ReactNode[] {
  const normalizedLanguage = language.toLowerCase();
  const pythonLike = normalizedLanguage === "py" || normalizedLanguage === "python";
  const tokens: ReactNode[] = [];
  let index = 0;
  let tokenIndex = 0;
  const push = (text: string, kind?: string) => {
    if (!text) return;
    tokens.push(kind === undefined
      ? <Fragment key={tokenIndex++}>{text}</Fragment>
      : <span className={`token token-${kind}`} key={tokenIndex++}>{text}</span>);
  };
  const isIdentifierStart = (character: string) => /[A-Za-z_$\u0080-\uffff]/u.test(character);
  const isIdentifierPart = (character: string) => /[A-Za-z0-9_$\u0080-\uffff]/u.test(character);
  while (index < value.length) {
    const character = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if ((!pythonLike && character === "/" && next === "/") || (character === "#" && (pythonLike || normalizedLanguage === "shell" || normalizedLanguage === "bash" || normalizedLanguage === "yaml" || normalizedLanguage === "yml"))) {
      const lineEnd = value.indexOf("\n", index);
      const end = lineEnd < 0 ? value.length : lineEnd;
      push(value.slice(index, end), "comment");
      index = end;
      continue;
    }
    if (!pythonLike && character === "/" && next === "*") {
      const endIndex = value.indexOf("*/", index + 2);
      const end = endIndex < 0 ? value.length : endIndex + 2;
      push(value.slice(index, end), "comment");
      index = end;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      let end = index + 1;
      let escaped = false;
      while (end < value.length) {
        const current = value[end] ?? "";
        if (!escaped && current === quote) {
          end += 1;
          break;
        }
        if (!escaped && current === "\\") escaped = true;
        else escaped = false;
        end += 1;
      }
      push(value.slice(index, end), "string");
      index = end;
      continue;
    }
    if (/\d/u.test(character) && (index === 0 || !isIdentifierPart(value[index - 1] ?? ""))) {
      const number = value.slice(index).match(/^(?:0[xob][\da-f]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?)/iu)?.[0];
      if (number) {
        push(number, "number");
        index += number.length;
        continue;
      }
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < value.length && isIdentifierPart(value[end] ?? "")) end += 1;
      const identifier = value.slice(index, end);
      let lookahead = end;
      while (/\s/u.test(value[lookahead] ?? "")) lookahead += 1;
      const previous = value[index - 1] ?? "";
      const kind = CODE_CONSTANTS.has(identifier)
        ? "constant"
        : CODE_KEYWORDS.has(identifier)
          ? "keyword"
          : CODE_TYPES.has(identifier) || /^[A-Z][A-Za-z0-9_$]*$/u.test(identifier)
            ? "type"
            : value[lookahead] === "(" ? "function" : previous === "." ? "property" : undefined;
      push(identifier, kind);
      index = end;
      continue;
    }
    if (/[=+\-*\/!<>?:|&%^~]/u.test(character)) {
      let end = index + 1;
      while (/[=+\-*\/!<>?:|&%^~]/u.test(value[end] ?? "")) end += 1;
      push(value.slice(index, end), "operator");
      index = end;
      continue;
    }
    push(character);
    index += 1;
  }
  return tokens;
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
  const [rendered, setRendered] = useState<{ svg?: string; error?: string; source?: string }>({});

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const render = async () => {
      const node = containerRef.current;
      if (!node) return;
      const thisGeneration = ++generation;
      setRendered({});
      try {
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
        const candidates = [...new Set([source, normalizeMermaidSource(source)].filter(Boolean))];
        let lastError = "";
        for (const [attempt, candidate] of candidates.entries()) {
          try {
            const diagramId = `tracegraph-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, "")}-${thisGeneration}-${attempt}`;
            const { svg } = await mermaid.render(diagramId, candidate);
            if (!cancelled && thisGeneration === generation) setRendered({ svg });
            return;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            // Mermaid lazy-loads several diagram bundles. A first render can
            // race that import (especially after Vite/HMR starts); give the
            // loader one short turn before trying the normalized source.
            if (attempt < candidates.length - 1) await new Promise((resolve) => window.setTimeout(resolve, 80));
          }
        }
        if (!cancelled && thisGeneration === generation) {
          setRendered({ error: lastError || "Mermaid source could not be parsed", source: normalizeMermaidSource(source) });
        }
      } catch (error) {
        if (!cancelled && thisGeneration === generation) {
          setRendered({ error: error instanceof Error ? error.message : String(error), source: normalizeMermaidSource(source) });
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
            ? <div className="mermaid-error"><strong>图表已切换为源码视图</strong><span>当前 Mermaid 语法无法解析，但完整内容仍可查看。</span></div>
            : <div className="mermaid-loading"><span /><span /><span /></div>}
      </div>
      {rendered.error && <details className="mermaid-source" open><summary>查看 Mermaid 源码</summary><pre className="markdown-code"><code>{highlightCode(rendered.source ?? source, "mermaid")}</code></pre></details>}
    </figure>
  );
}

/** Normalize common model-generated Mermaid mistakes before giving up. */
export function normalizeMermaidSource(source: string): string {
  let normalized = source.replace(/^\uFEFF/u, "").replace(/```(?:mermaid)?/giu, "").trim();
  const lines = normalized.split(/\r?\n/u);
  const firstDiagramLine = lines.findIndex((line) => /^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie)\b/iu.test(line));
  if (firstDiagramLine > 0) normalized = lines.slice(firstDiagramLine).join("\n");
  normalized = normalized.replace(/^\s*graph\s+(TD|TB|BT|RL|LR)\b/imu, "flowchart $1");
  // Mermaid reserves keywords such as `graph` and `end` as grammar tokens.
  // Models often use them as node ids (`graph[State]`), which makes the first
  // diagram fail while a later one appears to work. Rename only id-shaped
  // occurrences, leaving labels and subgraph delimiters intact.
  normalized = normalized.replace(/\b(graph|flowchart|end|classDef|style)\s*(?=[[(])/giu, "tg_$1");
  return normalized.trim();
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
