import { execFileSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "vitepress";
import { ROOT, loadSiteProjection, rewriteSiteLink, writeSiteSourceArtifacts } from "../../scripts/site-projection.mjs";

// The real Mermaid parser runs in its own controlled DOM process. It cannot alter VitePress's SSR globals.
const preflight = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "scripts/verify-site.mjs")], { cwd: ROOT, encoding: "utf8" }));
const projection = await loadSiteProjection(ROOT, { validateMermaid: false });
if (preflight.version !== projection.version || preflight.selectedPages !== projection.pages.length) throw new Error("Source changed during site preflight");
const byPath = new Map(projection.pages.map((page) => [page.path, page]));
const sidebars = [
  ["Read and run", ["index", "guide", "governance"]],
  ["Current modules", ["module"]],
  ["Generated references", ["reference"]],
  ["Proposed designs", ["design"]],
].map(([text, kinds]) => ({ text, collapsed: text === "Current modules", items: projection.pages.filter((page) => kinds.includes(page.kind)).map((page) => ({ text: page.title, link: `/${page.route}` })) }));

export default defineConfig({
  title: "Outlive Agent",
  description: "Canonical documentation · local preview",
  lang: "en",
  base: projection.base,
  srcExclude: projection.excludedPages,
  rewrites: { "README.md": "index.md" },
  cleanUrls: false,
  ignoreDeadLinks: false,
  lastUpdated: false,
  head: [["meta", { name: "robots", content: "noindex, nofollow" }],["link",{rel:"icon",type:"image/svg+xml",href:`${projection.base}brand-current.svg`}]],
  themeConfig: {
    logo: "/brand-current.svg",
    nav: [
      { text: "Documentation", link: "/index.html" },
      { text: "Install & proofs", link: "/releases/README.html" },
      { text: "Reference", link: "/generated/README.html" },
      { text: projection.version, link: "/site/README.html" },
    ],
    sidebar: sidebars,
    search: { provider: "local" },
    outline: [2, 3],
    footer: { message: "Local canonical preview. No external deployment or reviewed translations.", copyright: "Outlive Agent · versioned source projection" },
  },
  transformPageData(pageData) {
    const original = pageData.relativePath === "index.md" ? "README.md" : pageData.relativePath;
    const page = byPath.get(original);
    if (!page) throw new Error(`Attempted to publish an unselected page: ${pageData.relativePath}`);
    pageData.frontmatter.projection = {
      version: projection.version, status: page.status, locale: page.locale,
      sourcePath: page.source_path, sourceDigest: page.source_digest,
      sourceDownload: `${projection.base}${page.source_view}`,
      sourceCommit: projection.sourceCommit, dirty: projection.dirty,
    };
    pageData.frontmatter.lang = page.locale === "mul" ? "en" : page.locale;
  },
  markdown: {
    html: false,
    include: false,
    snippet: false,
    config(md) {
      const originalFence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
        const token = tokens[index];
        if (token.info.trim() !== "mermaid") {
          // Historic source-excerpt fences encode start:end:path, not a language.
          const excerpt = /^(\d+):(\d+):(.+)$/u.exec(token.info.trim());
          if (!excerpt) return originalFence(tokens, index, options, env, renderer);
          const copy = tokens.slice();
          copy[index] = Object.assign(Object.create(Object.getPrototypeOf(token)), token, { info: "text" });
          return `<p class="source-excerpt"><code>${md.utils.escapeHtml(`${excerpt[3]}:${excerpt[1]}–${excerpt[2]}`)}</code></p>\n${originalFence(copy, index, options, env, renderer)}`;
        }
        return `<MermaidDiagram encoded="${Buffer.from(token.content).toString("base64")}" />\n`;
      };
      md.core.ruler.after("inline", "canonical-site-links", (state) => {
        const source = state.env.relativePath === "index.md" ? "README.md" : state.env.relativePath;
        if (!source || !byPath.has(source)) return;
        for (const parent of state.tokens) {
          const children = parent.children ?? [];
          for (let index = 0; index < children.length; index += 1) {
            const token = children[index];
            if (token.type !== "link_open") continue;
            const href = token.attrGet("href");
            if (!href) continue;
            const link = rewriteSiteLink(projection, source, href);
            if (link.excluded) {
              token.tag = "span";
              token.attrs = [["class", "excluded-reference"], ["title", link.reason]];
              const close = children.slice(index + 1).find((candidate) => candidate.type === "link_close");
              if (close) close.tag = "span";
            } else {
              token.attrSet("href", link.href);
              if (link.repositoryOnly) token.attrSet("title", link.reason);
            }
          }
        }
      });
    },
  },
  async buildEnd(siteConfig) {
    await writeSiteSourceArtifacts(projection, siteConfig.outDir);
  },
});
