import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightCode, MarkdownContent, normalizeMermaidSource } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders headings, lists, inline code, and paragraphs instead of raw markers", () => {
    const html = renderToStaticMarkup(<MarkdownContent content={"## Harness 是什么\n\n- 负责编排\n- 负责校验 `ToolCall`\n\n**结论**：它是控制层。"} />);
    expect(html).toContain("<h2>Harness 是什么</h2>");
    expect(html).toContain("<ul><li>负责编排</li><li>负责校验 <code>ToolCall</code></li></ul>");
    expect(html).toContain("<strong>结论</strong>");
    expect(html).not.toContain("## Harness");
  });

  it("hands Mermaid flowcharts to the full client-side renderer", () => {
    const html = renderToStaticMarkup(<MarkdownContent content={"```mermaid\nflowchart LR\nA[模型] --> B[Harness]\nB[Harness] --> C[工具]\n```"} />);
    expect(html).toContain("mermaid-diagram");
    expect(html).toContain("mermaid-loading");
    expect(html).not.toContain("mermaid-edge");
  });

  it("accepts branching and subgraph syntax instead of reducing it to key-value rows", () => {
    const html = renderToStaticMarkup(<MarkdownContent content={"```mermaid\nflowchart TD\nsubgraph Agent\nA[计划] --> B{需要工具?}\nend\nB -->|是| C[读取文件]\nB -->|否| D[回答]\n```"} />);
    expect(html).toContain("mermaid-diagram");
    expect(html).not.toContain("mermaid-source");
  });

  it("renders GFM-style tables with alignment instead of flattening them into a paragraph", () => {
    const html = renderToStaticMarkup(<MarkdownContent content={"| 组件 | 职责 | 状态 |\n| :--- | :--- | ---: |\n| **Model** | 生成 `Decision` | ready |\n| Harness | 校验与执行 | 3 |"} />);
    expect(html).toContain('<div class="markdown-table-wrap"><table>');
    expect(html).toContain('<th class="align-left">组件</th>');
    expect(html).toContain('<th class="align-right">状态</th>');
    expect(html).toContain("<strong>Model</strong>");
    expect(html).toContain("生成 <code>Decision</code>");
    expect(html).not.toContain("| :---");
  });

  it("renders blockquotes and safe links while leaving unsafe links inert", () => {
    const html = renderToStaticMarkup(<MarkdownContent content={"> 这是公开执行摘要。\n> 不包含模型私有思维链。\n\n[文档](https://example.com/docs) [危险链接](javascript:alert(1))"} />);
    expect(html).toContain("<blockquote>这是公开执行摘要。 不包含模型私有思维链。</blockquote>");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("[危险链接](javascript:alert(1))");
  });

  it("adds safe editor-style token classes to generated code", () => {
    const html = renderToStaticMarkup(<MarkdownContent content={"```python\ndef greet(name: str) -> str:\n    # comment\n    return f'Hello {name}'\n```"} />);
    expect(html).toContain('class="token token-keyword"');
    expect(html).toContain('class="token token-function"');
    expect(html).toContain('class="token token-comment"');
    expect(html).toContain('class="token token-string"');
  });

  it("normalizes common reserved Mermaid ids before the retry", () => {
    expect(normalizeMermaidSource("Here is the chart:\n\ngraph TD\ngraph[State] --> end[Done]")).toBe("flowchart TD\ntg_graph[State] --> tg_end[Done]");
    expect(highlightCode("const value = 1", "ts").length).toBeGreaterThan(1);
  });
});
