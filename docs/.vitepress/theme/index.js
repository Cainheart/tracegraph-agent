import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import DocMetadata from "./DocMetadata.vue";
import MermaidDiagram from "./MermaidDiagram.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "doc-before": () => h(DocMetadata) }),
  enhanceApp({ app }) { app.component("MermaidDiagram", MermaidDiagram); },
};
