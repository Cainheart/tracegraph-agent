// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("Markdown Mermaid rendering", () => {
  it("renders the architecture chart when a reserved word is also an edge node", async () => {
    const source = `flowchart LR
  subgraph clients[接入端]
    web[Web 工作台<br/>React/Vite]
    desktop[Electron Desktop]
    cli[CLI 与装配]
    sdk[SDK 类型客户端]
  end
  subgraph hostproc[本机 Host 进程]
    host[Host 边界<br/>Fastify 命令/查询/工件/SSE]
    runtime[Agent Runtime]
    policy[策略与审批]
    ctx[Context 与预算压缩]
  end
  subgraph evidence[证据与知识面]
    ledger[Event Ledger + Artifact Store]
    memory[Memory BM25 检索]
    graph[CodeGraph]
    ext[MCP / LSP 客户端]
  end
  providers[模型 Provider<br/>OpenAI/DeepSeek/GLM/Qwen/MiniMax/Claude]
  web --> host
  desktop --> host
  cli --> host
  sdk --> host
  host --> runtime
  runtime --> policy --> tools[工具执行]
  runtime --> ctx
  runtime --> ledger
  runtime --> memory
  runtime --> graph
  runtime --> ext
  runtime --> providers`;
    const host = document.createElement("div");
    const root = createRoot(host);
    const svgPrototype = window.SVGElement.prototype;
    const previousGetBBox = Object.getOwnPropertyDescriptor(svgPrototype, "getBBox");
    const previousTextLength = Object.getOwnPropertyDescriptor(svgPrototype, "getComputedTextLength");

    // JSDOM has no SVG layout engine; Mermaid needs these measurements while
    // laying out labels. The browser supplies real metrics in production.
    Object.defineProperty(svgPrototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 100, height: 24 }) });
    Object.defineProperty(svgPrototype, "getComputedTextLength", { configurable: true, value: () => 100 });
    try {
      await act(async () => root.render(<MarkdownContent content={`\`\`\`mermaid\n${source}\n\`\`\``} />));
      for (let attempt = 0; attempt < 60 && !host.querySelector(".mermaid-svg svg") && !host.querySelector(".mermaid-error"); attempt += 1) {
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
      }
      expect(host.querySelector(".mermaid-svg svg")).not.toBeNull();
      expect(host.querySelector(".mermaid-error")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      if (previousGetBBox) Object.defineProperty(svgPrototype, "getBBox", previousGetBBox);
      else delete (svgPrototype as SVGElement & { getBBox?: unknown }).getBBox;
      if (previousTextLength) Object.defineProperty(svgPrototype, "getComputedTextLength", previousTextLength);
      else delete (svgPrototype as SVGElement & { getComputedTextLength?: unknown }).getComputedTextLength;
    }
  });
});
